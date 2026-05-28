import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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

export default definePluginEntry({
  id: "braintrust-otel",
  name: "Braintrust OTEL Exporter",
  description:
    "Subscribes to OpenClaw internal diagnostics and emits Braintrust-shaped OTEL spans.",
  register(api) {
    api.registerService(createBraintrustOtelService({ ioBuffer }));

    // Public typed plugin hooks. Payload shapes are declared as
    // `unknown` here and validated by the IoBuffer's typed entry
    // points to avoid coupling to internal SDK type paths that are
    // not re-exported from the public barrel.
    //
    // llm_input + llm_output require `hooks.allowConversationAccess:
    // true` in the operator's plugin config — they're treated by the
    // runtime as conversation-content hooks. before_tool_call and
    // after_tool_call have no permission requirement.
    api.on("llm_input", (event: unknown, ctx: unknown) => {
      void ctx;
      try {
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
    api.on("before_tool_call", (event: unknown, ctx: unknown) => {
      try {
        // ctx exposes runId per the public hook contract; payload carries
        // toolCallId, toolName, and parameters (args).
        const runId = (ctx as { runId?: string } | undefined)?.runId;
        const payload = event as ToolBeforePayload & {
          parameters?: unknown;
        };
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
        const runId = (ctx as { runId?: string } | undefined)?.runId;
        const payload = event as ToolAfterPayload & {
          error?: unknown;
        };
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
