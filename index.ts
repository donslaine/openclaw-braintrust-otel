import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  DiagnosticEventHandler,
  ModelCallEndedHookPayload,
  ModelCallStartedHookPayload,
} from "./src/event-handler.js";
import {
  IoBuffer,
  type LlmInputPayload,
  type LlmOutputPayload,
  type ToolAfterPayload,
  type ToolBeforePayload,
} from "./src/io-buffer.js";
import { createBraintrustOtelService } from "./src/service.js";

// One buffer per process. Hooks fire before the service starts (plugin
// init), and may keep firing across hot-reloads of the service, so the
// buffer must outlive the service factory's lifecycle. Constructed
// disabled — service.start() flips the gate based on the resolved
// `captureContent.enabled` config (default OFF — privacy).
const ioBuffer = new IoBuffer({ enabled: false });

/**
 * Resolve `runId` from a typed-hook event + ctx pair. Per the openclaw
 * hook contract (`src/plugins/hook-types.ts`), `runId` lives on the
 * payload, not the ctx. v0.2.1 / v0.3.0 read `ctx.runId` only for the
 * tool hooks — always undefined — and silently dropped every tool I/O
 * payload at the IoBuffer's `if (!runId) return` guard. Exported so
 * regression tests can assert the precedence.
 */
export function resolveHookRunId(
  event: unknown,
  ctx: unknown,
): string | undefined {
  const fromEvent = (event as { runId?: string } | undefined)?.runId;
  if (fromEvent) return fromEvent;
  return (ctx as { runId?: string } | undefined)?.runId;
}

// Mutable handle to the DiagnosticEventHandler. service.start() sets
// it once the tracer is built; service.stop() clears it. Typed-hook
// subscribers below dispatch model_call_started/ended through this
// reference. Pre-start hook events (between register() and start())
// are dropped silently — those are bootstrap-time and we don't yet
// have a tracer to build spans against.
export type RouterRef = { current: DiagnosticEventHandler | undefined };
const routerRef: RouterRef = { current: undefined };

export default definePluginEntry({
  id: "braintrust-otel",
  name: "Braintrust OTEL Exporter",
  description:
    "Subscribes to OpenClaw internal diagnostics and emits Braintrust-shaped OTEL spans.",
  register(api) {
    api.registerService(createBraintrustOtelService({ ioBuffer, routerRef }));

    // Public typed plugin hooks. Payload shapes are declared as
    // `unknown` here and narrowed at the dispatch site.
    //
    // llm_input + llm_output require `hooks.allowConversationAccess:
    // true` in the operator's plugin config — they're treated by the
    // runtime as conversation-content hooks. before_tool_call,
    // after_tool_call, model_call_started, and model_call_ended have
    // no permission requirement.
    api.on("llm_input", (event: unknown, ctx: unknown) => {
      void ctx;
      try {
        // Run-level capture only. See IoBuffer.recordLlmInput for why
        // per-call attribution is unsafe (turn-level hook vs per-call
        // model spans — v0.2.x N:1 bug).
        ioBuffer.recordLlmInput(event as LlmInputPayload);
      } catch (err) {
        console.warn("[braintrust-otel] llm_input handler error", err);
      }
    });
    api.on("llm_output", (event: unknown, ctx: unknown) => {
      void ctx;
      try {
        ioBuffer.recordLlmOutput(event as LlmOutputPayload);
      } catch (err) {
        console.warn("[braintrust-otel] llm_output handler error", err);
      }
    });
    api.on("model_call_started", (event: unknown, ctx: unknown) => {
      try {
        routerRef.current?.onModelCallStarted(
          event as ModelCallStartedHookPayload,
          ctx,
        );
      } catch (err) {
        console.warn("[braintrust-otel] model_call_started handler error", err);
      }
    });
    api.on("model_call_ended", (event: unknown, ctx: unknown) => {
      try {
        routerRef.current?.onModelCallEnded(
          event as ModelCallEndedHookPayload,
          ctx,
        );
      } catch (err) {
        console.warn("[braintrust-otel] model_call_ended handler error", err);
      }
    });
    api.on("before_tool_call", (event: unknown, ctx: unknown) => {
      try {
        const payload = event as ToolBeforePayload & {
          parameters?: unknown;
          runId?: string;
        };
        const runId = resolveHookRunId(event, ctx);
        ioBuffer.recordToolBefore(
          {
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            // openclaw uses `parameters` on the before-hook; we
            // accept either spelling.
            args: payload.args ?? payload.parameters,
            threadId: payload.threadId,
            turnId: payload.turnId,
          },
          runId,
        );
      } catch (err) {
        console.warn("[braintrust-otel] before_tool_call handler error", err);
      }
    });
    api.on("after_tool_call", (event: unknown, ctx: unknown) => {
      try {
        const payload = event as ToolAfterPayload & {
          error?: unknown;
          runId?: string;
        };
        const runId = resolveHookRunId(event, ctx);
        ioBuffer.recordToolAfter(
          {
            toolCallId: payload.toolCallId,
            toolName: payload.toolName,
            result: payload.result,
            // openclaw may surface failure as either `isError` or
            // the presence of `error`; normalize to a boolean.
            isError:
              payload.isError ??
              (payload.error !== undefined && payload.error !== null
                ? true
                : undefined),
            durationMs: payload.durationMs,
          },
          runId,
        );
      } catch (err) {
        console.warn("[braintrust-otel] after_tool_call handler error", err);
      }
    });
  },
});
