// Integration-shape test for the full event-to-span flow.
//
// Drives the diagnostic event handler against a real OTEL provider
// wired to an in-memory exporter, then reads spans back and asserts
// the attribute set on each. Exercises the IoBuffer + attrs +
// event-handler stack end-to-end without hitting Braintrust.

import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it } from "vitest";
import type { CommonAttrOptions } from "../attrs.js";
import { createDiagnosticEventHandler } from "../event-handler.js";
import {
  IoBuffer,
  type LlmInputPayload,
  type LlmOutputPayload,
} from "../io-buffer.js";

function setupHandler() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  const tracer = provider.getTracer("test");
  const ioBuffer = new IoBuffer({ enabled: true });
  const attrOpts: CommonAttrOptions = {
    tags: ["agent-jeffery"],
    serviceName: "openclaw-jeffery",
    sessIds: { raw: false, hash: true },
    salt: "test-salt",
    versioning: {
      openclawVersion: "2026.5.20",
      agentPromptVersion: "jeffery-v3",
      toolPolicyVersion: "default-v2",
      runbookVersion: "m1-runbook-2026-05-26",
      environment: "prod",
    },
  };
  const handler = createDiagnosticEventHandler({ tracer, attrOpts, ioBuffer });
  return { exporter, provider, ioBuffer, handler };
}

