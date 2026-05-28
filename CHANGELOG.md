# Changelog

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
