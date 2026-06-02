import { describe, expect, it } from "vitest";
import {
  IoBuffer,
  type LlmInputPayload,
  type LlmOutputPayload,
  type ToolMiddlewarePayload,
} from "../io-buffer.js";

function input(
  runId: string,
  prompt: string,
  extra: Partial<LlmInputPayload> = {},
): LlmInputPayload {
  return {
    runId,
    prompt,
    historyMessages: [],
    imagesCount: 0,
    ...extra,
  };
}

function output(
  runId: string,
  text: string,
  extra: Partial<LlmOutputPayload> = {},
): LlmOutputPayload {
  return {
    runId,
    assistantTexts: [text],
    ...extra,
  };
}

function tool(
  toolCallId: string,
  toolName: string,
  extra: Partial<ToolMiddlewarePayload> = {},
): ToolMiddlewarePayload {
  return { toolCallId, toolName, ...extra };
}

describe("IoBuffer — LLM I/O (turn-level run snapshots)", () => {
  // v0.3.0: per-call pairing dropped. llm_input / llm_output fire
  // once per turn, not per model call, so per-call slots were
  // impossible to attribute correctly (v0.2.x N:1 bug). We now keep
  // only firstInput / lastOutput per run for the openclaw.run span's
  // braintrust.input / braintrust.output.

  it("captures firstInput on the first llm_input for a run", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "first"));
    buf.recordLlmInput(input("r1", "second"));
    expect(buf.peekRunIo("r1").firstInput?.prompt).toBe("first");
  });

  it("captures lastOutput on the latest llm_output for a run", () => {
    const buf = new IoBuffer();
    buf.recordLlmOutput(output("r1", "early"));
    buf.recordLlmOutput(output("r1", "late"));
    expect(buf.peekRunIo("r1").lastOutput?.assistantTexts).toEqual(["late"]);
  });

  it("peekRunIo is non-consuming (multiple reads return the same data)", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p"));
    buf.recordLlmOutput(output("r1", "o"));
    expect(buf.peekRunIo("r1").firstInput?.prompt).toBe("p");
    expect(buf.peekRunIo("r1").firstInput?.prompt).toBe("p");
    expect(buf.peekRunIo("r1").lastOutput?.assistantTexts).toEqual(["o"]);
  });

  it("peekRunIo on unknown run returns empty object", () => {
    const buf = new IoBuffer();
    expect(buf.peekRunIo("nope")).toEqual({});
  });

  it("does not record when constructed with enabled: false", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.recordLlmInput(input("r1", "p"));
    buf.recordLlmOutput(output("r1", "o"));
    expect(buf.peekRunIo("r1")).toEqual({});
  });

  it("flips capture on/off live via setEnabled", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.recordLlmInput(input("r1", "first-disabled"));
    expect(buf.peekRunIo("r1").firstInput).toBeUndefined();
    buf.setEnabled(true);
    buf.recordLlmInput(input("r1", "first-enabled"));
    expect(buf.peekRunIo("r1").firstInput?.prompt).toBe("first-enabled");
    buf.setEnabled(false);
    buf.recordLlmOutput(output("r1", "ignored"));
    expect(buf.peekRunIo("r1").lastOutput).toBeUndefined();
  });

  it("clearRun drops all state for a runId without affecting others", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p1"));
    buf.recordLlmInput(input("r2", "p2"));
    buf.clearRun("r1");
    expect(buf.peekRunIo("r1")).toEqual({});
    expect(buf.peekRunIo("r2").firstInput?.prompt).toBe("p2");
  });
});

