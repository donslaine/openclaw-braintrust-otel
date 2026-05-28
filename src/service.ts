// Emits openclaw.run, openclaw.model.usage, openclaw.model.call,
// openclaw.tool.execution, and openclaw.context.assembled spans to
// Braintrust.
//
// Pure attribute-mapping lives in ./attrs.ts and is unit-tested there.
// This file owns the stateful concerns: span lifecycle, parenting via
// open-span maps, OTEL provider setup, subscription, and shutdown.
//
// Subscription strategy: prefer ctx.internalDiagnostics?.onEvent when
// the host grants it (currently only "diagnostics-otel" and
// "diagnostics-prometheus" are allowlisted per upstream
// src/plugins/services.ts). Fall back to importing
// onInternalDiagnosticEvent from the plugin SDK directly — that export
// is public and unguarded, so the fallback works on stock openclaw.
// Upstream issue tracking the inconsistency: see README.

import { createRequire } from "node:module";
import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
// Fallback subscription when the host doesn't grant ctx.internalDiagnostics.
import { onInternalDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  type CommonAttrOptions,
  type DiagnosticEvent,
  type VersioningOptions,
} from "./attrs.js";
import {
  createDiagnosticEventHandler,
  type DiagnosticEventHandler,
} from "./event-handler.js";
import { IoBuffer } from "./io-buffer.js";

// Resolved at module load. Best-effort: if openclaw isn't on the
// resolution path (test sandbox, unusual install layout), the
// openclaw_version metadata is omitted rather than blocking startup.
const OPENCLAW_VERSION: string | undefined = (() => {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("openclaw/package.json") as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
})();

type ServiceCtx = {
  internalDiagnostics?: {
    onEvent: (
      listener: (event: DiagnosticEvent, meta: { trusted: boolean }) => void,
    ) => () => void;
  };
  // ctx.config is the whole OpenClawConfig; our config lives at
  // ctx.config.plugins.entries["braintrust-otel"].config.
  config?: unknown;
};

export interface BraintrustOtelConfig {
  endpoint?: string;
  tracesEndpoint?: string;
  serviceName?: string;
  tags?: string[];
  sessionIdentifiers?: {
    raw?: boolean;
    hash?: boolean;
    hashSaltSecretRef?: string;
  };
  // Content capture is OFF by default. When enabled, the plugin exports
  // raw user prompts, assistant outputs, tool args, and tool results to
  // the configured Braintrust endpoint. Safe ONLY on internal/admin-only
  // Braintrust instances. Client-facing gateways must not enable this
  // without a per-deployment privacy review.
  captureContent?: {
    enabled?: boolean;
  };
  // Versioning labels travel on every span as top-level
  // `braintrust.metadata.*` so dataset examples promoted from real
  // traces carry them automatically. `openclaw_version` is read
  // automatically from the resolved openclaw package; the four below
  // are operator-supplied.
  versioning?: {
    agentPromptVersion?: string;
    toolPolicyVersion?: string;
    runbookVersion?: string;
    environment?: string;
  };
}

const DEFAULT_ENDPOINT = "https://api.braintrust.dev/otel";

export type BraintrustOtelServiceOptions = {
  /**
   * Shared in-memory buffer for LLM input/output and tool middleware
   * payloads, plus the session-keyed open-model.call registry used to
   * parent model.usage events. Created in the plugin entry so the buffer
   * outlives service start/stop cycles and is reachable from hooks
   * registered alongside the service.
   *
   * The service calls `ioBuffer.setEnabled(...)` at start() to apply
   * the resolved `captureContent.enabled` config.
   */
  ioBuffer: IoBuffer;
  /**
   * Mutable handle exposed to the plugin entry so its typed-hook
   * subscribers (`model_call_started` / `model_call_ended`) can
   * dispatch into the event handler once start() has built it. start()
   * sets `routerRef.current`; stop() clears it. Optional for tests
   * that drive the handler directly.
   */
  routerRef?: { current: DiagnosticEventHandler | undefined };
};

