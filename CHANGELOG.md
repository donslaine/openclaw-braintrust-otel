# Changelog

## 0.4.1 — 2026-06-03

Per-tool reasoning capture via `before_message_write` hook.

### Fixed

- **Per-tool reasoning now actually works.** The 0.4.0 implementation attempted to extract thinking blocks from the `llm_output` hook's `lastAssistant` field, but `llm_output` fires once per attempt after all turns complete — carrying only the final text-only response. Intermediate assistant messages (with thinking + tool call blocks) were never surfaced. The extraction always returned `{}`.

  The fix uses the `before_message_write` hook instead. This hook fires synchronously with the full `AgentMessage` — including `ThinkingContent` blocks — before the message is written to the session transcript, which is before `before_tool_call` dispatches tools. Per-tool reasoning is now keyed by `sessionKey` + `toolCallId` and correctly scoped to the thinking that preceded each specific tool call.

  Requires `captureContent: { enabled: true }` in plugin config. Verified against openclaw v2026.5.20 on the `pi` embedded runner (gateway/API-triggered runs). No `allowConversationAccess` required — `before_message_write` is not in `CONVERSATION_HOOK_NAMES`.

### Changed

- Removed dead `setPendingAssistantMessage` / `extractToolRationale` calls from the `llm_output` and `before_tool_call` handlers. The underlying IoBuffer methods are retained for future use if OpenClaw ever fires `llm_output` per turn.

## 0.4.0 — 2026-06-02

Eval-readiness pass: tool reasoning capture, heuristic scores, span-type fixes, and OTel gen_ai alignment.

### Added

- **Tool reasoning capture.** `openclaw.tool.execution` spans now carry the model's reasoning for each tool call when `captureContent.enabled = true`:
  - `braintrust.metadata.openclaw.tool_rationale` — text blocks from the assistant message that preceded the tool call (the model's stated intent, e.g. "I need to check the config before making changes").
  - `braintrust.metadata.openclaw.tool_thinking` — extended thinking / scratchpad content (Anthropic extended thinking feature) when present and not redacted.
  - `braintrust.metadata.openclaw.tool_thinking_redacted` — `true` when thinking was present but redacted by the provider.

  Reasoning is extracted from the `llm_output` hook's `lastAssistant` message by finding the `toolCall` content block matching each call's `toolCallId`, then collecting text/thinking blocks between the preceding toolCall and this one. The scoping is per-call (not per-turn), so parallel tool calls each get only the reasoning that directly precedes them.

- **Heuristic `braintrust.scores` on tool spans.** Every `openclaw.tool.execution` span now emits binary scores visible in Braintrust's Scores column:
  - `braintrust.scores.tool_success` — `1` on `tool.execution.completed`, `0` on error or blocked.
  - `braintrust.scores.tool_blocked` — `1` on `tool.execution.blocked`, `0` otherwise.

  These require no LLM judge and are always present (not gated by `captureContent`). Useful for tracking tool success rate and blocked rate over time, and as regression baselines (e.g. "blocked rate rose from 2% to 8% after a policy change").

- **`gen_ai.request.model` alias on LLM spans.** `openclaw.model.call` and `openclaw.model.usage` spans now emit `gen_ai.request.model` alongside the existing `braintrust.metadata.model`, making spans compatible with downstream OTEL processors that follow OTel gen_ai semantic conventions.

- **`tool_call_id` unconditional on tool spans.** `braintrust.metadata.tool_call_id` is now set at span-start time from the `tool.execution.started` event, so it is always present regardless of whether `captureContent` is enabled. Previously it only landed via the IoBuffer payload (captureContent-gated).

- **`thread_id` and `turn_id` on tool spans.** `braintrust.metadata.openclaw.thread_id` and `turn_id` are now always recorded by the IoBuffer (identity fields, not content) and surface on `openclaw.tool.execution` spans when `captureContent` is on. Previously these fields were fully gated and never appeared.

### Fixed

- **`openclaw.context.assembled` span type.** This span was previously emitted with no `braintrust.span_attributes.type`, making it invisible to Braintrust's span-type filters. It now sets `type = "function"` (Braintrust's named-logic-block type).

