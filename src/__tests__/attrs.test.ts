import { describe, expect, it } from "vitest";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  buildCommonAttrs,
  buildContextAssembledAttrs,
  buildModelCallCloseAttrs,
  buildModelCallIoAttrs,
  buildModelCallStartedAttrs,
  buildModelUsageAttrs,
  buildRunAttrs,
  buildRunIoAttrs,
  buildSessionAttrs,
  buildToolExecutionCloseAttrs,
  buildToolExecutionIoAttrs,
  buildToolExecutionStartedAttrs,
  buildVersioningAttrs,
  hashId,
  liftNativeMetadata,
  type CommonAttrOptions,
  type DiagnosticEvent,
} from "../attrs.js";
import type { CallSlot, ToolMiddlewarePayload } from "../io-buffer.js";

// Cast helper: the upstream types are a discriminated union, but our pure
// mappers take a structural `DiagnosticEvent` (string-keyed) since they
// only read fields by name. We construct events using the real union type
// for shape-correctness, then pass them in. This catches drift if upstream
// renames a field.
function evt<T extends DiagnosticEventPayload>(payload: T): DiagnosticEvent {
  return payload as unknown as DiagnosticEvent;
}

const baseOpts: CommonAttrOptions = {
  tags: ["agent-test"],
  serviceName: "openclaw-test",
  sessIds: { raw: false, hash: true },
  salt: "test-salt",
};

describe("hashId", () => {
  it("returns 16-char hex for a non-empty string", () => {
    const h = hashId("salt", "session-abc");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for same salt + value", () => {
    expect(hashId("salt", "v")).toBe(hashId("salt", "v"));
  });

  it("differs with different salts", () => {
    expect(hashId("s1", "v")).not.toBe(hashId("s2", "v"));
  });

  it("returns undefined for empty string", () => {
    expect(hashId("salt", "")).toBeUndefined();
  });

  it("returns undefined for non-string", () => {
    expect(hashId("salt", undefined)).toBeUndefined();
    expect(hashId("salt", 42)).toBeUndefined();
    expect(hashId("salt", null)).toBeUndefined();
  });
});

