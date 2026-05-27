# Changelog

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
