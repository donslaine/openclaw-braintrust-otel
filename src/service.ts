// Thin slice (stage 1): emit `openclaw.run` and `openclaw.model.usage` spans
// to Braintrust. Tool spans, model.call spans, and ACP handling come later.
//
// See ../../../docs/braintrust-otel-plugin.md for the full design.

import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createHash } from "node:crypto";

// Types are intentionally loose for the spike — the real shapes live in
// @openclaw/infra (DiagnosticEventPayload) and src/plugins/types.ts
// (OpenClawPluginService). Wire those in once we move from spike to real run.
type DiagnosticEvent = { type: string; [k: string]: unknown };
type ServiceCtx = {
  internalDiagnostics?: {
    onEvent: (
      listener: (event: DiagnosticEvent, meta: { trusted: boolean }) => void,
    ) => () => void;
  };
  config?: BraintrustOtelConfig;
};

export interface BraintrustOtelConfig {
  endpoint?: string;
  tracesEndpoint?: string;
  serviceName?: string;
  tags?: string[];
  captureContent?: {
    input?: boolean;
    output?: boolean;
    toolInputs?: boolean;
    toolOutputs?: boolean;
    systemPrompt?: boolean;
  };
  sessionIdentifiers?: {
    raw?: boolean;
    hash?: boolean;
    hashSaltSecretRef?: string;
  };
}

const DEFAULT_ENDPOINT = "https://api.braintrust.dev/otel";
const DEFAULT_CAPTURE = {
  input: false,
  output: true,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
} as const;