### Changed

- **IoBuffer content-capture gate split.** `recordToolBefore` and `recordToolAfter` no longer early-return when `enabled = false`. Identity fields (`toolName`, `threadId`, `turnId`, `isError`, `durationMs`) are always recorded regardless of the `captureContent` setting. Only `args` and `result` remain gated. This makes `threadId`/`turnId` available on tool spans even on deployments where content capture is off.

### Tests

- 85 → 103. New coverage: `context.assembled` span type, `gen_ai.request.model` on model call and usage spans, tool score heuristics (completed / error / blocked), IoBuffer identity-vs-content gate split, full `setPendingAssistantMessage` + `extractToolRationale` suite (10 cases including multi-tool scoping, redacted thinking, disabled gate, clearRun cleanup).

## 0.3.2 — 2026-05-29

Default flip for session-identifier hashing.

### Changed

- **`sessionIdentifiers` defaults flipped: raw by default, hash opt-in.**

  | Field | ≤ v0.3.1 default | v0.3.2 default |
  | -- | -- | -- |
  | `sessionKey` | hashed (`session_key_hash`) | raw (`session_key`) |
  | `sessionId` | hashed (`session_id_hash`) | raw (`session_id`) |
  | `runId` | hashed (`run_id_hash`) | raw (`run_id`) |

  `sessionId` and `runId` are openclaw-internal opaque UUIDs with no identifying content — hashing them added trace ↔ container-log correlation friction with no real protection. `sessionKey` carries channel-native PII (Telegram chat IDs, phone numbers, Discord user IDs) and SHOULD be hashed on client-facing deployments; for internal/admin-only Braintrust (e.g. Jeffery) raw is acceptable and easier to work with. Set `sessionIdentifiers.hash: true` (and configure `BRAINTRUST_SESSION_HASH_SALT`) to restore the prior hashing behavior.

### Migration impact

- Existing Braintrust dashboards / saved queries filtering on `braintrust.metadata.openclaw.session_id_hash`, `session_key_hash`, or `run_id_hash` will return nothing for new traces. Switch filters to `session_id`, `session_key`, `run_id`. Previous trace history retains the hashed columns; the cutover is forward-only.
- Client-facing deployments must explicitly set `sessionIdentifiers: { raw: false, hash: true }` and configure the salt secret. Do not upgrade to v0.3.2 on a client-facing gateway without that config change.

## 0.3.1 — 2026-05-29

Hotfix for tool-I/O capture, broken since v0.2.1.

### Fixed

- **`before_tool_call` / `after_tool_call` handlers read `runId` from the wrong place.** Per the openclaw hook contract (`src/plugins/hook-types.ts:450-471, 500-508`), `runId` lives on the payload, not the ctx. v0.2.1 and v0.3.0 read `ctx.runId` only — always undefined — so every tool I/O payload was silently dropped at the IoBuffer's `if (!runId) return` guard, and every `openclaw.tool.execution` span landed without `braintrust.input_json` / `braintrust.output_json` despite `captureContent.enabled = true`. v0.3.1 reads `payload.runId` first, falls back to `ctx.runId`. Extracted as `resolveHookRunId` with regression-test coverage.

## 0.3.0 — 2026-05-28

Fixes a structural attribution bug in v0.2.x and a long-standing parenting bug in `model.usage`. Both diagnosed via a static read of openclaw `main` (e205888fa7) — see THE-54.

### Fixed

