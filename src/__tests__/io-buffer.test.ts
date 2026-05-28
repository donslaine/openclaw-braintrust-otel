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

  it("no-ops tool capture when disabled", () => {
    const buf = new IoBuffer({ enabled: false });
    buf.recordToolResult(tool("call-1", "exec"), "r1");
    expect(buf.takeToolIo("r1", "call-1")).toBeUndefined();
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

  it("clear only removes the registration when the span matches (concurrent-call guard)", () => {
    const buf = new IoBuffer();
    const older = { id: "older" } as unknown;
    const newer = { id: "newer" } as unknown;
    buf.setOpenModelCallSpanForSession("sk-1", undefined, older);
    // A second call for the same session overwrites the registration.
    buf.setOpenModelCallSpanForSession("sk-1", undefined, newer);
    // The older call closes — should NOT clobber the newer registration.
    buf.clearOpenModelCallSpanForSession("sk-1", undefined, older);
    expect(buf.getOpenModelCallSpanForSession("sk-1", undefined)).toBe(newer);
    // Now the newer call closes — registration clears.
    buf.clearOpenModelCallSpanForSession("sk-1", undefined, newer);
    expect(
      buf.getOpenModelCallSpanForSession("sk-1", undefined),
    ).toBeUndefined();
  });

  it("returns undefined when no open call is registered for the session", () => {
    const buf = new IoBuffer();
    expect(
      buf.getOpenModelCallSpanForSession("sk-unknown", "sid-unknown"),
    ).toBeUndefined();
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
