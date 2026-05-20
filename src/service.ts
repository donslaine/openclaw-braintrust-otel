// Stage 2: emit openclaw.run, openclaw.model.usage, openclaw.model.call,
// and openclaw.tool.execution spans to Braintrust.
//
// ACP-specific spans are NOT emitted: current OpenClaw diagnostic events
// carry no runtime/ACP marker fields. ACP sessions show up as ordinary
// runs. See docs/braintrust-otel-plugin.md "ACP gap" section.

import {
  context as otelContext,
  trace,
  SpanStatusCode,
  type Span,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { createHash } from "node:crypto";

// Loose local types. The real shapes live in @openclaw/infra
// (DiagnosticEventPayload) and src/plugins/types.ts (OpenClawPluginService);
// wire them in once we publish this plugin as a workspace member.
//
// Field names mirror the upstream payloads (extracted from
// src/infra/diagnostic-events.ts) so we can switch to the real types
// without a renaming pass.
type DiagnosticEvent = { type: string; [k: string]: unknown };
type ServiceCtx = {
  internalDiagnostics?: {
    onEvent: (
      listener: (event: DiagnosticEvent, meta: { trusted: boolean }) => void,
    ) => () => void;
  };
  // ctx.config is actually the whole OpenClawConfig upstream; for the
  // thin slice we treat the relevant subset as BraintrustOtelConfig.
  // Real wiring will read from ctx.config.plugins?.["braintrust-otel"].
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
  // callId -> open model.call span
  const openModelCalls = new Map<string, Span>();
  // toolCallId (or synthesized key) -> open tool.execution span
  const openTools = new Map<string, { span: Span; toolName: string }>();

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
                // Braintrust accepts string arrays directly (per docs).
                "braintrust.tags": cfg.tags ?? [],
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
            // Nest under the run span using the real OTEL context API
            // (W3C trace context). Braintrust uses standard parent linkage.
            const parentCtx = parentSpan
              ? trace.setSpan(otelContext.active(), parentSpan)
              : otelContext.active();
            const span = tracer.startSpan(
              "openclaw.model.usage",
              {
                attributes: {
                  "braintrust.span_attributes.type": "llm",
                  // Braintrust-auto-mapped token metrics.
                  // Source -> braintrust mapping:
                  //   tokens.input  -> prompt_tokens
                  //   tokens.output -> completion_tokens
                  //   tokens.total  -> tokens (total)
                  //   tokens.cache  -> prompt_cached_tokens
                  "braintrust.metrics.prompt_tokens": tokens.input ?? 0,
                  "braintrust.metrics.completion_tokens": tokens.output ?? 0,
                  "braintrust.metrics.tokens": tokens.total ?? 0,
                  "braintrust.metrics.prompt_cached_tokens": tokens.cache ?? 0,
                  // TODO: braintrust.metrics.cost is NOT in the documented
                  // schema, but the spike confirmed it works empirically.
                  // Verify once we see real spans land; otherwise move to
                  // braintrust.metadata.cost_usd.
                  "braintrust.metrics.cost":
                    (event["costUsd"] as number) ?? 0,
                  "braintrust.metadata.openclaw.provider":
                    (event["provider"] as string) ?? "",
                  "braintrust.metadata.openclaw.model":
                    (event["model"] as string) ?? "",
                  ...sessionAttrs(event),
                },
              },
              parentCtx,
            );
            // For non-string content (e.g. OpenAI-style message arrays),
            // Braintrust expects the *_json variants with a JSON-stringified
            // payload. Plain strings can use the bare braintrust.input/output.
            if (capture.input && event["input"] !== undefined) {
              setBraintrustContent(span, "input", event["input"]);
            }
            if (capture.output && event["output"] !== undefined) {
              setBraintrustContent(span, "output", event["output"]);
            }
            span.end();
            return;
          }
          case "model.call.started": {
            const callId = event["callId"] as string | undefined;
            if (!callId || openModelCalls.has(callId)) return;
            const runId = event["runId"] as string | undefined;
            const parent = runId ? openRuns.get(runId) : undefined;
            const parentCtx = parent
              ? trace.setSpan(otelContext.active(), parent)
              : otelContext.active();
            const span = tracer.startSpan(
              "openclaw.model.call",
              {
                attributes: {
                  "braintrust.metadata.openclaw.provider":
                    (event["provider"] as string) ?? "",
                  "braintrust.metadata.openclaw.model":
                    (event["model"] as string) ?? "",
                  "braintrust.metadata.openclaw.api":
                    (event["api"] as string) ?? "",
                  "braintrust.metadata.openclaw.transport":
                    (event["transport"] as string) ?? "",
                  "braintrust.metadata.openclaw.context_token_budget":
                    (event["contextTokenBudget"] as number) ?? 0,
                  "braintrust.metadata.openclaw.upstream_request_id_hash":
                    (event["upstreamRequestIdHash"] as string) ?? "",
                  ...sessionAttrs(event),
                },
              },
              parentCtx,
            );
            openModelCalls.set(callId, span);
            return;
          }
          case "model.call.completed":
          case "model.call.error": {
            const callId = event["callId"] as string | undefined;
            if (!callId) return;
            const span = openModelCalls.get(callId);
            if (!span) return;
            span.setAttribute(
              "braintrust.metadata.openclaw.duration_ms",
              (event["durationMs"] as number) ?? 0,
            );
            if (event["requestPayloadBytes"] !== undefined)
              span.setAttribute(
                "braintrust.metadata.openclaw.request_bytes",
                event["requestPayloadBytes"] as number,
              );
            if (event["responseStreamBytes"] !== undefined)
              span.setAttribute(
                "braintrust.metadata.openclaw.response_bytes",
                event["responseStreamBytes"] as number,
              );
            if (event["timeToFirstByteMs"] !== undefined)
              span.setAttribute(
                "braintrust.metadata.openclaw.ttfb_ms",
                event["timeToFirstByteMs"] as number,
              );
            if (event.type === "model.call.error") {
              span.setAttribute(
                "braintrust.metadata.openclaw.error_category",
                (event["errorCategory"] as string) ?? "",
              );
              if (event["failureKind"] !== undefined)
                span.setAttribute(
                  "braintrust.metadata.openclaw.failure_kind",
                  event["failureKind"] as string,
                );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                  (event["errorCategory"] as string) ?? "model.call.error",
              });
            }
            span.end();
            openModelCalls.delete(callId);
            return;
          }
          case "tool.execution.started": {
            // toolCallId is the natural join key; synthesize one if missing
            // so completed/error/blocked still find the open span.
            const toolName = (event["toolName"] as string) ?? "unknown";
            const key =
              (event["toolCallId"] as string | undefined) ??
              `${event["runId"] ?? ""}:${toolName}:${event["ts"] ?? Date.now()}`;
            if (openTools.has(key)) return;
            const runId = event["runId"] as string | undefined;
            const parent = runId ? openRuns.get(runId) : undefined;
            const parentCtx = parent
              ? trace.setSpan(otelContext.active(), parent)
              : otelContext.active();
            const attrs: Record<string, string | number> = {
              "braintrust.span_attributes.type": "tool",
              "braintrust.metadata.openclaw.tool_name": toolName,
              ...sessionAttrs(event),
            };
            const span = tracer.startSpan(
              `openclaw.tool.execution`,
              { attributes: attrs },
              parentCtx,
            );
            span.setAttribute("braintrust.metadata.openclaw.tool_name", toolName);
            // Optional tool input capture (off by default).
            if (capture.toolInputs && event["paramsSummary"] !== undefined) {
              setBraintrustContent(span, "input", event["paramsSummary"]);
            }
            openTools.set(key, { span, toolName });
            return;
          }
          case "tool.execution.completed":
          case "tool.execution.error":
          case "tool.execution.blocked": {
            const key =
              (event["toolCallId"] as string | undefined) ??
              // Fall back to a best-effort match (last open tool on this run).
              [...openTools.keys()].find((k) =>
                k.startsWith(`${event["runId"] ?? ""}:`),
              );
            if (!key) return;
            const entry = openTools.get(key);
            if (!entry) return;
            const { span } = entry;
            if (event["durationMs"] !== undefined)
              span.setAttribute(
                "braintrust.metadata.openclaw.duration_ms",
                event["durationMs"] as number,
              );
            if (event.type === "tool.execution.error") {
              span.setAttribute(
                "braintrust.metadata.openclaw.error_category",
                (event["errorCategory"] as string) ?? "",
              );
              if (event["errorCode"] !== undefined)
                span.setAttribute(
                  "braintrust.metadata.openclaw.error_code",
                  event["errorCode"] as string,
                );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                  (event["errorCategory"] as string) ?? "tool.execution.error",
              });
            } else if (event.type === "tool.execution.blocked") {
              span.setAttribute(
                "braintrust.metadata.openclaw.blocked_reason",
                (event["reason"] as string) ??
                  (event["deniedReason"] as string) ??
                  "blocked",
              );
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: "tool.execution.blocked",
              });
            }
            span.end();
            openTools.delete(key);
            return;
          }
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
        try { span.end(); } catch {}
      }
      openRuns.clear();
      for (const span of openModelCalls.values()) {
        try { span.end(); } catch {}
      }
      openModelCalls.clear();
      for (const { span } of openTools.values()) {
        try { span.end(); } catch {}
      }
      openTools.clear();
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

// Per Braintrust docs: braintrust.input / braintrust.output take a string;
// for arrays/objects (e.g. OpenAI message arrays) use the *_json variants
// with a JSON-stringified payload.
function setBraintrustContent(
  span: Span,
  kind: "input" | "output",
  value: unknown,
): void {
  if (typeof value === "string") {
    span.setAttribute(`braintrust.${kind}`, value);
  } else {
    span.setAttribute(`braintrust.${kind}_json`, safeStringify(value));
  }
}