describe("IoBuffer — tool payloads (two-phase: before + after)", () => {
  it("merges before_tool_call + after_tool_call by toolCallId", () => {
    const buf = new IoBuffer();
    buf.recordToolBefore(
      { toolCallId: "call-1", toolName: "exec", args: { cmd: "ls" } },
      "r1",
    );
    buf.recordToolAfter(
      { toolCallId: "call-1", result: "ok", isError: false, durationMs: 12 },
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.toolName).toBe("exec");
    expect(taken?.args).toEqual({ cmd: "ls" });
    expect(taken?.result).toBe("ok");
    expect(taken?.isError).toBe(false);
    expect(taken?.durationMs).toBe(12);
    // takeToolIo consumes — second call returns undefined.
    expect(buf.takeToolIo("r1", "call-1")).toBeUndefined();
  });

  it("handles after_tool_call arriving before before_tool_call (out-of-order)", () => {
    const buf = new IoBuffer();
    buf.recordToolAfter({ toolCallId: "call-1", result: "ok" }, "r1");
    buf.recordToolBefore(
      { toolCallId: "call-1", toolName: "exec", args: { cmd: "ls" } },
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.toolName).toBe("exec");
    expect(taken?.args).toEqual({ cmd: "ls" });
    expect(taken?.result).toBe("ok");
  });

  it("handles after-only (before missed) — result-only entry surfaces", () => {
    const buf = new IoBuffer();
    buf.recordToolAfter(
      { toolCallId: "call-1", toolName: "exec", result: "ok", isError: false },
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.toolName).toBe("exec");
    expect(taken?.result).toBe("ok");
    expect(taken?.args).toBeUndefined();
  });

  it("handles before-only (after missed) — args-only entry surfaces", () => {
    const buf = new IoBuffer();
    buf.recordToolBefore(
      { toolCallId: "call-1", toolName: "exec", args: { cmd: "ls" } },
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.toolName).toBe("exec");
    expect(taken?.args).toEqual({ cmd: "ls" });
    expect(taken?.result).toBeUndefined();
  });

  it("does not let an after-payload's later before-payload overwrite an existing result", () => {
    // Edge case: if before arrives twice (replay / hook retried), we
    // shouldn't lose the result already captured by an earlier after.
    const buf = new IoBuffer();
    buf.recordToolAfter({ toolCallId: "call-1", result: "first-result" }, "r1");
    buf.recordToolBefore(
      { toolCallId: "call-1", toolName: "exec", args: { cmd: "ls" } },
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.result).toBe("first-result");
    expect(taken?.args).toEqual({ cmd: "ls" });
  });

  it("records and consumes a tool payload via legacy recordToolResult (back-compat)", () => {
    // recordToolResult is deprecated but kept for transitional callers;
    // exercise the single-call path so we know it still works.
    const buf = new IoBuffer();
    buf.recordToolResult(
      tool("call-1", "exec", { args: { cmd: "ls" }, result: "ok" }),
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.args).toEqual({ cmd: "ls" });
    expect(taken?.result).toBe("ok");
    expect(buf.takeToolIo("r1", "call-1")).toBeUndefined();
  });

  it("drops tool payloads when runId is missing", () => {
    const buf = new IoBuffer();
    buf.recordToolResult(tool("call-1", "exec"), undefined);
    expect(buf.takeToolIo("missing", "call-1")).toBeUndefined();
  });

  it("no-ops tool capture when disabled (legacy recordToolResult path)", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.recordToolResult(tool("call-1", "exec"), "r1");
    expect(buf.takeToolIo("r1", "call-1")).toBeUndefined();
  });

  it("records identity fields (toolName, threadId, turnId) even when disabled", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.recordToolBefore(
      {
        toolCallId: "c1",
        toolName: "Bash",
        args: { cmd: "ls" },
        threadId: "t1",
        turnId: "turn-1",
      },
      "r1",
    );
    buf.recordToolAfter(
      { toolCallId: "c1", result: "file.txt", isError: false, durationMs: 42 },
      "r1",
    );
    const payload = buf.takeToolIo("r1", "c1");
    // Identity fields always present
    expect(payload?.toolName).toBe("Bash");
    expect(payload?.threadId).toBe("t1");
    expect(payload?.turnId).toBe("turn-1");
    expect(payload?.isError).toBe(false);
    expect(payload?.durationMs).toBe(42);
    // Content fields gated — args and result should be absent
    expect(payload?.args).toBeUndefined();
    expect(payload?.result).toBeUndefined();
  });

  it("records content fields (args, result) when enabled", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.recordToolBefore(
      {
        toolCallId: "c1",
        toolName: "Read",
        args: { path: "/foo" },
        threadId: "t2",
        turnId: "turn-2",
      },
      "r1",
    );
    buf.recordToolAfter(
      { toolCallId: "c1", result: "file content", isError: false },
      "r1",
    );
    const payload = buf.takeToolIo("r1", "c1");
    expect(payload?.args).toEqual({ path: "/foo" });
    expect(payload?.result).toBe("file content");
    expect(payload?.threadId).toBe("t2");
    expect(payload?.turnId).toBe("turn-2");
  });
});

