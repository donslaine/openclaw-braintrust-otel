import { describe, expect, it } from "vitest";
import type { DiagnosticEventPayload } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  buildCommonAttrs,
  buildContextAssembledAttrs,
  buildModelCallCloseAttrs,
  buildModelCallStartedAttrs,
  buildModelUsageAttrs,
  buildRunAttrs,
  buildSessionAttrs,
  buildToolExecutionCloseAttrs,
  buildToolExecutionStartedAttrs,
  hashId,
  type CommonAttrOptions,
  type DiagnosticEvent,
} from "../attrs.js";

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
  it("maps string fields with snake_case rename for sessionKind", () => {
    const common = buildCommonAttrs({ type: "run.started" }, baseOpts);
    const e = evt({
      type: "run.started",
      runId: "r1",
      channel: "telegram",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      trigger: "user",
    } as unknown as DiagnosticEventPayload);
    // agent / sessionKind are non-standard on run.started — pass via the
    // structural shape to verify our mapper picks them up.
    const eExtra: DiagnosticEvent = {
      ...e,
      agent: "jeffery",
      sessionKind: "direct",
    };
    const out = buildRunAttrs(eExtra, common);
    expect(out["braintrust.metadata.openclaw.channel"]).toBe("telegram");
    expect(out["braintrust.metadata.openclaw.provider"]).toBe("anthropic");
    expect(out["braintrust.metadata.openclaw.model"]).toBe("claude-sonnet-4-6");
    expect(out["braintrust.metadata.openclaw.trigger"]).toBe("user");
    expect(out["braintrust.metadata.openclaw.agent"]).toBe("jeffery");
    expect(out["braintrust.metadata.openclaw.session_kind"]).toBe("direct");
  });

  it("omits string fields that are missing or empty", () => {
    const common = buildCommonAttrs({ type: "run.started" }, baseOpts);
    const out = buildRunAttrs(
      { type: "run.started", runId: "r1", provider: "" },
      common,
    );
    expect(out["braintrust.metadata.openclaw.provider"]).toBeUndefined();
    expect(out["braintrust.metadata.openclaw.channel"]).toBeUndefined();
  });
});

describe("buildModelUsageAttrs", () => {
  it("maps tokens, cost, and provider/model into the attrs object", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { attrs, conditional } = buildModelUsageAttrs(
      {
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
      },
      common,
    );
    expect(attrs["braintrust.span_attributes.type"]).toBe("llm");
    expect(attrs["braintrust.metrics.prompt_tokens"]).toBe(100);
    expect(attrs["braintrust.metrics.completion_tokens"]).toBe(50);
    expect(attrs["braintrust.metrics.tokens"]).toBe(150);
    expect(attrs["braintrust.metrics.prompt_cached_tokens"]).toBe(10);
    expect(attrs["braintrust.metrics.prompt_cache_creation_tokens"]).toBe(5);
    expect(attrs["braintrust.metrics.cost"]).toBe(0.0123);
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

  it("includes durationMs, agentId, channel when present", () => {
    const common = buildCommonAttrs({ type: "model.usage" }, baseOpts);
    const { conditional } = buildModelUsageAttrs(
      {
        type: "model.usage",
        durationMs: 1234,
        agentId: "jeffery",
        channel: "telegram",
      },
      common,
    );
    expect(conditional["braintrust.metadata.openclaw.duration_ms"]).toBe(1234);
    expect(conditional["braintrust.metadata.openclaw.agent_id"]).toBe(
      "jeffery",
    );
    expect(conditional["braintrust.metadata.openclaw.channel"]).toBe(
      "telegram",
    );
  });
});

describe("buildContextAssembledAttrs", () => {
  it("maps the full DiagnosticContextAssembledEvent field set", () => {
    const common = buildCommonAttrs({ type: "context.assembled" }, baseOpts);
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
  it("maps provider/model/api/transport/budget/upstream-hash", () => {
    const common = buildCommonAttrs({ type: "model.call.started" }, baseOpts);
    const out = buildModelCallStartedAttrs(
      {
        type: "model.call.started",
        provider: "anthropic",
        model: "claude",
        api: "messages",
        transport: "http",
        contextTokenBudget: 180_000,
        upstreamRequestIdHash: "abc123",
      },
      common,
    );
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
  it("includes duration always and bytes/ttfb when present", () => {
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