- **Per-call LLM I/O was a category error.** v0.2.x attached `braintrust.input_json` / `braintrust.output_json` to `openclaw.model.call` spans, sourced from `llm_input` / `llm_output` typed hooks paired by "next open slot per runId." But those hooks are **turn-level**: they fire once per turn while `model.call.*` lifecycle events fire once per model call (a turn can contain main + compaction + tool-result-shortcut + retry calls). On every multi-call turn, N-1 of the N model.call spans landed with empty content. Live traces showed turn-1 call-A with input but call-B with nothing. v0.3.0 removes the per-call attributes entirely; LLM content lives only on the run span where the data accurately supports it.
- **`openclaw.model.call` source migrated to typed hooks.** v0.2.x built the span from bus `model.call.started`/`completed`/`error` events. v0.3.0 builds it from the per-call typed hooks `model_call_started` / `model_call_ended` (`src/plugins/hook-types.ts:74-75, 238-266`), which carry a stable `callId` 1:1 with each model call. Bus `model.call.*` events are now ignored.
- **`model.usage` parenting (three compounding bugs).** Production traces consistently showed `parents: []` on usage spans despite the v0.2.x session registry workaround. Root causes:
  1. **Race.** `model_call_ended` cleared the registry synchronously; `model.usage` arrived asynchronously through the bus. Trailing usage always found an empty registry.
  2. **Key mismatch.** Usage events inconsistently populate `sessionKey` vs `sessionId`. Registry was indexed under one; lookup by the other silently missed.
  3. **No fallback when the call never opened.** Some usage events arrive outside any model.call window (e.g., aggregate-only emission paths).
  Fixes: 5 s post-close TTL on registry entries, dual-key indexing under both `sessionKey` and `sessionId`, and a new `openRunBySession` backstop populated on `run.started` so usage parents to the run when no model.call match exists. The fully-orphan case should now be rare.

### Changed

- **IoBuffer** drops the per-call `CallSlot` machinery (`takeCallIo`, `maxCallsPerRun`, paired-slot logic, `buildModelCallIoAttrs`). Run-level `firstInput` / `lastOutput` snapshots retained for run-span attribution. Tool I/O merging by `toolCallId` unchanged.
- **IoBuffer constructor** accepts `openModelCallTtlMs` (default 5000) and `now` (clock injection) for testable TTL behavior.
- **Plugin entry** registers `model_call_started` and `model_call_ended` hooks via `api.on(...)` and dispatches them through a `routerRef` the service populates at `start()` and clears at `stop()`.

### Migration from 0.2.x

- **Span shape change.** `braintrust.input_json` / `braintrust.output_json` no longer appear on `openclaw.model.call` spans. The data wasn't real at that granularity. Run-level `braintrust.input` / `braintrust.output` (on `openclaw.run`) remain and are the canonical LLM I/O surface. Eval datasets promoting from production traces should switch to reading the run span.
- **Config schema unchanged.** Existing `captureContent.enabled = true` configs continue to work; their effect on the run span is unchanged.
- **`hooks.allowConversationAccess: true` still required** for run-level LLM I/O — same gate as v0.2.1.

### Tests

- 87 → 81. Removed per-call I/O tests and pairing tests (functions deleted). Added TTL-race, key-mismatch, and run-backstop tests for usage parenting. Integration test rewritten to drive `model_call_started` / `model_call_ended` via the hook entrypoints rather than bus events.

## 0.2.1 — 2026-05-28

Hotfix for activation + hook-registration issues discovered during the v0.2.0 deployment on Jeffery. The plugin was registered and reported its version, but `register()` and `service.start()` never ran on OpenClaw 2026.5.20 due to two distinct issues. Both fixed here.

### Fixed

- **Plugin activation at gateway startup.** OpenClaw 2026.5.20's gateway-startup planner only includes plugins that either (a) declare `manifest.activation.onCapabilities` includes `"hook"`, or (b) have an operator-side `plugins.entries.<id>.hooks.allowConversationAccess: true` config grant. v0.2.0's manifest had neither, so the plugin was loaded into the registry but skipped at gateway boot — `register()` and `service.start()` were never invoked. v0.2.1's manifest declares `activation.onCapabilities: ["hook"]` so the plugin self-qualifies for startup. Operators still need `hooks.allowConversationAccess: true` to grant `llm_input` / `llm_output` access at the per-hook level (see Operator action required, below).
- **Hook registration API.** v0.2.0 used `api.registerHook(name, handler)` to subscribe to `llm_input` / `llm_output`. That API is for the legacy single-arg internal-hook system (`session-memory`, `command-logger`, etc.) — completely separate from the typed plugin hooks (`llm_input`, `llm_output`, `before_tool_call`, etc.). The correct API for typed hooks is `api.on(name, handler)`. v0.2.1 uses `api.on(...)` throughout. Without this fix, the hook subscriptions silently did nothing even in environments where the activation gate would have passed.

