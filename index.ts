import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  IoBuffer,
  type LlmInputPayload,
  type LlmOutputPayload,
  type ToolMiddlewarePayload,
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

    // Plugin SDK hook surface for LLM and tool I/O. Payload shapes are
    // declared as `unknown` here and validated by the IoBuffer's typed
    // entry points to avoid coupling to internal SDK type paths that
    // are not re-exported from the public barrel.
    api.registerHook("llm_input", (event: unknown) => {
      try {
        ioBuffer.recordLlmInput(event as LlmInputPayload);
      } catch (err) {
        console.warn("[braintrust-otel] llm_input handler error", err);
      }
    });
    api.registerHook("llm_output", (event: unknown) => {
      try {
        ioBuffer.recordLlmOutput(event as LlmOutputPayload);
      } catch (err) {
        console.warn("[braintrust-otel] llm_output handler error", err);
      }
    });
    api.registerAgentToolResultMiddleware((event: unknown, ctx: unknown) => {
      try {
        const runId = (ctx as { runId?: string } | undefined)?.runId;
        ioBuffer.recordToolResult(event as ToolMiddlewarePayload, runId);
      } catch (err) {
        console.warn("[braintrust-otel] tool middleware handler error", err);
      }
    });
  },
});
