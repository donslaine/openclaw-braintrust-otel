# Changelog

## 0.1.0 — unreleased

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
