// Pure attribute-building functions for each event type.
//
// Kept free of OTEL SDK calls so they can be unit-tested in isolation.
// service.ts wires these into Span lifecycle.

import { createHash } from "node:crypto";
import type {
  LlmInputPayload,
  LlmOutputPayload,
  ToolMiddlewarePayload,
} from "./io-buffer.js";

export type DiagnosticEvent = { type: string; [k: string]: unknown };

export type SessionIdOptions = {
  raw: boolean;
  hash: boolean;
};

// Operator-supplied versioning labels. Travel on every span as
// top-level `braintrust.metadata.*` so promoted dataset examples carry
// them automatically and experiment views can slice by them.
//
// `openclawVersion` is read once at startup from the resolved openclaw
// package.json; the rest come from plugin config (THE-47).
export type VersioningOptions = {
  openclawVersion?: string;
  agentPromptVersion?: string;
  toolPolicyVersion?: string;
  runbookVersion?: string;
  environment?: string;
};

export type CommonAttrOptions = {
  tags: string[];
  serviceName: string;
  sessIds: SessionIdOptions;
  salt: string;
  versioning?: VersioningOptions;
};

export type AttrValue = string | number | boolean | string[];
export type AttrMap = Record<string, AttrValue>;

export function hashId(salt: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return createHash("sha256")
    .update(salt)
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

export function buildSessionAttrs(
  e: DiagnosticEvent,
  opts: CommonAttrOptions,
): AttrMap {
  const out: AttrMap = {};
  const sessionKey = e["sessionKey"] as string | undefined;
  const sessionId = e["sessionId"] as string | undefined;
  const runId = e["runId"] as string | undefined;
  if (opts.sessIds.hash) {
    const skh = hashId(opts.salt, sessionKey);
    const sih = hashId(opts.salt, sessionId);
    const rih = hashId(opts.salt, runId);
    if (skh) out["braintrust.metadata.openclaw.session_key_hash"] = skh;
    if (sih) out["braintrust.metadata.openclaw.session_id_hash"] = sih;
    if (rih) out["braintrust.metadata.openclaw.run_id_hash"] = rih;
  }
  if (opts.sessIds.raw) {
    if (sessionKey)
      out["braintrust.metadata.openclaw.session_key"] = sessionKey;
    if (sessionId) out["braintrust.metadata.openclaw.session_id"] = sessionId;
    if (runId) out["braintrust.metadata.openclaw.run_id"] = runId;
  }
  return out;
}

// Lift native metadata Braintrust's UI auto-recognizes (model, provider,
// agent_id, channel) from the event payload to top-level
// `braintrust.metadata.*`. Also emits namespaced copies under
// `braintrust.metadata.openclaw.*` so our own slicing keeps working
// during the transition.
//
// `model` is passed through with provider prefix intact; Braintrust
// strips the prefix server-side for column display.
export function liftNativeMetadata(e: DiagnosticEvent): AttrMap {
  const out: AttrMap = {};
  const fields: Array<[string, string]> = [
    ["provider", "provider"],
    ["model", "model"],
    ["agentId", "agent_id"],
    ["channel", "channel"],
  ];
  for (const [src, dst] of fields) {
    const v = e[src];
    if (typeof v === "string" && v) {
      out[`braintrust.metadata.${dst}`] = v;
      out[`braintrust.metadata.openclaw.${dst}`] = v;
    }
  }
  return out;
}

// Versioning labels pulled from the configured options. Travel on every
// span so any promoted dataset example carries them.
export function buildVersioningAttrs(opts: CommonAttrOptions): AttrMap {
  const out: AttrMap = {};
  const v = opts.versioning;
  if (!v) return out;
  if (v.openclawVersion)
    out["braintrust.metadata.openclaw_version"] = v.openclawVersion;
  if (v.agentPromptVersion)
    out["braintrust.metadata.agent_prompt_version"] = v.agentPromptVersion;
  if (v.toolPolicyVersion)
    out["braintrust.metadata.tool_policy_version"] = v.toolPolicyVersion;
  if (v.runbookVersion)
    out["braintrust.metadata.runbook_version"] = v.runbookVersion;
  if (v.environment) out["braintrust.metadata.environment"] = v.environment;
  return out;
}

// Attributes that should appear on EVERY span we emit, so any span is
// filterable by tag / service_name in BTQL. Braintrust auto-maps
// braintrust.tags and braintrust.metadata.* only on spans that set them
// explicitly — there is no inheritance from parents.
export function buildCommonAttrs(
  e: DiagnosticEvent,
  opts: CommonAttrOptions,
): AttrMap {
  return {
    "braintrust.tags": opts.tags,
    "braintrust.metadata.service_name": opts.serviceName,
    ...buildVersioningAttrs(opts),
    ...buildSessionAttrs(e, opts),
    ...liftNativeMetadata(e),
  };
}

export function buildRunAttrs(e: DiagnosticEvent, common: AttrMap): AttrMap {
  const attrs: AttrMap = {
    ...common,
    "braintrust.span_attributes.type": "task",
  };
  const stringFields: Array<[string, string]> = [
    ["trigger", "trigger"],
    ["agent", "agent"],
    ["sessionKind", "session_kind"],
  ];
  for (const [src, dst] of stringFields) {
    const v = e[src];
    if (typeof v === "string" && v) {
      attrs[`braintrust.metadata.openclaw.${dst}`] = v;
    }
  }
  return attrs;
}

// Run-level input/output derived from the first llm_input.prompt and
// the last llm_output.assistantTexts. Applied on run-close (peeked
// non-consumingly so per-call slots remain available to model.call
// spans). When no LLM I/O was captured for the run, returns empty.
export function buildRunIoAttrs(io: {
  firstInput?: LlmInputPayload;
  lastOutput?: LlmOutputPayload;
}): AttrMap {
  const out: AttrMap = {};
  if (io.firstInput?.prompt) {
    out["braintrust.input"] = io.firstInput.prompt;
  }
  if (io.lastOutput && io.lastOutput.assistantTexts.length > 0) {
    out["braintrust.output"] = io.lastOutput.assistantTexts.join("\n");
  }
  return out;
}

export type ModelUsageMetrics = {
  attrs: AttrMap;
  // Conditional attributes that should only be set if their source value is
  // present. Kept separate from `attrs` because OTEL setAttribute is
  // semantically different from passing an attribute at span-creation
  // time (Braintrust treats missing != 0 for some metrics).
  conditional: AttrMap;
};

export function buildModelUsageAttrs(
  e: DiagnosticEvent,
  common: AttrMap,
): ModelUsageMetrics {
  const usage = (e["usage"] ?? {}) as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  const lastCall = (e["lastCallUsage"] ?? {}) as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  const contextInfo = (e["context"] ?? {}) as {
    limit?: number;
    used?: number;
  };

  const attrs: AttrMap = {
    ...common,
    "braintrust.span_attributes.type": "llm",
    // Token metrics. Source -> braintrust mapping:
    //   usage.input      -> prompt_tokens (or promptTokens if present)
    //   usage.output     -> completion_tokens
    //   usage.total      -> tokens (total)
    //   usage.cacheRead  -> prompt_cached_tokens
    //   usage.cacheWrite -> prompt_cache_creation_tokens
    "braintrust.metrics.prompt_tokens": usage.promptTokens ?? usage.input ?? 0,
    "braintrust.metrics.completion_tokens": usage.output ?? 0,
    "braintrust.metrics.tokens": usage.total ?? 0,
    "braintrust.metrics.prompt_cached_tokens": usage.cacheRead ?? 0,
    "braintrust.metrics.prompt_cache_creation_tokens": usage.cacheWrite ?? 0,
    "braintrust.metrics.cost": (e["costUsd"] as number) ?? 0,
  };

  const conditional: AttrMap = {};
  if (lastCall.input !== undefined)
    conditional["braintrust.metadata.openclaw.last_call.prompt_tokens"] =
      lastCall.input;
  if (lastCall.output !== undefined)
    conditional["braintrust.metadata.openclaw.last_call.completion_tokens"] =
      lastCall.output;
  if (lastCall.total !== undefined)
    conditional["braintrust.metadata.openclaw.last_call.tokens"] =
      lastCall.total;
  if (lastCall.cacheRead !== undefined)
    conditional["braintrust.metadata.openclaw.last_call.prompt_cached_tokens"] =
      lastCall.cacheRead;
  if (lastCall.cacheWrite !== undefined)
    conditional[
      "braintrust.metadata.openclaw.last_call.prompt_cache_creation_tokens"
    ] = lastCall.cacheWrite;
  if (contextInfo.limit !== undefined)
    conditional["braintrust.metadata.openclaw.context_limit"] =
      contextInfo.limit;
  if (contextInfo.used !== undefined)
    conditional["braintrust.metadata.openclaw.context_used"] = contextInfo.used;
  if (
    contextInfo.limit !== undefined &&
    contextInfo.used !== undefined &&
    contextInfo.limit > 0
  ) {
    conditional["braintrust.metrics.context_used_ratio"] =
      contextInfo.used / contextInfo.limit;
  }
  if (typeof e["durationMs"] === "number")
    conditional["braintrust.metadata.openclaw.duration_ms"] = e[
      "durationMs"
    ] as number;

  return { attrs, conditional };
}

export function buildContextAssembledAttrs(
  e: DiagnosticEvent,
  common: AttrMap,
): AttrMap {
  return {
    ...common,
    "braintrust.metadata.openclaw.trigger": (e["trigger"] as string) ?? "",
    "braintrust.metadata.openclaw.message_count":
      (e["messageCount"] as number) ?? 0,
    "braintrust.metadata.openclaw.history_text_chars":
      (e["historyTextChars"] as number) ?? 0,
    "braintrust.metadata.openclaw.history_image_blocks":
      (e["historyImageBlocks"] as number) ?? 0,
    "braintrust.metadata.openclaw.max_message_text_chars":
      (e["maxMessageTextChars"] as number) ?? 0,
    "braintrust.metadata.openclaw.system_prompt_chars":
      (e["systemPromptChars"] as number) ?? 0,
    "braintrust.metadata.openclaw.prompt_chars":
      (e["promptChars"] as number) ?? 0,
    "braintrust.metadata.openclaw.prompt_images":
      (e["promptImages"] as number) ?? 0,
    "braintrust.metadata.openclaw.context_token_budget":
      (e["contextTokenBudget"] as number) ?? 0,
    "braintrust.metadata.openclaw.reserve_tokens":
      (e["reserveTokens"] as number) ?? 0,
  };
}

export function buildModelCallStartedAttrs(
  e: DiagnosticEvent,
  common: AttrMap,
): AttrMap {
  return {
    ...common,
    "braintrust.span_attributes.type": "llm",
    "braintrust.metadata.openclaw.api": (e["api"] as string) ?? "",
    "braintrust.metadata.openclaw.transport": (e["transport"] as string) ?? "",
    "braintrust.metadata.openclaw.context_token_budget":
      (e["contextTokenBudget"] as number) ?? 0,
    "braintrust.metadata.openclaw.upstream_request_id_hash":
      (e["upstreamRequestIdHash"] as string) ?? "",
  };
}

// Attributes set on completion/error of an in-flight model.call span.
export function buildModelCallCloseAttrs(e: DiagnosticEvent): AttrMap {
  const out: AttrMap = {
    "braintrust.metadata.openclaw.duration_ms":
      (e["durationMs"] as number) ?? 0,
  };
  if (e["requestPayloadBytes"] !== undefined)
    out["braintrust.metadata.openclaw.request_bytes"] = e[
      "requestPayloadBytes"
    ] as number;
  if (e["responseStreamBytes"] !== undefined)
    out["braintrust.metadata.openclaw.response_bytes"] = e[
      "responseStreamBytes"
    ] as number;
  if (e["timeToFirstByteMs"] !== undefined) {
    const ttfb = e["timeToFirstByteMs"] as number;
    out["braintrust.metadata.openclaw.ttfb_ms"] = ttfb;
    // Top-level native metric so Braintrust's TTFT column populates.
    out["braintrust.metrics.time_to_first_token"] = ttfb;
  }
  // upstreamRequestIdHash lives on the `model_call_ended` typed hook
  // (not on started). Surface it at close-time so the metadata column
  // populates regardless of which hook fired first.
  if (typeof e["upstreamRequestIdHash"] === "string")
    out["braintrust.metadata.openclaw.upstream_request_id_hash"] = e[
      "upstreamRequestIdHash"
    ] as string;
  if (e.type === "model.call.error") {
    out["braintrust.metadata.openclaw.error_category"] =
      (e["errorCategory"] as string) ?? "";
    if (e["failureKind"] !== undefined)
      out["braintrust.metadata.openclaw.failure_kind"] = e[
        "failureKind"
      ] as string;
  }
  return out;
}

export function buildToolExecutionStartedAttrs(
  common: AttrMap,
  toolName: string,
): AttrMap {
  return {
    ...common,
    "braintrust.span_attributes.type": "tool",
    "braintrust.metadata.openclaw.tool_name": toolName,
  };
}

export function buildToolExecutionCloseAttrs(e: DiagnosticEvent): AttrMap {
  const out: AttrMap = {};
  if (e["durationMs"] !== undefined)
    out["braintrust.metadata.openclaw.duration_ms"] = e["durationMs"] as number;
  if (e.type === "tool.execution.error") {
    out["braintrust.metadata.openclaw.error_category"] =
      (e["errorCategory"] as string) ?? "";
    if (e["errorCode"] !== undefined)
      out["braintrust.metadata.openclaw.error_code"] = e["errorCode"] as string;
  } else if (e.type === "tool.execution.blocked") {
    out["braintrust.metadata.openclaw.blocked_reason"] =
      (e["reason"] as string) ?? (e["deniedReason"] as string) ?? "blocked";
  }
  return out;
}

// I/O attributes for a closed tool.execution span. Reads a payload
// popped from the IoBuffer's tool-middleware registry. args/result
// serialized as JSON; tool_call_id and is_error surface as metadata.
export function buildToolExecutionIoAttrs(
  payload: ToolMiddlewarePayload | undefined,
): AttrMap {
  const out: AttrMap = {};
  if (!payload) return out;
  if (payload.args !== undefined) {
    out["braintrust.input_json"] = JSON.stringify(payload.args);
  }
  if (payload.result !== undefined) {
    out["braintrust.output_json"] = JSON.stringify(payload.result);
  }
  if (payload.toolCallId) {
    out["braintrust.metadata.tool_call_id"] = payload.toolCallId;
  }
  if (payload.isError !== undefined) {
    out["braintrust.metadata.is_error"] = payload.isError;
  }
  return out;
}