describe("IoBuffer — tool reasoning (setPendingAssistantMessage + extractToolRationale)", () => {
  function makeMsg(blocks: Array<Record<string, unknown>>) {
    return { content: blocks };
  }

  it("extracts text rationale preceding a toolCall block", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "text", text: "I should read the config file first." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const result = buf.extractToolRationale("r1", "call-1");
    expect(result.rationale).toBe("I should read the config file first.");
    expect(result.thinking).toBeUndefined();
    expect(result.thinkingRedacted).toBeUndefined();
  });

  it("joins multiple text blocks with newline", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "text", text: "First thought." },
        { type: "text", text: "Second thought." },
        { type: "toolCall", id: "call-1", name: "Bash", arguments: {} },
      ]),
    );
    expect(buf.extractToolRationale("r1", "call-1").rationale).toBe(
      "First thought.\nSecond thought.",
    );
  });

  it("extracts non-redacted thinking content", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        {
          type: "thinking",
          thinking: "Let me think about this...",
          redacted: false,
        },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const result = buf.extractToolRationale("r1", "call-1");
    expect(result.thinking).toBe("Let me think about this...");
    expect(result.thinkingRedacted).toBeUndefined();
  });

  it("sets thinkingRedacted=true and omits thinking text when block is redacted", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "thinking", thinking: "secret", redacted: true },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const result = buf.extractToolRationale("r1", "call-1");
    expect(result.thinking).toBeUndefined();
    expect(result.thinkingRedacted).toBe(true);
  });

  it("only collects blocks BEFORE the matched toolCall, not after", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "text", text: "Before first tool." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
        { type: "text", text: "After first tool (for second tool)." },
        { type: "toolCall", id: "call-2", name: "Bash", arguments: {} },
      ]),
    );
    expect(buf.extractToolRationale("r1", "call-1").rationale).toBe(
      "Before first tool.",
    );
    expect(buf.extractToolRationale("r1", "call-2").rationale).toBe(
      "After first tool (for second tool).",
    );
  });

  it("returns {} when toolCallId not found in content", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    expect(buf.extractToolRationale("r1", "call-999")).toEqual({});
  });

  it("returns {} when no pending message for the run", () => {
    const buf = new IoBuffer({ enabled: true });
    expect(buf.extractToolRationale("r1", "call-1")).toEqual({});
  });

  it("does not store pending message when disabled (captureContent=off)", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "text", text: "Rationale." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    expect(buf.extractToolRationale("r1", "call-1")).toEqual({});
  });

  it("threads rationale through recordToolBefore into takeToolIo", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "text", text: "I need to list the files." },
        { type: "toolCall", id: "c1", name: "Bash", arguments: {} },
      ]),
    );
    const reasoning = buf.extractToolRationale("r1", "c1");
    buf.recordToolBefore(
      {
        toolCallId: "c1",
        toolName: "Bash",
        args: { command: "ls" },
        ...reasoning,
      },
      "r1",
    );
    const payload = buf.takeToolIo("r1", "c1");
    expect(payload?.rationale).toBe("I need to list the files.");
  });

  it("clears pending assistant message on clearRun", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessage(
      "r1",
      makeMsg([
        { type: "text", text: "Rationale." },
        { type: "toolCall", id: "c1", name: "Read", arguments: {} },
      ]),
    );
    buf.clearRun("r1");
    expect(buf.extractToolRationale("r1", "c1")).toEqual({});
  });
});

