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

/**
 * Subset of the `model_call_started` typed-hook payload we read. See
 * openclaw `src/plugins/hook-types.ts:238-255`.
 */
export type ModelCallStartedHookPayload = {
  runId?: string;
  callId: string;
  sessionKey?: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  api?: string;
  transport?: string;
  contextTokenBudget?: number;
};

/**
 * Subset of the `model_call_ended` typed-hook payload we read. See
 * openclaw `src/plugins/hook-types.ts:257-266`.
 */
export type ModelCallEndedHookPayload = ModelCallStartedHookPayload & {
  outcome?: "completed" | "error" | string;
  durationMs?: number;
  errorCategory?: string;
  failureKind?: string;
  requestPayloadBytes?: number;
  responseStreamBytes?: number;
  timeToFirstByteMs?: number;
  upstreamRequestIdHash?: string;
};

export type DiagnosticEventHandlerDeps = {
  tracer: Tracer;
  attrOpts: CommonAttrOptions;
  ioBuffer: IoBuffer;
};

export type DiagnosticEventHandler = {
  /** Bus-event entrypoint. Routed by service.ts from onInternalDiagnosticEvent. */
  handle: (event: DiagnosticEvent) => void;
  /**
   * Typed-hook entrypoint. Build the `openclaw.model.call` span at the
   * start of a per-call hook event. Source of truth for model.call
   * spans in v0.3.0+; the bus `model.call.*` events are ignored.
   */
  onModelCallStarted: (
    payload: ModelCallStartedHookPayload,
    ctx?: unknown,
  ) => void;
  /** Typed-hook entrypoint. Closes the `openclaw.model.call` span. */
  onModelCallEnded: (payload: ModelCallEndedHookPayload, ctx?: unknown) => void;
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
        // Register the run as the model.usage backstop for this session.
        // Used when a usage event arrives with no matching model.call
        // (call never opened, or TTL elapsed); the span at least parents
        // to the run instead of going fully orphan.
        ioBuffer.setOpenRunSpanForSession(
          event["sessionKey"] as string | undefined,
          event["sessionId"] as string | undefined,
          span,
        );
        return;
      }
      case "run.completed":
      case "harness.run.completed":
      case "harness.run.error": {
        const runId = (event["runId"] ?? event["id"]) as string | undefined;
        if (!runId) return;
        const span = openRuns.get(runId);
        if (!span) return;
        applyAttrs(span, buildRunIoAttrs(ioBuffer.peekRunIo(runId)));
        if (event.type === "harness.run.error") {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: (event["error"] as string) ?? "run error",
          });
        }
        span.end();
        openRuns.delete(runId);
        ioBuffer.clearOpenRunSpanForSession(
          event["sessionKey"] as string | undefined,
          event["sessionId"] as string | undefined,
          span,
        );
        ioBuffer.clearRun(runId);
        return;
      }
      case "model.usage": {
        // model.usage carries no runId/callId (upstream limitation).
        // Parent resolution, in order:
        //   1. Most-recently-opened (or recently-closed-within-TTL)
        //      model.call span for the same session.
        //   2. Backstop: open openclaw.run span for the same session.
        //   3. Fully orphan (groups visually via session_id_hash).
        // Step 2 was added in v0.3.0 — without it, every usage event
        // whose call had already closed went fully orphan because
        // `model_call_ended` clears the call registry synchronously
        // while `model.usage` arrives asynchronously through the bus.
        const sessionKey = event["sessionKey"] as string | undefined;
        const sessionId = event["sessionId"] as string | undefined;
        const parent = (ioBuffer.getOpenModelCallSpanForSession(
          sessionKey,
          sessionId,
        ) ?? ioBuffer.getOpenRunSpanForSession(sessionKey, sessionId)) as
          | Span
          | undefined;
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
      // Bus `model.call.*` events are intentionally ignored in v0.3.0+.
      // Model.call spans are built from the per-call typed hooks
      // `model_call_started` / `model_call_ended`, which carry a stable
      // `callId` and fire 1:1 with actual model calls (the bus events
      // do too, but they don't pair with the turn-level `llm_input` /
      // `llm_output` hooks, so attaching content via bus events
      // produced N:1 pairing errors in v0.2.x).
      case "model.call.started":
      case "model.call.completed":
      case "model.call.error":
        return;
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

  /**
   * Coerce a hook payload into the `DiagnosticEvent`-shaped object the
   * attribute builders consume. The builders read fields by name with
   * `event["field"]`, so the shape is structural — we just need the
   * field names lined up. `type` is set to keep the close-attrs branch
   * symmetric with the legacy bus path for tests that exercise both.
   */
  function payloadAsEvent(
    payload: Record<string, unknown>,
    type: string,
  ): DiagnosticEvent {
    return { type, ...payload };
  }

  function onModelCallStarted(
    payload: ModelCallStartedHookPayload,
    ctx?: unknown,
  ): void {
    void ctx;
    const callId = payload.callId;
    if (!callId || openModelCalls.has(callId)) return;
    const event = payloadAsEvent(
      payload as unknown as Record<string, unknown>,
      "model.call.started",
    );
    const common = buildCommonAttrs(event, attrOpts);
    const runId = payload.runId;
    const span = tracer.startSpan(
      "openclaw.model.call",
      { attributes: buildModelCallStartedAttrs(event, common) },
      parentCtxFromRunId(runId),
    );
    openModelCalls.set(callId, span);
    ioBuffer.setOpenModelCallSpanForSession(
      payload.sessionKey,
      payload.sessionId,
      span,
    );
  }

  function onModelCallEnded(
    payload: ModelCallEndedHookPayload,
    ctx?: unknown,
  ): void {
    void ctx;
    const callId = payload.callId;
    if (!callId) return;
    const span = openModelCalls.get(callId);
    if (!span) return;
    const isError = payload.outcome === "error";
    const event = payloadAsEvent(
      payload as unknown as Record<string, unknown>,
      isError ? "model.call.error" : "model.call.completed",
    );
    applyAttrs(span, buildModelCallCloseAttrs(event));
    if (isError) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: payload.errorCategory ?? "model.call.error",
      });
    }
    span.end();
    openModelCalls.delete(callId);
    ioBuffer.clearOpenModelCallSpanForSession(
      payload.sessionKey,
      payload.sessionId,
      span,
    );
  }

  return {
    handle,
    onModelCallStarted,
    onModelCallEnded,
    openRuns,
    openModelCalls,
    openTools,
  };
}