export function createBraintrustOtelService(
  opts: BraintrustOtelServiceOptions,
) {
  const { ioBuffer, routerRef } = opts;
  let provider: BasicTracerProvider | undefined;
  let unsubscribe: (() => void) | undefined;
  // Populated in start() once the tracer is built; kept in outer scope
  // so stop() can iterate them to end any in-flight spans on shutdown.
  let handlerRef: ReturnType<typeof createDiagnosticEventHandler> | undefined;

  return {
    id: "braintrust-otel",

    async start(ctx: ServiceCtx) {
      const apiKey = process.env.BRAINTRUST_API_KEY;
      const parent = process.env.BRAINTRUST_PARENT;
      if (!apiKey || !parent) {
        console.warn(
          "[braintrust-otel] BRAINTRUST_API_KEY and BRAINTRUST_PARENT are required; exporter disabled.",
        );
        return;
      }

      const pluginEntry = (
        ctx.config as
          | {
              plugins?: {
                entries?: Record<string, { config?: BraintrustOtelConfig }>;
              };
            }
          | undefined
      )?.plugins?.entries?.["braintrust-otel"];
      const cfg: BraintrustOtelConfig = pluginEntry?.config ?? {};
      const endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;
      const tracesEndpoint = cfg.tracesEndpoint ?? `${endpoint}/v1/traces`;
      const serviceName = cfg.serviceName ?? "openclaw";
      const sessIds = {
        raw: false,
        hash: true,
        ...(cfg.sessionIdentifiers ?? {}),
      };
      const salt = sessIds.hashSaltSecretRef
        ? (process.env[sessIds.hashSaltSecretRef] ?? "")
        : (process.env.BRAINTRUST_SESSION_HASH_SALT ?? "");

      const versioning: VersioningOptions = {
        openclawVersion: OPENCLAW_VERSION,
        agentPromptVersion: cfg.versioning?.agentPromptVersion,
        toolPolicyVersion: cfg.versioning?.toolPolicyVersion,
        runbookVersion: cfg.versioning?.runbookVersion,
        environment: cfg.versioning?.environment,
      };
      const attrOpts: CommonAttrOptions = {
        tags: cfg.tags ?? [],
        serviceName,
        sessIds: { raw: sessIds.raw, hash: sessIds.hash },
        salt,
        versioning,
      };

      // Flip the IoBuffer's enabled gate to the configured
      // captureContent.enabled value. Hooks registered at plugin init
      // (before start runs) read this through ioBuffer's record* paths,
      // so this is what actually turns content capture on or off.
      const captureContentEnabled = cfg.captureContent?.enabled === true;
      ioBuffer.setEnabled(captureContentEnabled);

      const exporter = new OTLPTraceExporter({
        url: tracesEndpoint,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "x-bt-parent": parent,
        },
      });

      provider = new BasicTracerProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: serviceName,
        }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      trace.setGlobalTracerProvider(provider);
      const tracer = trace.getTracer("braintrust-otel");

      // All event → span mapping lives in event-handler.ts so it can
      // be tested against an in-memory exporter. The listener below
      // just gates on the trusted flag, counts, and dispatches.
      handlerRef = createDiagnosticEventHandler({ tracer, attrOpts, ioBuffer });
      const handler = handlerRef;
      if (routerRef) routerRef.current = handler;

      let eventCount = 0;
      const eventCountByType = new Map<string, number>();
      const listener = (event: DiagnosticEvent, meta: { trusted: boolean }) => {
        if (!meta.trusted) return;
        eventCount++;
        const t = event.type ?? "(no-type)";
        eventCountByType.set(t, (eventCountByType.get(t) ?? 0) + 1);
        try {
          handler.handle(event);
        } catch (err) {
          console.warn("[braintrust-otel] handler error", err);
        }
      };

      // Prefer the host-granted subscription if the trust gate allows it
      // (currently only diagnostics-otel and diagnostics-prometheus are
      // allowlisted upstream). Fall back to the public SDK export, which
      // works on stock openclaw regardless of the gate.
      const subscriptionSource: "ctx" | "sdk" = ctx.internalDiagnostics
        ? "ctx"
        : "sdk";
      unsubscribe = ctx.internalDiagnostics
        ? ctx.internalDiagnostics.onEvent(listener)
        : onInternalDiagnosticEvent(listener);

      // Versioning fields the operator actually set — drop unset keys
      // from the startup log so it's clear what's live.
      const versioningSet: Record<string, string> = {};
      if (versioning.openclawVersion)
        versioningSet.openclawVersion = versioning.openclawVersion;
      if (versioning.agentPromptVersion)
        versioningSet.agentPromptVersion = versioning.agentPromptVersion;
      if (versioning.toolPolicyVersion)
        versioningSet.toolPolicyVersion = versioning.toolPolicyVersion;
      if (versioning.runbookVersion)
        versioningSet.runbookVersion = versioning.runbookVersion;
      if (versioning.environment)
        versioningSet.environment = versioning.environment;

      console.log(
        JSON.stringify({
          tag: "braintrust-otel",
          msg: "exporter started",
          tracesEndpoint,
          serviceName,
          tags: cfg.tags ?? [],
          sessionIdentifiers: sessIds,
          subscribed: typeof unsubscribe === "function",
          subscriptionSource,
          captureContent: { enabled: captureContentEnabled },
          versioning: versioningSet,
        }),
      );

      // Loud warning when content capture is enabled — operators must
      // see this so accidental enablement on a client-facing gateway is
      // hard to miss. Pairs with the "admin-only Braintrust" framing in
      // the README and the M1 Runbook.
      if (captureContentEnabled) {
        console.warn(
          "[braintrust-otel] captureContent.enabled = true. The plugin is exporting raw LLM prompts, assistant outputs, and tool I/O to Braintrust. Only safe on internal/admin-only Braintrust instances. Verify per-deployment privacy posture before leaving this on.",
        );
      }

      const heartbeat = setInterval(() => {
        const byType: Record<string, number> = {};
        for (const [k, v] of eventCountByType) byType[k] = v;
        console.log(
          JSON.stringify({
            tag: "braintrust-otel",
            msg: "heartbeat",
            eventCount,
            byType,
            openRuns: handler.openRuns.size,
            openModelCalls: handler.openModelCalls.size,
            openTools: handler.openTools.size,
            ioBuffer: ioBuffer.stats(),
          }),
        );
      }, 60_000);
      heartbeat.unref?.();
      const origUnsubscribe = unsubscribe;
      unsubscribe = () => {
        clearInterval(heartbeat);
        origUnsubscribe?.();
      };
    },

    async stop() {
      try {
        unsubscribe?.();
      } catch {}
      if (handlerRef) {
        for (const span of handlerRef.openRuns.values()) {
          try {
            span.end();
          } catch {}
        }
        handlerRef.openRuns.clear();
        for (const span of handlerRef.openModelCalls.values()) {
          try {
            span.end();
          } catch {}
        }
        handlerRef.openModelCalls.clear();
        for (const { span } of handlerRef.openTools.values()) {
          try {
            span.end();
          } catch {}
        }
        handlerRef.openTools.clear();
        handlerRef = undefined;
      }
      if (routerRef) routerRef.current = undefined;
      await provider?.shutdown();
      provider = undefined;
    },
  };
}
