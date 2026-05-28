// Diagnostic event → OTEL span mapping.
//
// Extracted from service.ts so the full event-to-span flow can be
// unit-tested against an in-memory OTEL exporter without spinning up
// the real OTLP exporter or subscribing to the diagnostic event bus.
// service.ts handles the lifecycle wiring (OTLP exporter, provider,
// subscription, heartbeat, logging); this module owns the pure data
// path: given a Tracer and the diagnostic event, emit the right spans
// with the right attributes.

import {
  context as otelContext,
  trace,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import {
  buildCommonAttrs,
  buildContextAssembledAttrs,
  buildModelCallCloseAttrs,
  buildModelCallIoAttrs,
  buildModelCallStartedAttrs,
  buildModelUsageAttrs,
  buildRunAttrs,
  buildRunIoAttrs,
  buildToolExecutionCloseAttrs,
  buildToolExecutionIoAttrs,
  buildToolExecutionStartedAttrs,
  type CommonAttrOptions,
  type DiagnosticEvent,
} from "./attrs.js";
import type { IoBuffer } from "./io-buffer.js";

export type DiagnosticEventHandlerDeps = {
  tracer: Tracer;
  attrOpts: CommonAttrOptions;
  ioBuffer: IoBuffer;
};

export type DiagnosticEventHandler = {
  handle: (event: DiagnosticEvent) => void;
  openRuns: Map<string, Span>;
  openModelCalls: Map<string, Span>;
  openTools: Map<string, { span: Span; toolName: string }>;
};

/**
 * Factory for the diagnostic-event handler used by service.ts.
 *
 * The returned `handle` function reads from the supplied IoBuffer (for
 * I/O attrs and model.usage parenting) and writes spans to the supplied
 * Tracer. Open-span maps are kept on the returned object so service.ts
 * can iterate them on shutdown to .end() in-flight spans, and so tests
 * can introspect span state without round-tripping through the
 * exporter.
 */
export function createDiagnosticEventHandler(
  deps: DiagnosticEventHandlerDeps,
): DiagnosticEventHandler {
  const { tracer, attrOpts, ioBuffer } = deps;
  const openRuns = new Map<string, Span>();
  const openModelCalls = new Map<string, Span>();
  const openTools = new Map<string, { span: Span; toolName: string }>();

  function parentCtxFromRunId(runId: string | undefined) {
    const span = runId ? openRuns.get(runId) : undefined;
    return span
      ? trace.setSpan(otelContext.active(), span)
      : otelContext.active();
  }

  function applyAttrs(span: Span, attrs: Record<string, unknown>) {
    for (const [k, v] of Object.entries(attrs)) {
      span.setAttribute(k, v as never);
    }
  }

  function handle(event: DiagnosticEvent) {
    const common = buildCommonAttrs(event, attrOpts);
    switch (event.type) {
      case "run.started":
      case "harness.run.started": {
        const runId = (event["runId"] ?? event["id"]) as string | undefined;
        if (!runId || openRuns.has(runId)) return;
        const span = tracer.startSpan("openclaw.run", {
          attributes: buildRunAttrs(event, common),
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
        // Peek (non-consuming) — per-call slots remain available
        // for model.call spans that may still close after the run.
        applyAttrs(span, buildRunIoAttrs(ioBuffer.peekRunIo(runId)));
        if (event.type === "harness.run.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (event["error"] as string) ?? "run error",
          });
        }
        span.end();
        openRuns.delete(runId);
        ioBuffer.clearRun(runId);
        return;
      }
      case "model.usage": {
        // model.usage carries no runId/callId; we parent it to the
        // most-recently-opened model.call span for the same session,
        // tracked in the IoBuffer. If no open call is registered
        // (usage arrived after the call closed, or session ids are
        // unavailable), fall back to an orphan span that groups
        // visually in Braintrust via session_id_hash.
        const sessionKey = event["sessionKey"] as string | undefined;
        const sessionId = event["sessionId"] as string | undefined;
        const parent = ioBuffer.getOpenModelCallSpanForSession(
          sessionKey,
          sessionId,
        ) as Span | undefined;
        const parentCtx = parent
          ? trace.setSpan(otelContext.active(), parent)
          : otelContext.active();
        const { attrs, conditional } = buildModelUsageAttrs(event, common);
        const span = tracer.startSpan(
          "openclaw.model.usage",
          { attributes: attrs },
          parentCtx,
        );
        applyAttrs(span, conditional);
        span.end();
        return;
      }
      case "context.assembled": {
        const runId = event["runId"] as string | undefined;
        const span = tracer.startSpan(
          "openclaw.context.assembled",
          { attributes: buildContextAssembledAttrs(event, common) },
          parentCtxFromRunId(runId),
        );
        span.end();
        return;
      }
      case "model.call.started": {
        const callId = event["callId"] as string | undefined;
        if (!callId || openModelCalls.has(callId)) return;
        const runId = event["runId"] as string | undefined;
        const span = tracer.startSpan(
          "openclaw.model.call",
          { attributes: buildModelCallStartedAttrs(event, common) },
          parentCtxFromRunId(runId),
        );
        openModelCalls.set(callId, span);
        ioBuffer.setOpenModelCallSpanForSession(
          event["sessionKey"] as string | undefined,
          event["sessionId"] as string | undefined,
          span,
        );
        return;
      }
      case "model.call.completed":
      case "model.call.error": {
        const callId = event["callId"] as string | undefined;
        if (!callId) return;
        const span = openModelCalls.get(callId);
        if (!span) return;
        applyAttrs(span, buildModelCallCloseAttrs(event));
        // Pop the matching call slot from the IoBuffer and merge
        // its input_json/output_json/tools into the span. Returns
        // empty when content capture was off or the call hit a
        // gated hook path (raw-run, prompt-error).
        const runId = event["runId"] as string | undefined;
        if (runId) {
          applyAttrs(span, buildModelCallIoAttrs(ioBuffer.takeCallIo(runId)));
        }
        if (event.type === "model.call.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (event["errorCategory"] as string) ?? "model.call.error",
          });
        }
        span.end();
        openModelCalls.delete(callId);
        ioBuffer.clearOpenModelCallSpanForSession(
          event["sessionKey"] as string | undefined,
          event["sessionId"] as string | undefined,
          span,
        );
        return;
      }
      case "tool.execution.started": {
        const toolName = (event["toolName"] as string) ?? "unknown";
        const key =
          (event["toolCallId"] as string | undefined) ??
          `${event["runId"] ?? ""}:${toolName}:${event["ts"] ?? Date.now()}`;
        if (openTools.has(key)) return;
        const runId = event["runId"] as string | undefined;
        const span = tracer.startSpan(
          "openclaw.tool.execution",
          { attributes: buildToolExecutionStartedAttrs(common, toolName) },
          parentCtxFromRunId(runId),
        );
        openTools.set(key, { span, toolName });
        return;
      }
      case "tool.execution.completed":
      case "tool.execution.error":
      case "tool.execution.blocked": {
        const key =
          (event["toolCallId"] as string | undefined) ??
          [...openTools.keys()].find((k) =>
            k.startsWith(`${event["runId"] ?? ""}:`),
          );
        if (!key) return;
        const entry = openTools.get(key);
        if (!entry) return;
        const { span } = entry;
        applyAttrs(span, buildToolExecutionCloseAttrs(event));
        // Merge tool args/result captured via AgentToolResult
        // middleware. Keyed by (runId, toolCallId); pulls and
        // consumes from the IoBuffer.
        const runId = event["runId"] as string | undefined;
        const toolCallId = event["toolCallId"] as string | undefined;
        if (runId && toolCallId) {
          applyAttrs(
            span,
            buildToolExecutionIoAttrs(ioBuffer.takeToolIo(runId, toolCallId)),
          );
        }
        if (event.type === "tool.execution.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message:
              (event["errorCategory"] as string) ?? "tool.execution.error",
          });
        } else if (event.type === "tool.execution.blocked") {
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

  return { handle, openRuns, openModelCalls, openTools };
}
