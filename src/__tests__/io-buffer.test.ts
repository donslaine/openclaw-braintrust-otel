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

describe("IoBuffer — LLM I/O", () => {
  it("records an input and returns it via takeCallIo", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "hi"));
    const slot = buf.takeCallIo("r1");
    expect(slot?.input?.prompt).toBe("hi");
    expect(slot?.output).toBeUndefined();
  });

  it("pairs an output with its preceding input", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "hi"));
    buf.recordLlmOutput(output("r1", "hello"));
    const slot = buf.takeCallIo("r1");
    expect(slot?.input?.prompt).toBe("hi");
    expect(slot?.output?.assistantTexts).toEqual(["hello"]);
    // Buffer empty after consume
    expect(buf.takeCallIo("r1")).toBeUndefined();
  });

  it("creates an output-only slot when output arrives with no prior input", () => {
    const buf = new IoBuffer();
    buf.recordLlmOutput(output("r1", "hello"));
    const slot = buf.takeCallIo("r1");
    expect(slot?.input).toBeUndefined();
    expect(slot?.output?.assistantTexts).toEqual(["hello"]);
  });

  it("pairs two interleaved input/output sequences correctly", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p1"));
    buf.recordLlmInput(input("r1", "p2"));
    buf.recordLlmOutput(output("r1", "o2"));
    buf.recordLlmOutput(output("r1", "o1"));
    // recordLlmOutput matches the most-recent input without an output,
    // so order of arrival pairs LIFO: o2 → p2, o1 → p1.
    // takeCallIo returns oldest-paired first.
    const first = buf.takeCallIo("r1");
    expect(first?.input?.prompt).toBe("p1");
    expect(first?.output?.assistantTexts).toEqual(["o1"]);
    const second = buf.takeCallIo("r1");
    expect(second?.input?.prompt).toBe("p2");
    expect(second?.output?.assistantTexts).toEqual(["o2"]);
  });

  it("prefers paired slots over input-only when taking", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p1")); // input-only, oldest
    buf.recordLlmInput(input("r1", "p2"));
    buf.recordLlmOutput(output("r1", "o2")); // pairs with p2
    const slot = buf.takeCallIo("r1");
    expect(slot?.input?.prompt).toBe("p2");
    expect(slot?.output?.assistantTexts).toEqual(["o2"]);
  });

  it("enforces maxCallsPerRun by dropping oldest", () => {
    const buf = new IoBuffer({ maxCallsPerRun: 2 });
    buf.recordLlmInput(input("r1", "p1"));
    buf.recordLlmInput(input("r1", "p2"));
    buf.recordLlmInput(input("r1", "p3"));
    // p1 should be evicted; only p2 and p3 remain.
    const first = buf.takeCallIo("r1");
    const second = buf.takeCallIo("r1");
    expect([first?.input?.prompt, second?.input?.prompt].sort()).toEqual([
      "p2",
      "p3",
    ]);
    expect(buf.takeCallIo("r1")).toBeUndefined();
  });

  it("no-ops when enabled() returns false", () => {
    const buf = new IoBuffer({ enabled: () => false });
    buf.recordLlmInput(input("r1", "hi"));
    buf.recordLlmOutput(output("r1", "hello"));
    expect(buf.takeCallIo("r1")).toBeUndefined();
  });

  it("clearRun drops all state for a runId without affecting others", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p1"));
    buf.recordLlmInput(input("r2", "p2"));
    buf.clearRun("r1");
    expect(buf.takeCallIo("r1")).toBeUndefined();
    expect(buf.takeCallIo("r2")?.input?.prompt).toBe("p2");
  });

  it("peekRunIo returns first input and last output without consuming", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p1"));
    buf.recordLlmOutput(output("r1", "o1"));
    buf.recordLlmInput(input("r1", "p2"));
    buf.recordLlmOutput(output("r1", "o2"));
    const peek = buf.peekRunIo("r1");
    expect(peek.firstInput?.prompt).toBe("p1");
    expect(peek.lastOutput?.assistantTexts).toEqual(["o2"]);
    // Peek is non-consuming: both slots still takeable.
    expect(buf.takeCallIo("r1")?.input?.prompt).toBe("p1");
    expect(buf.takeCallIo("r1")?.input?.prompt).toBe("p2");
  });

  it("peekRunIo on unknown run returns empty object", () => {
    const buf = new IoBuffer();
    expect(buf.peekRunIo("nope")).toEqual({});
  });
});

describe("IoBuffer — tool middleware payloads", () => {
  it("records and consumes a tool payload by toolCallId", () => {
    const buf = new IoBuffer();
    buf.recordToolResult(
      tool("call-1", "exec", { args: { cmd: "ls" }, result: "ok" }),
      "r1",
    );
    const taken = buf.takeToolIo("r1", "call-1");
    expect(taken?.args).toEqual({ cmd: "ls" });
    expect(taken?.result).toBe("ok");
    // takeToolIo consumes — second call returns undefined.
    expect(buf.takeToolIo("r1", "call-1")).toBeUndefined();
  });

  it("drops tool payloads when runId is missing", () => {
    const buf = new IoBuffer();
    buf.recordToolResult(tool("call-1", "exec"), undefined);
    expect(buf.takeToolIo("missing", "call-1")).toBeUndefined();
  });

  it("no-ops tool capture when disabled", () => {
    const buf = new IoBuffer({ enabled: () => false });
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
  it("counts runs, paired slots, tool calls, and session parents", () => {
    const buf = new IoBuffer();
    buf.recordLlmInput(input("r1", "p"));
    buf.recordLlmInput(input("r2", "p"));
    buf.recordToolResult(tool("c1", "exec"), "r1");
    buf.setOpenModelCallSpanForSession("sk-1", undefined, {});
    const s = buf.stats();
    expect(s.runs).toBe(2);
    expect(s.totalCalls).toBe(2);
    expect(s.totalToolCalls).toBe(1);
    expect(s.sessionParents).toBe(1);
  });
});