### Changed

- **Tool I/O capture migrated from `AgentToolResultMiddleware` to public `before_tool_call` + `after_tool_call` hooks.** `AgentToolResultMiddleware` is not in the public typed-hook documentation; `before_tool_call` (args) and `after_tool_call` (results) are. No conversation-access permission required for tool hooks. IoBuffer gains `recordToolBefore(...)` and `recordToolAfter(...)` that merge partial payloads by `toolCallId` at consume time. `recordToolResult(...)` kept for back-compat through this release.
- **Manifest polish.** Added `name` and `description` to `openclaw.plugin.json` so they show up in `openclaw plugins list` (previously only set via `definePluginEntry` in code).

### Operator action required

For full eval-grade capture (the `braintrust.input_json` / `braintrust.output_json` columns Braintrust uses for dataset promotion), the operator must add a `hooks` block to the plugin entry in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "braintrust-otel": {
        "hooks": { "allowConversationAccess": true },
        "config": { "captureContent": { "enabled": true }, ... }
      }
    }
  }
}
```

Without `allowConversationAccess: true`, the plugin starts and emits trace lifecycle spans, but `llm_input` / `llm_output` payloads are gated by the runtime as conversation-content access — those specific hook subscriptions get dropped. Tool I/O capture (`before_tool_call` / `after_tool_call`) does NOT require this grant.

See M1 Runbook §7A and the README "Eval-grade capture" section for the full config example.

### Tests

- 82 → 87. New coverage for `recordToolBefore` / `recordToolAfter` merging, out-of-order arrival, before-only, after-only, and legacy `recordToolResult` back-compat. Integration test updated to exercise the two-phase tool capture flow.

## 0.2.0 — 2026-05-27

Eval-readiness release. Traces become promotable to Braintrust eval datasets when `captureContent.enabled = true`. Adds versioning metadata so dataset examples carry the prompt / tool-policy / runbook / environment that produced them.

### Added

- **Plugin SDK hook subscriptions** — registers `llm_input`, `llm_output`, and `AgentToolResultMiddleware` to capture LLM prompts, assistant outputs, tool args, and tool results. Payloads are correlated by `runId` and joined to the matching span at close time.
- **`braintrust.input_json` / `braintrust.output_json`** on `openclaw.model.call` spans when content capture is on (systemPrompt + prompt + history; assistantTexts).
- **`braintrust.metadata.tools`** on `model.call` spans when the call had tool definitions.
- **`braintrust.input_json` / `braintrust.output_json`** on `openclaw.tool.execution` spans (tool args and result), plus `braintrust.metadata.tool_call_id` and `braintrust.metadata.is_error`.
- **`braintrust.input` / `braintrust.output`** on `openclaw.run` spans, derived from the run's first prompt and last assistant response.
- **`braintrust.span_attributes.type = "task"`** on `openclaw.run` spans (was: untyped).
- **Native top-level metadata** `braintrust.metadata.{model,provider,agent_id,channel}` on every span so Braintrust's built-in UI columns populate. Namespaced `openclaw.*` copies retained for our own slicing.
- **Versioning labels** on every span as top-level `braintrust.metadata.*`:
  - `openclaw_version` (read automatically from the resolved `openclaw` package)
  - `agent_prompt_version`, `tool_policy_version`, `runbook_version`, `environment` (operator-supplied)
- **`braintrust.metrics.time_to_first_token`** on `model.call` close — mirrors the existing namespaced `ttfb_ms` so Braintrust's TTFT column populates.
- **`captureContent.enabled`** config flag (default `false`). When `true`, gates all I/O capture paths. Plugin logs a loud warning at startup whenever the flag is on, calling out the admin-only-Braintrust caveat.
- **`versioning` config block** for the operator-supplied version labels.
- **`IoBuffer` module** — in-memory registry for LLM and tool payloads, bounded by `maxCallsPerRun` (default 50). Tracks open `model.call` spans per session so `model.usage` can be parented.

### Fixed

- **`model.usage` orphan-parenting.** Spans now parent to the most-recently-opened `model.call` for their session via an in-memory registry. Falls back to orphan only when no open call is registered (graceful degradation; behavior identical to v0.1.0 in the fallback case). Previously every `model.usage` was orphan.
- **Run-level I/O on multi-turn traces.** A bug introduced by the new IoBuffer would have caused `braintrust.input` / `braintrust.output` on the `openclaw.run` span to be silently empty in every multi-turn trace because per-call slot consumption happened before run-close peek. Fix: run-level first-input / last-output snapshots that survive `takeCallIo` consumption. Caught by the new integration test.

### Changed

- **Diagnostic event handler extracted** from `service.ts` to `event-handler.ts`. Pure refactor — same behavior, but the full event-to-span flow can now be unit-tested against an in-memory OTEL exporter (see `src/__tests__/integration.test.ts`).
- **`IoBuffer` `enabled` API** simplified from a `() => boolean` predicate to a mutable boolean with `setEnabled()` / `isEnabled()`.

### Tests

- 32 → 82. Adds coverage for the IoBuffer lifecycle (lifecycle, overflow, take-then-peek regression, session-parent registry), every new attribute builder, native metadata top-level lift, versioning passthrough, time-to-first-token mirror, and end-to-end integration scenarios driving the full event flow against an in-memory OTEL exporter.

### Privacy

- Content capture is **off by default**. Operator must explicitly set `captureContent.enabled = true` and acknowledge the privacy framing in the README before raw LLM / tool I/O is exported. See [Eval-grade capture](README.md#eval-grade-capture) for the full posture and the loud-warning-at-startup behavior.

### Internals

- New file: `src/io-buffer.ts`
- New file: `src/event-handler.ts`
- New file: `src/__tests__/integration.test.ts`
- `service.ts` shrunk from ~530 lines to ~315 (lifecycle only).

### Migration from 0.1.0

- No breaking changes. Existing 0.1.0 configs work unchanged.
- To turn on eval-grade capture, add to your plugin config:
  ```json
  { "captureContent": { "enabled": true } }
  ```
  Only do this on internal/admin-only Braintrust instances. See README.

## 0.1.0 — initial release

First public release.

### Spans emitted

- `openclaw.run` (root) — from `run.started` / `harness.run.started`. Closed on `run.completed` / `harness.run.completed` / `harness.run.error`.
- `openclaw.model.call` (child of run via `runId`) — from `model.call.started`. Closed on `.completed` / `.error` with duration, payload bytes, TTFB, error category.
- `openclaw.model.usage` (orphan — see Known limitations) — from `model.usage`. Carries token metrics (`prompt_tokens`, `completion_tokens`, `tokens`, `prompt_cached_tokens`, `prompt_cache_creation_tokens`), cost, per-call deltas, context-budget info, duration, agent id, channel.
- `openclaw.tool.execution` (child of run) — from `tool.execution.started`. Closed on `.completed` / `.error` / `.blocked`.
- `openclaw.context.assembled` (child of run) — from `context.assembled`. Per-turn context-budget visibility: message count, history chars, system prompt chars, prompt chars, image counts, context token budget, reserve tokens.

### Privacy posture

- Session identifiers (`sessionKey`, `sessionId`, `runId`) are SHA-256 hashed with a configurable salt before export. Raw identifiers are off by default.
- LLM request/response bodies are **never** captured — diagnostic events don't carry them.