describe("IoBuffer — open model.call span registry (model.usage parenting)", () => {
  it("returns the registered span for a session by sessionKey", () => {
    const buf = new IoBuffer();
    const span = { id: "span-a" } as unknown;
    buf.setOpenModelCallSpanForSession("sk-1", "sid-1", span);
    expect(buf.getOpenModelCallSpanForSession("sk-1", "sid-1")).toBe(span);
  });

  it("falls back to sessionId when sessionKey is missing", () => {
    const buf = new IoBuffer();
    const span = { id: "span-a" } as unknown;
    buf.setOpenModelCallSpanForSession(undefined, "sid-1", span);
    expect(buf.getOpenModelCallSpanForSession(undefined, "sid-1")).toBe(span);
  });

  it("returns undefined when both session ids are missing", () => {
    const buf = new IoBuffer();
    const span = { id: "span-a" } as unknown;
    buf.setOpenModelCallSpanForSession(undefined, undefined, span);
    expect(
      buf.getOpenModelCallSpanForSession(undefined, undefined),
    ).toBeUndefined();
  });

  it("clear only marks the registration when the span matches (concurrent-call guard)", () => {
    // ttlMs:0 = immediate expiry on close, so this test exercises the
    // pure guard logic without TTL noise. The default 5000 ms TTL is
    // covered by the dedicated TTL tests below.
    const buf = new IoBuffer({ openModelCallTtlMs: 0 });
    const older = { id: "older" } as unknown;
    const newer = { id: "newer" } as unknown;
    buf.setOpenModelCallSpanForSession("sk-1", undefined, older);
    // A second call for the same session overwrites the registration.
    buf.setOpenModelCallSpanForSession("sk-1", undefined, newer);
    // The older call closes — should NOT clobber the newer registration.
    buf.clearOpenModelCallSpanForSession("sk-1", undefined, older);
    expect(buf.getOpenModelCallSpanForSession("sk-1", undefined)).toBe(newer);
    // Now the newer call closes — TTL is 0, so lookup returns undefined.
    buf.clearOpenModelCallSpanForSession("sk-1", undefined, newer);
    expect(
      buf.getOpenModelCallSpanForSession("sk-1", undefined),
    ).toBeUndefined();
  });

  it("keeps the entry findable for openModelCallTtlMs after close (race fix)", () => {
    // The production bug v0.3.0 fixes: model.usage arrives via the
    // diagnostic bus (async) AFTER model_call_ended (sync) has already
    // cleared the registry, so usage spans went fully orphan. TTL
    // keeps the entry alive across that race.
    let now = 1000;
    const buf = new IoBuffer({
      openModelCallTtlMs: 5000,
      now: () => now,
    });
    const span = { id: "s" } as unknown;
    buf.setOpenModelCallSpanForSession("sk-1", "sid-1", span);
    buf.clearOpenModelCallSpanForSession("sk-1", "sid-1", span);
    // Within TTL: still findable.
    now = 1000 + 4999;
    expect(buf.getOpenModelCallSpanForSession("sk-1", undefined)).toBe(span);
    expect(buf.getOpenModelCallSpanForSession(undefined, "sid-1")).toBe(span);
    // Past TTL: gone.
    now = 1000 + 5001;
    expect(buf.getOpenModelCallSpanForSession("sk-1", "sid-1")).toBeUndefined();
  });

  it("dual-keys entries under both sessionKey and sessionId (key-mismatch fix)", () => {
    // Production usage events sometimes carry only sessionKey,
    // sometimes only sessionId. Writing under both keys at set-time
    // makes the lookup robust regardless of which side the runtime
    // populated on the usage event.
    const buf = new IoBuffer({ openModelCallTtlMs: 0 });
    const span = { id: "s" } as unknown;
    buf.setOpenModelCallSpanForSession("sk-1", "sid-1", span);
    expect(buf.getOpenModelCallSpanForSession("sk-1", undefined)).toBe(span);
    expect(buf.getOpenModelCallSpanForSession(undefined, "sid-1")).toBe(span);
    expect(buf.getOpenModelCallSpanForSession("sk-other", "sid-1")).toBe(span);
  });

  it("returns undefined when no open call is registered for the session", () => {
    const buf = new IoBuffer();
    expect(
      buf.getOpenModelCallSpanForSession("sk-unknown", "sid-unknown"),
    ).toBeUndefined();
  });
});

describe("IoBuffer — open run span backstop (model.usage)", () => {
  // Backstop for model.usage when no matching model.call exists.
  // Populated on run.started, cleared on run.completed. Dual-keyed
  // under sessionKey and sessionId, same as the model.call registry.
  it("returns the registered run span by either session id", () => {
    const buf = new IoBuffer();
    const runSpan = { id: "run" } as unknown;
    buf.setOpenRunSpanForSession("sk-1", "sid-1", runSpan);
    expect(buf.getOpenRunSpanForSession("sk-1", undefined)).toBe(runSpan);
    expect(buf.getOpenRunSpanForSession(undefined, "sid-1")).toBe(runSpan);
  });

  it("clears only when the span matches (concurrent-run guard)", () => {
    const buf = new IoBuffer();
    const a = { id: "a" } as unknown;
    const b = { id: "b" } as unknown;
    buf.setOpenRunSpanForSession("sk-1", undefined, a);
    buf.setOpenRunSpanForSession("sk-1", undefined, b);
    buf.clearOpenRunSpanForSession("sk-1", undefined, a);
    expect(buf.getOpenRunSpanForSession("sk-1", undefined)).toBe(b);
    buf.clearOpenRunSpanForSession("sk-1", undefined, b);
    expect(buf.getOpenRunSpanForSession("sk-1", undefined)).toBeUndefined();
  });

  it("returns undefined when both session ids are missing or unknown", () => {
    const buf = new IoBuffer();
    expect(buf.getOpenRunSpanForSession(undefined, undefined)).toBeUndefined();
    expect(buf.getOpenRunSpanForSession("nope", "nope2")).toBeUndefined();
  });
});

