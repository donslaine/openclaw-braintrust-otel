// Regression test for the v0.2.1 / v0.3.0 tool-I/O bug:
//
// The before_tool_call and after_tool_call typed-hook handlers in
// index.ts read `runId` from `ctx`, but per the openclaw hook contract
// (src/plugins/hook-types.ts:450-471 / 500-508) `runId` is on the
// payload, not the ctx. ctx.runId was always undefined, so every tool
// I/O payload was silently dropped at the IoBuffer's
// `if (!runId) return` guard, and every openclaw.tool.execution span
// landed without braintrust.input_json / output_json.
//
// Live trace 2026-05-28: tool.execution spans had no I/O attrs despite
// captureContent.enabled = true. Fix: read payload.runId first, fall
// back to ctx.runId. resolveHookRunId encapsulates the precedence.

import { describe, expect, it } from "vitest";
import { resolveHookRunId } from "../../index.js";

describe("resolveHookRunId (regression: tool-I/O dropped on undefined runId)", () => {
  it("prefers payload.runId over ctx.runId (the actual production case)", () => {
    expect(
      resolveHookRunId({ runId: "from-payload" }, { runId: "from-ctx" }),
    ).toBe("from-payload");
  });

  it("falls back to ctx.runId when payload has none", () => {
    expect(resolveHookRunId({}, { runId: "from-ctx" })).toBe("from-ctx");
  });

  it("returns undefined when neither side carries runId", () => {
    expect(resolveHookRunId({}, {})).toBeUndefined();
    expect(resolveHookRunId(undefined, undefined)).toBeUndefined();
  });

  it("tolerates non-object event/ctx without throwing", () => {
    expect(resolveHookRunId("not-an-object", null)).toBeUndefined();
    expect(resolveHookRunId(42, "string")).toBeUndefined();
  });
});