export function createBraintrustOtelService() {
  let provider: BasicTracerProvider | undefined;
  let unsubscribe: (() => void) | undefined;
  // run id -> open root span
  const openRuns = new Map<string, Span>();

  return {
    id: "braintrust-otel",

    async start(ctx: ServiceCtx) {
      const apiKey = process.env.BRAINTRUST_API_KEY;
      const parent = process.env.BRAINTRUST_PARENT;
      if (!apiKey || !parent) {
        // Fail loud but don't crash the host.
        console.warn(
          "[braintrust-otel] BRAINTRUST_API_KEY and BRAINTRUST_PARENT are required; exporter disabled.",
        );
        return;
      }

      const cfg = ctx.config ?? {};
      const endpoint = cfg.endpoint ?? DEFAULT_ENDPOINT;
      const tracesEndpoint = cfg.tracesEndpoint ?? `${endpoint}/v1/traces`;
      const serviceName = cfg.serviceName ?? "openclaw";
      const capture = { ...DEFAULT_CAPTURE, ...(cfg.captureContent ?? {}) };
      const sessIds = {
        raw: false,
        hash: true,
        ...(cfg.sessionIdentifiers ?? {}),
      };
      const salt = sessIds.hashSaltSecretRef
        ? process.env[sessIds.hashSaltSecretRef] ?? ""
        : process.env.BRAINTRUST_SESSION_HASH_SALT ?? "";

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
      provider.register();
      const tracer = trace.getTracer("braintrust-otel");

      const hashId = (v: unknown): string | undefined => {
        if (typeof v !== "string" || !v) return undefined;
        return createHash("sha256")
          .update(salt)
          .update(v)
          .digest("hex")
          .slice(0, 16);
      };

      const sessionAttrs = (e: DiagnosticEvent) => {
        const out: Record<string, string> = {};
        const sessionKey = e["sessionKey"] as string | undefined;
        const sessionId = e["sessionId"] as string | undefined;
        const runId = e["runId"] as string | undefined;
        if (sessIds.hash) {
          const skh = hashId(sessionKey);
          const sih = hashId(sessionId);
          const rih = hashId(runId);
          if (skh) out["braintrust.metadata.openclaw.session_key_hash"] = skh;
          if (sih) out["braintrust.metadata.openclaw.session_id_hash"] = sih;
          if (rih) out["braintrust.metadata.openclaw.run_id_hash"] = rih;
        }
        if (sessIds.raw) {
          if (sessionKey)
            out["braintrust.metadata.openclaw.session_key"] = sessionKey;
          if (sessionId)
            out["braintrust.metadata.openclaw.session_id"] = sessionId;
          if (runId) out["braintrust.metadata.openclaw.run_id"] = runId;
        }
        return out;
      };

      unsubscribe = ctx.internalDiagnostics?.onEvent((event, meta) => {
        if (!meta.trusted) return;
        try {
          handle(event);
        } catch (err) {
          console.warn("[braintrust-otel] handler error", err);
        }
      });

      function handle(event: DiagnosticEvent) {
        switch (event.type) {
          case "run.started":
          case "harness.run.started": {
            const runId = (event["runId"] ?? event["id"]) as string | undefined;
            if (!runId || openRuns.has(runId)) return;
            const span = tracer.startSpan("openclaw.run", {
              attributes: {
                "braintrust.tags": JSON.stringify(cfg.tags ?? []),
                "braintrust.metadata.service_name": serviceName,
                "braintrust.metadata.openclaw.agent":
                  (event["agent"] as string) ?? "",
                "braintrust.metadata.openclaw.channel":
                  (event["channel"] as string) ?? "",
                "braintrust.metadata.openclaw.provider":
                  (event["provider"] as string) ?? "",
                "braintrust.metadata.openclaw.model":
                  (event["model"] as string) ?? "",
                "braintrust.metadata.openclaw.trigger":
                  (event["trigger"] as string) ?? "",
                "braintrust.metadata.openclaw.session_kind":
                  (event["sessionKind"] as string) ?? "",
                ...sessionAttrs(event),
              },
            });
            openRuns.set(runId, span);
            return;
          }
          case "run.completed":
          case "harness.run.completed":
          case "harness.run.error": {
            const runId = (event["runId"] ?? event["id"]) as string | undefined;
            if (!runId) return;
            const span = openRuns.get(runId);
            if (!span) return;
            if (event.type === "harness.run.error") {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (event["error"] as string) ?? "run error",
              });
            }
            span.end();
            openRuns.delete(runId);
            return;
          }
          case "model.usage": {
            const runId = event["runId"] as string | undefined;
            const parentSpan = runId ? openRuns.get(runId) : undefined;
            const tokens = (event["tokens"] ?? {}) as Record<string, number>;
            const ctx = parentSpan
              ? trace.setSpan(
                  // @ts-expect-error: minimal API surface for spike
                  globalThis.opentelemetryActiveContext ?? undefined,
                  parentSpan,
                )
              : undefined;
            const span = tracer.startSpan(
              "openclaw.model.usage",
              {
                attributes: {
                  "braintrust.span_attributes.type": "llm",
                  "braintrust.metrics.cost":
                    (event["costUsd"] as number) ?? 0,
                  "braintrust.metadata.openclaw.provider":
                    (event["provider"] as string) ?? "",
                  "braintrust.metadata.openclaw.model":
                    (event["model"] as string) ?? "",
                  "braintrust.metadata.openclaw.tokens.input":
                    tokens.input ?? 0,
                  "braintrust.metadata.openclaw.tokens.output":
                    tokens.output ?? 0,
                  "braintrust.metadata.openclaw.tokens.cache":
                    tokens.cache ?? 0,
                  "braintrust.metadata.openclaw.tokens.total":
                    tokens.total ?? 0,
                  ...sessionAttrs(event),
                },
              },
              ctx,
            );
            if (capture.input && event["input"] !== undefined) {
              span.setAttribute(
                "braintrust.input",
                safeStringify(event["input"]),
              );
            }
            if (capture.output && event["output"] !== undefined) {
              span.setAttribute(
                "braintrust.output",
                safeStringify(event["output"]),
              );
            }
            span.end();
            return;
          }
          // tool.execution.* and model.call.* — stage 2
          default:
            return;
        }
      }
    },

    async stop() {
      try {
        unsubscribe?.();
      } catch {}
      for (const span of openRuns.values()) {
        try {
          span.end();
        } catch {}
      }
      openRuns.clear();
      await provider?.shutdown();
      provider = undefined;
    },
  };
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