describe("IoBuffer — stats", () => {
  it("counts runs, tool calls, and session parents", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p"));
    buf.recordLlmInput(input("r2", "p"));
    buf.recordToolResult(tool("c1", "exec"), "r1");
    buf.setOpenModelCallSpanForSession("sk-1", undefined, {});
    const s = buf.stats();
    expect(s.runs).toBe(2);
    expect(s.totalToolCalls).toBe(1);
    expect(s.sessionParents).toBe(1);
  });
});

describe("IoBuffer — session-keyed reasoning (before_message_write path)", () => {
  function makeAssistant(blocks: Array<Record<string, unknown>>) {
    return { role: "assistant", content: blocks };
  }

  it("extracts thinking from a session-keyed assistant message", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "thinking", thinking: "Let me think about this." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const r = buf.extractToolRationaleForSession("sk-1", "call-1");
    expect(r.thinking).toBe("Let me think about this.");
    expect(r.rationale).toBeUndefined();
    expect(r.thinkingRedacted).toBeUndefined();
  });

  it("extracts text rationale preceding a toolCall block", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "text", text: "I should check the config." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const r = buf.extractToolRationaleForSession("sk-1", "call-1");
    expect(r.rationale).toBe("I should check the config.");
  });

  it("extracts both thinking and text when both precede the toolCall", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "thinking", thinking: "Deep reasoning." },
        { type: "text", text: "I will read the file." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const r = buf.extractToolRationaleForSession("sk-1", "call-1");
    expect(r.thinking).toBe("Deep reasoning.");
    expect(r.rationale).toBe("I will read the file.");
  });

  it("scopes reasoning between previous toolCall and target — does not bleed across tools", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "thinking", thinking: "Reason for tool 1." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
        { type: "thinking", thinking: "Reason for tool 2." },
        { type: "toolCall", id: "call-2", name: "Bash", arguments: {} },
      ]),
    );
    const r1 = buf.extractToolRationaleForSession("sk-1", "call-1");
    const r2 = buf.extractToolRationaleForSession("sk-1", "call-2");
    expect(r1.thinking).toBe("Reason for tool 1.");
    expect(r2.thinking).toBe("Reason for tool 2.");
  });

  it("returns {} when toolCallId not found", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    expect(buf.extractToolRationaleForSession("sk-1", "call-999")).toEqual({});
  });

  it("returns {} when no message stored for sessionKey", () => {
    const buf = new IoBuffer({ enabled: true });
    expect(buf.extractToolRationaleForSession("sk-missing", "call-1")).toEqual(
      {},
    );
  });

  it("ignores non-assistant messages (role !== assistant)", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession("sk-1", {
      role: "user",
      content: [
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ],
    });
    expect(buf.extractToolRationaleForSession("sk-1", "call-1")).toEqual({});
  });

  it("ignores assistant messages with no toolCall blocks", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([{ type: "text", text: "Final answer." }]),
    );
    // Nothing stored — message had no tool calls, so it was filtered
    expect(buf.extractToolRationaleForSession("sk-1", "call-1")).toEqual({});
  });

  it("does not store when disabled", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "thinking", thinking: "Deep thought." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    expect(buf.extractToolRationaleForSession("sk-1", "call-1")).toEqual({});
  });

  it("clearPendingAssistantForSession removes the entry", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "thinking", thinking: "Some thought." },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    buf.clearPendingAssistantForSession("sk-1");
    expect(buf.extractToolRationaleForSession("sk-1", "call-1")).toEqual({});
  });

  it("handles redacted thinking block", () => {
    const buf = new IoBuffer({ enabled: true });
    buf.setPendingAssistantMessageForSession(
      "sk-1",
      makeAssistant([
        { type: "thinking", thinking: "", redacted: true },
        { type: "toolCall", id: "call-1", name: "Read", arguments: {} },
      ]),
    );
    const r = buf.extractToolRationaleForSession("sk-1", "call-1");
    expect(r.thinkingRedacted).toBe(true);
    expect(r.thinking).toBeUndefined();
  });
});