function byName(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

function attr(span: ReadableSpan, key: string): unknown {
  return span.attributes[key];
}

describe("integration: full event → span flow with content capture on", () => {
  let exporter: InMemorySpanExporter;
  let ioBuffer: IoBuffer;
  let handler: ReturnType<typeof createDiagnosticEventHandler>;

  beforeEach(() => {
    const setup = setupHandler();
    exporter = setup.exporter;
    ioBuffer = setup.ioBuffer;
    handler = setup.handler;
  });

  it("emits a complete 2-turn run with all eval-grade attributes", () => {
    const sessionKey = "sk-jeffery-abc";
    const sessionId = "sid-abc";
    const runId = "run-1";
    const baseEvent = {
      sessionKey,
      sessionId,
      runId,
      provider: "openrouter",
      model: "openai/gpt-5.5",
      agentId: "jeffery",
      channel: "telegram",
    };

    // --- Run starts ---
    handler.handle({ type: "run.started", ...baseEvent, trigger: "user" });

    // --- Turn 1: llm_input hook (turn-level, fires once per turn) ---
    const turn1Input: LlmInputPayload = {
      runId,
      sessionId,
      provider: "openrouter",
      model: "openai/gpt-5.5",
      systemPrompt: "you are jeffery, a gateway-debugging agent",
      prompt: "what is the deployment status of openclaw-bubba",
      historyMessages: [],
      imagesCount: 0,
      tools: [{ name: "shell.exec" }, { name: "fly.deploy.status" }],
    };
    ioBuffer.recordLlmInput(turn1Input);

    // model.call lifecycle via typed hooks (v0.3.0+).
    handler.onModelCallStarted({
      ...baseEvent,
      callId: "call-1",
      api: "messages",
      transport: "http",
      contextTokenBudget: 180_000,
    });

    // llm_output for turn 1 (turn-level)
    const turn1Output: LlmOutputPayload = {
      runId,
      sessionId,
      provider: "openrouter",
      model: "openai/gpt-5.5",
      assistantTexts: ["checking now"],
      usage: { input: 120, output: 8, total: 128 },
      resolvedRef: "openrouter/openai/gpt-5.5",
      harnessId: "pi",
    };
    ioBuffer.recordLlmOutput(turn1Output);

    handler.onModelCallEnded({
      ...baseEvent,
      callId: "call-1",
      outcome: "completed",
      durationMs: 1200,
      requestPayloadBytes: 4096,
      responseStreamBytes: 256,
      timeToFirstByteMs: 380,
      upstreamRequestIdHash: "abc123",
    });

    // model.usage between the two calls — must parent to call-1's span
    // via session lookup. But call-1 just closed and cleared its
    // registration; usage arriving HERE will fall back to orphan.
    // Re-emit usage WHILE call-1 was open: rewind by emitting before
    // model.call.completed in a real scenario. For the integration
    // test we cover BOTH the parented and orphan paths in separate
    // assertions below.

    // --- Tool execution during turn 1 (model decided to run a tool) ---
    handler.handle({
      type: "tool.execution.started",
      ...baseEvent,
      toolName: "fly.deploy.status",
      toolCallId: "tc-1",
    });
    // Mirror the production flow: before_tool_call lands first (args),
    // after_tool_call lands second (result). The event-handler merges
    // both via takeToolIo when tool.execution.completed closes the span.
    ioBuffer.recordToolBefore(
      {
        toolCallId: "tc-1",
        toolName: "fly.deploy.status",
        args: { app: "openclaw-bubba" },
      },
      runId,
    );
    ioBuffer.recordToolAfter(
      {
        toolCallId: "tc-1",
        result: { status: "running", machines: 1 },
        isError: false,
        durationMs: 150,
      },
      runId,
    );
    handler.handle({
      type: "tool.execution.completed",
      ...baseEvent,
      toolCallId: "tc-1",
      durationMs: 150,
    });

    // --- Turn 2: a second model call (post-tool-result reflection) ---
    const turn2Input: LlmInputPayload = {
      runId,
      sessionId,
      provider: "openrouter",
      model: "openai/gpt-5.5",
      systemPrompt: "you are jeffery, a gateway-debugging agent",
      prompt: "what is the deployment status of openclaw-bubba",
      historyMessages: [
        { role: "user", content: "what is the deployment status" },
        { role: "assistant", content: "checking now" },
        { role: "tool", content: '{"status":"running"}' },
      ],
      imagesCount: 0,
    };
    ioBuffer.recordLlmInput(turn2Input);

    handler.onModelCallStarted({
      ...baseEvent,
      callId: "call-2",
      api: "messages",
      transport: "http",
    });

    // model.usage fired WHILE call-2 is open — should parent to call-2's span.
    handler.handle({
      type: "model.usage",
      ...baseEvent,
      costUsd: 0.0042,
      usage: { input: 220, output: 35, total: 255, cacheRead: 50 },
    });

    const turn2Output: LlmOutputPayload = {
      runId,
      sessionId,
      provider: "openrouter",
      model: "openai/gpt-5.5",
      assistantTexts: ["openclaw-bubba is running on 1 machine"],
      usage: { input: 220, output: 35, total: 255 },
    };
    ioBuffer.recordLlmOutput(turn2Output);

    handler.onModelCallEnded({
      ...baseEvent,
      callId: "call-2",
      outcome: "completed",
      durationMs: 800,
      timeToFirstByteMs: 220,
    });

    // --- Run completes ---
    handler.handle({ type: "run.completed", ...baseEvent });

    const spans = exporter.getFinishedSpans();
    const run = byName(spans, "openclaw.run");
    const calls = byName(spans, "openclaw.model.call");
    const tools = byName(spans, "openclaw.tool.execution");
    const usages = byName(spans, "openclaw.model.usage");

    // Sanity: span counts
    expect(run).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(tools).toHaveLength(1);
    expect(usages).toHaveLength(1);

    // ---- Run span ------------------------------------------------------
    const r = run[0];
    expect(attr(r, "braintrust.span_attributes.type")).toBe("task");
    expect(attr(r, "braintrust.input")).toBe(
      "what is the deployment status of openclaw-bubba",
    );
    expect(attr(r, "braintrust.output")).toBe(
      "openclaw-bubba is running on 1 machine",
    );
    expect(attr(r, "braintrust.metadata.openclaw_version")).toBe("2026.5.20");
    expect(attr(r, "braintrust.metadata.agent_prompt_version")).toBe(
      "jeffery-v3",
    );
    expect(attr(r, "braintrust.metadata.environment")).toBe("prod");
    expect(attr(r, "braintrust.metadata.model")).toBe("openai/gpt-5.5");
    expect(attr(r, "braintrust.metadata.provider")).toBe("openrouter");
    expect(attr(r, "braintrust.metadata.agent_id")).toBe("jeffery");
    expect(attr(r, "braintrust.metadata.channel")).toBe("telegram");
    expect(attr(r, "braintrust.metadata.openclaw.run_id_hash")).toMatch(
      /^[0-9a-f]{16}$/,
    );

    // ---- Model.call spans ---------------------------------------------
    // v0.3.0: per-call braintrust.input_json / output_json removed.
    // Per-call data is per-call metadata only (ttfb, bytes, duration,
    // model, etc.); LLM content lives on the run span via
    // braintrust.input / braintrust.output. Spans are distinguished
    // here by their close-time attrs.
    const call1 = calls.find(
      (s) => s.attributes["braintrust.metrics.time_to_first_token"] === 380,
    );
    const call2 = calls.find(
      (s) => s.attributes["braintrust.metrics.time_to_first_token"] === 220,
    );
    expect(call1).toBeDefined();
    expect(call2).toBeDefined();
    if (!call1 || !call2) throw new Error("unreachable");

    expect(attr(call1, "braintrust.span_attributes.type")).toBe("llm");
    expect(attr(call1, "braintrust.input_json")).toBeUndefined();
    expect(attr(call1, "braintrust.output_json")).toBeUndefined();
    expect(attr(call1, "braintrust.metadata.openclaw.duration_ms")).toBe(1200);
    expect(attr(call1, "braintrust.metadata.openclaw.request_bytes")).toBe(4096);
    expect(attr(call1, "braintrust.metadata.openclaw.response_bytes")).toBe(256);
    expect(attr(call1, "braintrust.metadata.openclaw.api")).toBe("messages");
    expect(attr(call1, "braintrust.metadata.openclaw.transport")).toBe("http");
    expect(
      attr(call1, "braintrust.metadata.openclaw.upstream_request_id_hash"),
    ).toBe("abc123");
    expect(attr(call1, "braintrust.metadata.model")).toBe("openai/gpt-5.5");
    expect(attr(call1, "braintrust.metadata.openclaw_version")).toBe(
      "2026.5.20",
    );

    expect(attr(call2, "braintrust.input_json")).toBeUndefined();
    expect(attr(call2, "braintrust.output_json")).toBeUndefined();
    expect(attr(call2, "braintrust.metadata.openclaw.duration_ms")).toBe(800);

    // ---- Tool.execution span ------------------------------------------
    const t = tools[0];
    expect(attr(t, "braintrust.span_attributes.type")).toBe("tool");
    expect(attr(t, "braintrust.metadata.openclaw.tool_name")).toBe(
      "fly.deploy.status",
    );
    expect(JSON.parse(attr(t, "braintrust.input_json") as string)).toEqual({
      app: "openclaw-bubba",
    });
    expect(JSON.parse(attr(t, "braintrust.output_json") as string)).toEqual({
      status: "running",
      machines: 1,
    });
    expect(attr(t, "braintrust.metadata.tool_call_id")).toBe("tc-1");
    expect(attr(t, "braintrust.metadata.is_error")).toBe(false);
    expect(attr(t, "braintrust.metadata.openclaw.duration_ms")).toBe(150);

    // ---- Model.usage span ---------------------------------------------
    // Should be parented to call-2 (which was open when usage fired).
    const u = usages[0];
    expect(attr(u, "braintrust.span_attributes.type")).toBe("llm");
    expect(attr(u, "braintrust.metrics.prompt_tokens")).toBe(220);
    expect(attr(u, "braintrust.metrics.completion_tokens")).toBe(35);
    expect(attr(u, "braintrust.metrics.prompt_cached_tokens")).toBe(50);
    expect(attr(u, "braintrust.metrics.cost")).toBe(0.0042);
    // Native model lifted via common.
    expect(attr(u, "braintrust.metadata.model")).toBe("openai/gpt-5.5");
    // Parent span id should equal call-2's spanId — verifies the
    // session registry correctly handed back the open model.call.
    const call2SpanId = call2.spanContext().spanId;
    expect(u.parentSpanContext?.spanId).toBe(call2SpanId);
  });

  it("parents model.call and tool.execution to the run span", () => {
    const sessionKey = "sk-1";
    const sessionId = "sid-1";
    const runId = "run-2";
    handler.handle({
      type: "run.started",
      sessionKey,
      sessionId,
      runId,
      agentId: "jeffery",
    });
    handler.onModelCallStarted({
      sessionKey,
      sessionId,
      runId,
      callId: "c1",
      provider: "anthropic",
      model: "claude",
    });
    handler.onModelCallEnded({
      sessionKey,
      sessionId,
      runId,
      callId: "c1",
      outcome: "completed",
      durationMs: 100,
    });
    handler.handle({
      type: "tool.execution.started",
      sessionKey,
      sessionId,
      runId,
      toolName: "shell.exec",
      toolCallId: "t1",
    });
    handler.handle({
      type: "tool.execution.completed",
      sessionKey,
      sessionId,
      runId,
      toolCallId: "t1",
      durationMs: 50,
    });
    handler.handle({ type: "run.completed", sessionKey, sessionId, runId });

    const spans = exporter.getFinishedSpans();
    const run = byName(spans, "openclaw.run")[0];
    const call = byName(spans, "openclaw.model.call")[0];
    const tool = byName(spans, "openclaw.tool.execution")[0];

    expect(call.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(tool.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    // Same trace id across all three.
    const traceId = run.spanContext().traceId;
    expect(call.spanContext().traceId).toBe(traceId);
    expect(tool.spanContext().traceId).toBe(traceId);
  });

  it("falls back to orphan model.usage when no open model.call for the session", () => {
    handler.handle({
      type: "model.usage",
      sessionKey: "sk-orphan",
      sessionId: "sid-orphan",
      provider: "anthropic",
      model: "claude",
      usage: { input: 10, output: 5, total: 15 },
    });
    const spans = exporter.getFinishedSpans();
    const u = byName(spans, "openclaw.model.usage")[0];
    expect(u).toBeDefined();
    // No parent → orphan span.
    expect(u.parentSpanContext).toBeUndefined();
  });

  it("does not capture I/O when buffer is disabled (back-compat)", () => {
    ioBuffer.setEnabled(false);
    const runId = "run-disabled";
    handler.handle({
      type: "run.started",
      runId,
      sessionKey: "sk-d",
      sessionId: "sid-d",
    });
    // These should no-op because the buffer is disabled.
    ioBuffer.recordLlmInput({
      runId,
      prompt: "hi",
      historyMessages: [],
      imagesCount: 0,
    });
    ioBuffer.recordLlmOutput({
      runId,
      assistantTexts: ["hello"],
    });
    handler.onModelCallStarted({
      runId,
      sessionKey: "sk-d",
      sessionId: "sid-d",
      callId: "cd",
    });
    handler.onModelCallEnded({
      runId,
      sessionKey: "sk-d",
      sessionId: "sid-d",
      callId: "cd",
      outcome: "completed",
      durationMs: 50,
    });
    handler.handle({
      type: "run.completed",
      runId,
      sessionKey: "sk-d",
      sessionId: "sid-d",
    });

    const spans = exporter.getFinishedSpans();
    const run = byName(spans, "openclaw.run")[0];
    const call = byName(spans, "openclaw.model.call")[0];
    expect(attr(run, "braintrust.input")).toBeUndefined();
    expect(attr(run, "braintrust.output")).toBeUndefined();
    expect(attr(call, "braintrust.input_json")).toBeUndefined();
    expect(attr(call, "braintrust.output_json")).toBeUndefined();
    // But the basic span structure + lifted metadata is still there.
    expect(attr(run, "braintrust.span_attributes.type")).toBe("task");
    expect(attr(run, "braintrust.metadata.openclaw_version")).toBe("2026.5.20");
  });
});