describe("buildSessionAttrs", () => {
  it("emits hashed ids when hash=true and raw=false", () => {
    const out = buildSessionAttrs(
      { type: "x", sessionKey: "sk1", sessionId: "si1", runId: "r1" },
      baseOpts,
    );
    expect(out["braintrust.metadata.openclaw.session_key_hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(out["braintrust.metadata.openclaw.session_id_hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(out["braintrust.metadata.openclaw.run_id_hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(out["braintrust.metadata.openclaw.session_key"]).toBeUndefined();
  });

  it("emits raw ids when raw=true", () => {
    const out = buildSessionAttrs(
      { type: "x", sessionKey: "sk1", sessionId: "si1", runId: "r1" },
      { ...baseOpts, sessIds: { raw: true, hash: false } },
    );
    expect(out["braintrust.metadata.openclaw.session_key"]).toBe("sk1");
    expect(out["braintrust.metadata.openclaw.session_id"]).toBe("si1");
    expect(out["braintrust.metadata.openclaw.run_id"]).toBe("r1");
    expect(
      out["braintrust.metadata.openclaw.session_key_hash"],
    ).toBeUndefined();
  });

  it("emits both when raw=true and hash=true", () => {
    const out = buildSessionAttrs(
      { type: "x", sessionKey: "sk1" },
      { ...baseOpts, sessIds: { raw: true, hash: true } },
    );
    expect(out["braintrust.metadata.openclaw.session_key"]).toBe("sk1");
    expect(out["braintrust.metadata.openclaw.session_key_hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });

  it("omits keys whose source is missing", () => {
    const out = buildSessionAttrs({ type: "x", sessionKey: "sk1" }, baseOpts);
    expect(out["braintrust.metadata.openclaw.session_key_hash"]).toBeDefined();
    expect(out["braintrust.metadata.openclaw.session_id_hash"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.run_id_hash"]).toBeUndefined();
  });
});

describe("buildCommonAttrs", () => {
  it("always includes tags and service_name", () => {
    const out = buildCommonAttrs({ type: "x" }, baseOpts);
    expect(out["braintrust.tags"]).toEqual(["agent-test"]);
    expect(out["braintrust.metadata.service_name"]).toBe("openclaw-test");
  });

  it("merges session attrs", () => {
    const out = buildCommonAttrs({ type: "x", runId: "r1" }, baseOpts);
    expect(out["braintrust.metadata.openclaw.run_id_hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
  });
});

describe("buildRunAttrs", () => {
  it("sets span type=task and maps trigger/agent/sessionKind", () => {
    const e: DiagnosticEvent = {
      type: "run.started",
      runId: "r1",
      channel: "telegram",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      trigger: "user",
      agent: "jeffery",
      sessionKind: "direct",
    };
    const common = buildCommonAttrs(e, baseOpts);
    const out = buildRunAttrs(e, common);
    expect(out["braintrust.span_attributes.type"]).toBe("task");
    expect(out["braintrust.metadata.openclaw.trigger"]).toBe("user");
    expect(out["braintrust.metadata.openclaw.agent"]).toBe("jeffery");
    expect(out["braintrust.metadata.openclaw.session_kind"]).toBe("direct");
    // Lifted via common: native top-level + namespaced both present.
    expect(out["braintrust.metadata.channel"]).toBe("telegram");
    expect(out["braintrust.metadata.openclaw.channel"]).toBe("telegram");
    expect(out["braintrust.metadata.provider"]).toBe("anthropic");
    expect(out["braintrust.metadata.openclaw.provider"]).toBe("anthropic");
    expect(out["braintrust.metadata.model"]).toBe("claude-sonnet-4-6");
    expect(out["braintrust.metadata.openclaw.model"]).toBe("claude-sonnet-4-6");
  });

  it("omits string fields that are missing or empty", () => {
    const common = buildCommonAttrs(
      { type: "run.started", provider: "" },
      baseOpts,
    );
    const out = buildRunAttrs(
      { type: "run.started", runId: "r1", provider: "" },
      common,
    );
    expect(out["braintrust.metadata.openclaw.provider"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.channel"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.trigger"]).toBeUndefined();
  });
});

describe("liftNativeMetadata", () => {
  it("lifts model/provider/agentId/channel to top-level AND namespaced", () => {
    const out = liftNativeMetadata({
      type: "x",
      provider: "openrouter",
      model: "openai/gpt-5.5",
      agentId: "jeffery",
      channel: "telegram",
    });
    expect(out["braintrust.metadata.provider"]).toBe("openrouter");
    expect(out["braintrust.metadata.openclaw.provider"]).toBe("openrouter");
    expect(out["braintrust.metadata.model"]).toBe("openai/gpt-5.5");
    expect(out["braintrust.metadata.openclaw.model"]).toBe("openai/gpt-5.5");
    expect(out["braintrust.metadata.agent_id"]).toBe("jeffery");
    expect(out["braintrust.metadata.openclaw.agent_id"]).toBe("jeffery");
    expect(out["braintrust.metadata.channel"]).toBe("telegram");
    expect(out["braintrust.metadata.openclaw.channel"]).toBe("telegram");
  });

  it("preserves provider prefix on model — Braintrust strips server-side", () => {
    const out = liftNativeMetadata({
      type: "x",
      model: "anthropic/claude-sonnet-4-6",
    });
    expect(out["braintrust.metadata.model"]).toBe(
      "anthropic/claude-sonnet-4-6",
    );
  });

  it("omits absent or empty fields", () => {
    const out = liftNativeMetadata({ type: "x", provider: "", model: "m" });
    expect(out["braintrust.metadata.provider"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.provider"]).toBeUndefined();
    expect(out["braintrust.metadata.model"]).toBe("m");
  });
});

describe("buildVersioningAttrs", () => {
  it("emits all configured versioning fields", () => {
    const out = buildVersioningAttrs({
      ...baseOpts,
      versioning: {
        openclawVersion: "2026.5.20",
        agentPromptVersion: "jeffery-v3",
        toolPolicyVersion: "default-v2",
        runbookVersion: "m1-runbook-2026-05-26",
        environment: "prod",
      },
    });
    expect(out["braintrust.metadata.openclaw_version"]).toBe("2026.5.20");
    expect(out["braintrust.metadata.agent_prompt_version"]).toBe("jeffery-v3");
    expect(out["braintrust.metadata.tool_policy_version"]).toBe("default-v2");
    expect(out["braintrust.metadata.runbook_version"]).toBe(
      "m1-runbook-2026-05-26",
    );
    expect(out["braintrust.metadata.environment"]).toBe("prod");
  });

  it("returns empty when versioning is absent", () => {
    expect(buildVersioningAttrs(baseOpts)).toEqual({});
  });

  it("only emits fields that are set (no empty placeholders)", () => {
    const out = buildVersioningAttrs({
      ...baseOpts,
      versioning: { environment: "dev" },
    });
    expect(out["braintrust.metadata.environment"]).toBe("dev");
    expect(out["braintrust.metadata.openclaw_version"]).toBeUndefined();
    expect(out["braintrust.metadata.agent_prompt_version"]).toBeUndefined();
  });
});

describe("buildModelUsageAttrs", () => {
  it("maps tokens, cost, and provider/model into the attrs object", () => {
    const e: DiagnosticEvent = {
      type: "model.usage",
      provider: "anthropic",
      model: "claude",
      costUsd: 0.0123,
      usage: {
        input: 100,
        output: 50,
        total: 150,
        cacheRead: 10,
        cacheWrite: 5,
      },
    };
    const common = buildCommonAttrs(e, baseOpts);
    const { attrs, conditional } = buildModelUsageAttrs(e, common);
    expect(attrs["braintrust.span_attributes.type"]).toBe("llm");
    expect(attrs["braintrust.metrics.prompt_tokens"]).toBe(100);
    expect(attrs["braintrust.metrics.completion_tokens"]).toBe(50);
    expect(attrs["braintrust.metrics.tokens"]).toBe(150);
    expect(attrs["braintrust.metrics.prompt_cached_tokens"]).toBe(10);
    expect(attrs["braintrust.metrics.prompt_cache_creation_tokens"]).toBe(5);
    expect(attrs["braintrust.metrics.cost"]).toBe(0.0123);
    // provider/model now flow in through `common` via liftNativeMetadata.
    expect(attrs["braintrust.metadata.provider"]).toBe("anthropic");
    expect(attrs["braintrust.metadata.openclaw.provider"]).toBe("anthropic");
    expect(Object.keys(conditional)).toHaveLength(0);
  });

  it("prefers usage.promptTokens over usage.input when both present", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { attrs } = buildModelUsageAttrs(
      { type: "model.usage", usage: { promptTokens: 999, input: 100 } },
      common,
    );
    expect(attrs["braintrust.metrics.prompt_tokens"]).toBe(999);
  });

  it("defaults numeric metrics to 0 when usage is absent", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { attrs } = buildModelUsageAttrs({ type: "model.usage" }, common);
    expect(attrs["braintrust.metrics.prompt_tokens"]).toBe(0);
    expect(attrs["braintrust.metrics.completion_tokens"]).toBe(0);
    expect(attrs["braintrust.metrics.cost"]).toBe(0);
  });

  it("puts last_call deltas into conditional attrs (only when present)", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { conditional } = buildModelUsageAttrs(
      {
        type: "model.usage",
        lastCallUsage: {
          input: 11,
          output: 22,
          total: 33,
          cacheRead: 4,
          cacheWrite: 5,
        },
      },
      common,
    );
    expect(
      conditional["braintrust.metadata.openclaw.last_call.prompt_tokens"],
    ).toBe(11);
    expect(
      conditional["braintrust.metadata.openclaw.last_call.completion_tokens"],
    ).toBe(22);
    expect(conditional["braintrust.metadata.openclaw.last_call.tokens"]).toBe(
      33,
    );
    expect(
      conditional[
        "braintrust.metadata.openclaw.last_call.prompt_cached_tokens"
      ],
    ).toBe(4);
    expect(
      conditional[
        "braintrust.metadata.openclaw.last_call.prompt_cache_creation_tokens"
      ],
    ).toBe(5);
  });

  it("computes context_used_ratio when limit > 0", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { conditional } = buildModelUsageAttrs(
      { type: "model.usage", context: { limit: 200_000, used: 50_000 } },
      common,
    );
    expect(conditional["braintrust.metrics.context_used_ratio"]).toBeCloseTo(
      0.25,
    );
    expect(conditional["braintrust.metadata.openclaw.context_limit"]).toBe(
      200_000,
    );
    expect(conditional["braintrust.metadata.openclaw.context_used"]).toBe(
      50_000,
    );
  });

  it("omits context_used_ratio when limit is 0", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { conditional } = buildModelUsageAttrs(
      { type: "model.usage", context: { limit: 0, used: 50 } },
      common,
    );
    expect(
      conditional["braintrust.metrics.context_used_ratio"],
    ).toBeUndefined();
  });

  it("includes durationMs in conditional; agentId/channel flow via common", () => {
    const e: DiagnosticEvent = {
      type: "model.usage",
      durationMs: 1234,
      agentId: "jeffery",
      channel: "telegram",
    };
    const common = buildCommonAttrs(e, baseOpts);
    const { attrs, conditional } = buildModelUsageAttrs(e, common);
    expect(conditional["braintrust.metadata.openclaw.duration_ms"]).toBe(1234);
    // agentId/channel now flow through common via liftNativeMetadata,
    // not through the per-span conditional path.
    expect(attrs["braintrust.metadata.agent_id"]).toBe("jeffery");
    expect(attrs["braintrust.metadata.openclaw.agent_id"]).toBe("jeffery");
    expect(attrs["braintrust.metadata.channel"]).toBe("telegram");
    expect(attrs["braintrust.metadata.openclaw.channel"]).toBe("telegram");
  });
});

describe("buildContextAssembledAttrs", () => {
  it("maps the full DiagnosticContextAssembledEvent field set", () => {
    const e = evt({
      type: "context.assembled",
      runId: "r1",
      provider: "anthropic",
      model: "claude",
      channel: "telegram",
      trigger: "user",
      messageCount: 12,
      historyTextChars: 4567,
      historyImageBlocks: 2,
      maxMessageTextChars: 8000,
      systemPromptChars: 1234,
      promptChars: 567,
      promptImages: 1,
      contextTokenBudget: 180_000,
      reserveTokens: 8000,
    } as unknown as DiagnosticEventPayload);
    const common = buildCommonAttrs(e, baseOpts);
    const out = buildContextAssembledAttrs(e, common);
    expect(out["braintrust.metadata.openclaw.message_count"]).toBe(12);
    expect(out["braintrust.metadata.openclaw.history_text_chars"]).toBe(4567);
    expect(out["braintrust.metadata.openclaw.history_image_blocks"]).toBe(2);
    expect(out["braintrust.metadata.openclaw.max_message_text_chars"]).toBe(
      8000,
    );
    expect(out["braintrust.metadata.openclaw.system_prompt_chars"]).toBe(1234);
    expect(out["braintrust.metadata.openclaw.prompt_chars"]).toBe(567);
    expect(out["braintrust.metadata.openclaw.prompt_images"]).toBe(1);
    expect(out["braintrust.metadata.openclaw.context_token_budget"]).toBe(
      180_000,
    );
    expect(out["braintrust.metadata.openclaw.reserve_tokens"]).toBe(8000);
    // Lifted via common.
    expect(out["braintrust.metadata.provider"]).toBe("anthropic");
    expect(out["braintrust.metadata.openclaw.provider"]).toBe("anthropic");
  });

  it("defaults numeric fields to 0 when missing", () => {
    const common = buildCommonAttrs({ type: "context.assembled" }, baseOpts);
    const out = buildContextAssembledAttrs(
      { type: "context.assembled" },
      common,
    );
    expect(out["braintrust.metadata.openclaw.message_count"]).toBe(0);
    expect(out["braintrust.metadata.openclaw.history_text_chars"]).toBe(0);
    expect(out["braintrust.metadata.openclaw.reserve_tokens"]).toBe(0);
  });
});

describe("buildModelCallStartedAttrs", () => {
  it("sets type=llm and maps api/transport/budget/upstream-hash", () => {
    const e: DiagnosticEvent = {
      type: "model.call.started",
      provider: "anthropic",
      model: "claude",
      api: "messages",
      transport: "http",
      contextTokenBudget: 180_000,
      upstreamRequestIdHash: "abc123",
    };
    const common = buildCommonAttrs(e, baseOpts);
    const out = buildModelCallStartedAttrs(e, common);
    expect(out["braintrust.span_attributes.type"]).toBe("llm");
    expect(out["braintrust.metadata.provider"]).toBe("anthropic");
    expect(out["braintrust.metadata.openclaw.provider"]).toBe("anthropic");
    expect(out["braintrust.metadata.openclaw.api"]).toBe("messages");
    expect(out["braintrust.metadata.openclaw.transport"]).toBe("http");
    expect(out["braintrust.metadata.openclaw.context_token_budget"]).toBe(
      180_000,
    );
    expect(out["braintrust.metadata.openclaw.upstream_request_id_hash"]).toBe(
      "abc123",
    );
  });
});

describe("buildModelCallCloseAttrs", () => {
  it("includes duration, bytes, ttfb_ms + time_to_first_token mirror", () => {
    const out = buildModelCallCloseAttrs({
      type: "model.call.completed",
      durationMs: 1500,
      requestPayloadBytes: 4096,
      responseStreamBytes: 8192,
      timeToFirstByteMs: 300,
    });
    expect(out["braintrust.metadata.openclaw.duration_ms"]).toBe(1500);
    expect(out["braintrust.metadata.openclaw.request_bytes"]).toBe(4096);
    expect(out["braintrust.metadata.openclaw.response_bytes"]).toBe(8192);
    expect(out["braintrust.metadata.openclaw.ttfb_ms"]).toBe(300);
    // Native top-level metric mirrors the namespaced value.
    expect(out["braintrust.metrics.time_to_first_token"]).toBe(300);
  });

  it("omits time_to_first_token when timeToFirstByteMs is absent", () => {
    const out = buildModelCallCloseAttrs({
      type: "model.call.completed",
      durationMs: 100,
    });
    expect(out["braintrust.metrics.time_to_first_token"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.ttfb_ms"]).toBeUndefined();
  });

  it("adds error_category + failure_kind on model.call.error", () => {
    const out = buildModelCallCloseAttrs({
      type: "model.call.error",
      durationMs: 100,
      errorCategory: "rate_limit",
      failureKind: "transient",
    });
    expect(out["braintrust.metadata.openclaw.error_category"]).toBe(
      "rate_limit",
    );
    expect(out["braintrust.metadata.openclaw.failure_kind"]).toBe("transient");
  });

  it("does not add error fields on completed", () => {
    const out = buildModelCallCloseAttrs({
      type: "model.call.completed",
      durationMs: 100,
    });
    expect(out["braintrust.metadata.openclaw.error_category"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.failure_kind"]).toBeUndefined();
  });
});

describe("buildToolExecutionStartedAttrs", () => {
  it("sets span type=tool and tool_name", () => {
    const common = buildCommonAttrs(
      { type: "tool.execution.started" },
      baseOpts,
    );
    const out = buildToolExecutionStartedAttrs(common, "shell.exec");
    expect(out["braintrust.span_attributes.type"]).toBe("tool");
    expect(out["braintrust.metadata.openclaw.tool_name"]).toBe("shell.exec");
  });
});

describe("buildToolExecutionCloseAttrs", () => {
  it("maps duration on completed", () => {
    const out = buildToolExecutionCloseAttrs({
      type: "tool.execution.completed",
      durationMs: 250,
    });
    expect(out["braintrust.metadata.openclaw.duration_ms"]).toBe(250);
    expect(out["braintrust.metadata.openclaw.error_category"]).toBeUndefined();
  });

  it("adds error_category + error_code on tool.execution.error", () => {
    const out = buildToolExecutionCloseAttrs({
      type: "tool.execution.error",
      durationMs: 50,
      errorCategory: "exec_failed",
      errorCode: "ENOENT",
    });
    expect(out["braintrust.metadata.openclaw.error_category"]).toBe(
      "exec_failed",
    );
    expect(out["braintrust.metadata.openclaw.error_code"]).toBe("ENOENT");
  });

  it("adds blocked_reason on tool.execution.blocked, preferring `reason` over `deniedReason`", () => {
    const out = buildToolExecutionCloseAttrs({
      type: "tool.execution.blocked",
      reason: "policy",
      deniedReason: "fallback",
    });
    expect(out["braintrust.metadata.openclaw.blocked_reason"]).toBe("policy");
  });

  it("falls back to deniedReason when reason is absent", () => {
    const out = buildToolExecutionCloseAttrs({
      type: "tool.execution.blocked",
      deniedReason: "rate-limited",
    });
    expect(out["braintrust.metadata.openclaw.blocked_reason"]).toBe(
      "rate-limited",
    );
  });

  it("defaults blocked_reason to 'blocked' when no source field set", () => {
    const out = buildToolExecutionCloseAttrs({
      type: "tool.execution.blocked",
    });
    expect(out["braintrust.metadata.openclaw.blocked_reason"]).toBe("blocked");
  });
});

describe("buildModelCallIoAttrs", () => {
  function inputSlot(extra: Partial<CallSlot["input"]> = {}): CallSlot {
    return {
      input: {
        runId: "r1",
        prompt: "hi",
        systemPrompt: "you are jeffery",
        historyMessages: [{ role: "user", content: "hello" }],
        imagesCount: 0,
        ...extra,
      },
    };
  }

  it("returns empty when slot is undefined", () => {
    expect(buildModelCallIoAttrs(undefined)).toEqual({});
  });

  it("serializes input as JSON with systemPrompt, prompt, history", () => {
    const out = buildModelCallIoAttrs(inputSlot());
    expect(out["braintrust.input_json"]).toBe(
      JSON.stringify({
        systemPrompt: "you are jeffery",
        prompt: "hi",
        historyMessages: [{ role: "user", content: "hello" }],
      }),
    );
  });

  it("emits metadata.tools when input has a non-empty tools array", () => {
    const out = buildModelCallIoAttrs(
      inputSlot({ tools: [{ name: "shell.exec" }] }),
    );
    expect(out["braintrust.metadata.tools"]).toBe(
      JSON.stringify([{ name: "shell.exec" }]),
    );
  });

  it("omits metadata.tools when tools is empty or absent", () => {
    expect(
      buildModelCallIoAttrs(inputSlot())["braintrust.metadata.tools"],
    ).toBeUndefined();
    expect(
      buildModelCallIoAttrs(inputSlot({ tools: [] }))[
        "braintrust.metadata.tools"
      ],
    ).toBeUndefined();
  });

  it("serializes assistantTexts as output_json", () => {
    const slot: CallSlot = {
      output: {
        runId: "r1",
        assistantTexts: ["sure thing", "here you go"],
      },
    };
    const out = buildModelCallIoAttrs(slot);
    expect(out["braintrust.output_json"]).toBe(
      JSON.stringify(["sure thing", "here you go"]),
    );
  });

  it("emits resolved_ref and harness_id when output has them", () => {
    const slot: CallSlot = {
      output: {
        runId: "r1",
        assistantTexts: ["ok"],
        resolvedRef: "anthropic/claude-sonnet-4-6",
        harnessId: "pi",
      },
    };
    const out = buildModelCallIoAttrs(slot);
    expect(out["braintrust.metadata.openclaw.resolved_ref"]).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(out["braintrust.metadata.openclaw.harness_id"]).toBe("pi");
  });

  it("handles input-only and output-only slots without crashing", () => {
    const inputOnly = buildModelCallIoAttrs(inputSlot());
    expect(inputOnly["braintrust.input_json"]).toBeDefined();
    expect(inputOnly["braintrust.output_json"]).toBeUndefined();

    const outputOnly = buildModelCallIoAttrs({
      output: { runId: "r1", assistantTexts: ["x"] },
    });
    expect(outputOnly["braintrust.input_json"]).toBeUndefined();
    expect(outputOnly["braintrust.output_json"]).toBeDefined();
  });
});

describe("buildToolExecutionIoAttrs", () => {
  function payload(
    extra: Partial<ToolMiddlewarePayload> = {},
  ): ToolMiddlewarePayload {
    return {
      toolCallId: "call-1",
      toolName: "shell.exec",
      args: { cmd: "ls", cwd: "/tmp" },
      result: "file1\nfile2\n",
      isError: false,
      ...extra,
    };
  }

  it("returns empty when payload is undefined", () => {
    expect(buildToolExecutionIoAttrs(undefined)).toEqual({});
  });

  it("serializes args and result as JSON, surfaces tool_call_id + is_error", () => {
    const out = buildToolExecutionIoAttrs(payload());
    expect(out["braintrust.input_json"]).toBe(
      JSON.stringify({ cmd: "ls", cwd: "/tmp" }),
    );
    expect(out["braintrust.output_json"]).toBe(
      JSON.stringify("file1\nfile2\n"),
    );
    expect(out["braintrust.metadata.tool_call_id"]).toBe("call-1");
    expect(out["braintrust.metadata.is_error"]).toBe(false);
  });

  it("emits is_error=true when payload errored", () => {
    const out = buildToolExecutionIoAttrs(payload({ isError: true }));
    expect(out["braintrust.metadata.is_error"]).toBe(true);
  });

  it("omits attrs whose source fields are absent", () => {
    const out = buildToolExecutionIoAttrs({
      toolCallId: "call-1",
      toolName: "x",
    });
    expect(out["braintrust.input_json"]).toBeUndefined();
    expect(out["braintrust.output_json"]).toBeUndefined();
    expect(out["braintrust.metadata.is_error"]).toBeUndefined();
    expect(out["braintrust.metadata.tool_call_id"]).toBe("call-1");
  });

  it("serializes complex args/result structures", () => {
    const out = buildToolExecutionIoAttrs(
      payload({
        args: { a: 1, nested: { b: [2, 3] } },
        result: { ok: true, items: ["x", "y"] },
      }),
    );
    expect(JSON.parse(out["braintrust.input_json"] as string)).toEqual({
      a: 1,
      nested: { b: [2, 3] },
    });
    expect(JSON.parse(out["braintrust.output_json"] as string)).toEqual({
      ok: true,
      items: ["x", "y"],
    });
  });
});

describe("buildRunIoAttrs", () => {
  it("returns empty when both inputs are absent", () => {
    expect(buildRunIoAttrs({})).toEqual({});
  });

  it("emits braintrust.input from firstInput.prompt", () => {
    const out = buildRunIoAttrs({
      firstInput: {
        runId: "r1",
        prompt: "what is the weather",
        historyMessages: [],
        imagesCount: 0,
      },
    });
    expect(out["braintrust.input"]).toBe("what is the weather");
  });

  it("joins lastOutput.assistantTexts into braintrust.output with newlines", () => {
    const out = buildRunIoAttrs({
      lastOutput: {
        runId: "r1",
        assistantTexts: ["sunny", "75 degrees"],
      },
    });
    expect(out["braintrust.output"]).toBe("sunny\n75 degrees");
  });

  it("omits braintrust.output when assistantTexts is empty", () => {
    const out = buildRunIoAttrs({
      lastOutput: { runId: "r1", assistantTexts: [] },
    });
    expect(out["braintrust.output"]).toBeUndefined();
  });

  it("emits both input and output when both peeked", () => {
    const out = buildRunIoAttrs({
      firstInput: {
        runId: "r1",
        prompt: "ping",
        historyMessages: [],
        imagesCount: 0,
      },
      lastOutput: { runId: "r1", assistantTexts: ["pong"] },
    });
    expect(out["braintrust.input"]).toBe("ping");
    expect(out["braintrust.output"]).toBe("pong");
  });
});

describe("buildCommonAttrs — integration", () => {
  it("merges tags, service_name, versioning, session hashes, and native lift", () => {
    const opts: CommonAttrOptions = {
      ...baseOpts,
      versioning: {
        openclawVersion: "2026.5.20",
        agentPromptVersion: "v3",
        environment: "prod",
      },
    };
    const e: DiagnosticEvent = {
      type: "model.call.started",
      sessionKey: "sk",
      provider: "openrouter",
      model: "openai/gpt-5.5",
      agentId: "jeffery",
      channel: "telegram",
    };
    const out = buildCommonAttrs(e, opts);
    expect(out["braintrust.tags"]).toEqual(["agent-test"]);
    expect(out["braintrust.metadata.service_name"]).toBe("openclaw-test");
    expect(out["braintrust.metadata.openclaw_version"]).toBe("2026.5.20");
    expect(out["braintrust.metadata.agent_prompt_version"]).toBe("v3");
    expect(out["braintrust.metadata.environment"]).toBe("prod");
    expect(out["braintrust.metadata.openclaw.session_key_hash"]).toMatch(
      /^[0-9a-f]{16}$/,
    );
    expect(out["braintrust.metadata.provider"]).toBe("openrouter");
    expect(out["braintrust.metadata.openclaw.provider"]).toBe("openrouter");
    expect(out["braintrust.metadata.model"]).toBe("openai/gpt-5.5");
    expect(out["braintrust.metadata.agent_id"]).toBe("jeffery");
    expect(out["braintrust.metadata.channel"]).toBe("telegram");
  });
});
