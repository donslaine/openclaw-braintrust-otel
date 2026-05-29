# @donslaine/openclaw-braintrust-otel

OpenClaw plugin that subscribes to internal diagnostic events and exports Braintrust-shaped OTLP spans to [Braintrust](https://braintrust.dev).

Gives you per-run, per-model-call, per-tool, per-turn observability for any [OpenClaw](https://github.com/openclaw/openclaw) agent — without needing to wrap your model client or instrument tool code.

## What you get

Five span types, all carrying `braintrust.tags`, `braintrust.metadata.service_name`, and session identifiers (raw by default, hashable for client-facing deployments) so any span is filterable by tag, service, or session in Braintrust:

| Span                         | Source events                                                  | Highlights                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openclaw.run`               | `run.started/completed`, `harness.run.started/completed/error` | channel, provider, model, trigger, agent, session kind                                                                                                                                                       |
| `openclaw.model.call`        | typed hooks `model_call_started` / `model_call_ended`          | provider/model/api/transport, request/response bytes, TTFB, duration, error category, upstream request id hash. callId-keyed for reliable 1:1 pairing with each model call within a turn.                    |
| `openclaw.model.usage`       | `model.usage`                                                  | `prompt_tokens`, `completion_tokens`, `tokens`, `prompt_cached_tokens`, `prompt_cache_creation_tokens`, `cost` (auto-mapped to Braintrust's metrics column), plus per-call deltas and context-budget metrics |
| `openclaw.tool.execution`    | `tool.execution.started/completed/error/blocked`               | tool name, duration, error category / blocked reason                                                                                                                                                         |
| `openclaw.context.assembled` | `context.assembled`                                            | per-turn token-budget visibility: message count, history/system/prompt chars, image blocks, context token budget, reserve tokens                                                                             |

`openclaw.run` is the trace root. `model.call`, `tool.execution`, and `context.assembled` parent to it via `runId`. `model.usage` parents to its matching `model.call` span (callId resolved via session lookup with a short TTL across the bus/hook race), falls back to the open `run` span as a backstop, and only goes fully orphan if neither is registered.

With `captureContent.enabled = true` (see [Eval-grade capture](#eval-grade-capture)), `tool.execution` spans carry full `braintrust.input_json` / `braintrust.output_json`, and the `openclaw.run` span carries `braintrust.input` / `braintrust.output` derived from the run's first prompt and last assistant response. Per-call `braintrust.input_json` / `braintrust.output_json` on `model.call` spans was removed in v0.3.0 because the underlying `llm_input` / `llm_output` hooks fire once per turn (not per call), so per-call attribution was structurally impossible to get right — see CHANGELOG for the v0.2.x bug this fixes.

## Install

```sh
npm install @donslaine/openclaw-braintrust-otel
```

Then add to your OpenClaw plugins config. Set required env vars:

```sh
export BRAINTRUST_API_KEY=sk_...
export BRAINTRUST_PARENT=project_name:my-agent
export BRAINTRUST_SESSION_HASH_SALT=$(openssl rand -hex 16)
```

## Plugin config

Two sibling blocks live under `plugins.entries["braintrust-otel"]`: `hooks` (permission grants) and `config` (plugin behavior). Both optional, but **`hooks.allowConversationAccess: true` is required for `braintrust.input` / `braintrust.output` on the run span to populate** (the `llm_input` / `llm_output` hooks are gated as conversation-content access).

```json
{
  "hooks": {
    "allowConversationAccess": true
  },
  "config": {
    "endpoint": "https://api.braintrust.dev/otel",
    "serviceName": "openclaw-myagent",
    "tags": ["agent-myagent"],
    "sessionIdentifiers": {
      "raw": true,
      "hash": false,
      "hashSaltSecretRef": "BRAINTRUST_SESSION_HASH_SALT"
    },
    "captureContent": {
      "enabled": false
    },
    "versioning": {
      "agentPromptVersion": "jeffery-v3",
      "toolPolicyVersion": "default-v2",
      "runbookVersion": "m1-runbook-2026-05-28",
      "environment": "prod"
    }
  }
}
```

- **`hooks.allowConversationAccess`** — required to grant the plugin's `llm_input` / `llm_output` hook subscriptions at the OpenClaw runtime gate. Without this, the plugin still emits lifecycle spans (timing, tool I/O, model.usage, model.call) but `braintrust.input` / `braintrust.output` will be empty on `run` spans. Tool I/O hooks (`before_tool_call` / `after_tool_call`) and per-call hooks (`model_call_started` / `model_call_ended`) do NOT require this grant.

- **`endpoint`** — OTLP base URL (`tracesEndpoint` derives as `${endpoint}/v1/traces`). Defaults to `https://api.braintrust.dev/otel`.
- **`serviceName`** — value sent as `service.name` resource attribute and Braintrust metadata. Defaults to `openclaw`.
- **`tags`** — array of strings written to `braintrust.tags` on every span. Filterable in the Braintrust UI.
- **`sessionIdentifiers.raw`** — emits raw `sessionKey` / `sessionId` / `runId`. **Default true** (v0.3.1+). `sessionId` and `runId` are openclaw-internal UUIDs with no identifying content. `sessionKey` is the channel-native identifier (Telegram chat IDs, phone numbers, Discord user IDs) and IS PII — set to `false` for client-facing deployments and enable `hash` instead.
- **`sessionIdentifiers.hash`** — emits SHA-256(salt + id) truncated to 16 hex chars under `*_hash` keys. **Default false** (v0.3.1+). Both `raw` and `hash` can be true simultaneously. Required for client-facing deployments where `sessionKey` PII can't land in Braintrust raw.
- **`sessionIdentifiers.hashSaltSecretRef`** — name of the env var holding the salt. Defaults to `BRAINTRUST_SESSION_HASH_SALT`. Only used when `hash` is true.
- **`captureContent.enabled`** — when true, exports raw LLM prompts, assistant outputs, tool args, and tool results. **Default false.** See [Eval-grade capture](#eval-grade-capture) for the privacy posture before enabling.
- **`versioning.*`** — operator labels that travel on every span as top-level `braintrust.metadata.*`. Promoted dataset examples carry them automatically, so experiments can slice regressions by prompt/policy/runbook/environment. `openclaw_version` is added automatically from the resolved openclaw package; the four below are operator-supplied.

## Eval-grade capture

`captureContent.enabled = true` turns this plugin from observability-grade into eval-grade. The same span tree gets:

- `braintrust.input` and `braintrust.output` on `openclaw.run` spans, derived from the first user prompt and the last assistant response of the run.
- `braintrust.input_json` and `braintrust.output_json` on `openclaw.tool.execution` spans (tool args and result), plus `braintrust.metadata.tool_call_id` and `braintrust.metadata.is_error`.

Mechanism: an in-memory `IoBuffer` subscribes to OpenClaw's public typed plugin hooks (`llm_input`, `llm_output`, `before_tool_call`, `after_tool_call`, `model_call_started`, `model_call_ended`) via `api.on(name, handler)` and joins payloads to the matching span at close time. Tool I/O is captured in two phases (args at `before_tool_call`, result at `after_tool_call`) and merged by `toolCallId` at consume time. Hooks register at plugin init but the content-bearing ones (`llm_input` / `llm_output`, tool I/O) no-op until `captureContent.enabled` flips to true.

**Per-call LLM I/O is not captured** as of v0.3.0. The underlying `llm_input` / `llm_output` typed hooks are turn-level — they fire once per turn, regardless of how many model calls the turn contains (compaction calls, retries, tool-result-handling shortcuts can all add additional model calls). v0.2.x tried to attribute the turn-level content to per-call spans and produced silent N:1 mismatches on every multi-call turn. v0.3.0 attributes LLM content to the run span only, which the data accurately supports.

**Activation requirement.** v0.2.1+ declares `activation.onCapabilities: ["hook"]` in its manifest so the plugin is automatically considered for gateway startup on OpenClaw ≥ 2026.5.20. Plugins built against older OpenClaw releases that pre-date this manifest field need to be installed against OpenClaw 2026.5.20 or newer.

### Privacy posture

- **Content capture is OFF by default.**
- When enabled, the plugin exfiltrates raw user prompts, assistant outputs, tool args, and tool results to the configured Braintrust endpoint.
- This is acceptable **only** when the destination Braintrust instance is internal/admin-only and approved for that data.
- For client-facing or externally shared deployments: do **not** enable `captureContent` without an explicit per-deployment privacy review. The plugin logs a loud warning at startup whenever the flag is on so accidental enablement is hard to miss.
- Session identifiers are raw by default as of v0.3.1. Set `sessionIdentifiers.hash = true` (and configure the salt) for client-facing deployments where `sessionKey` carries PII.

## Known limitations

- **Trust gate inconsistency.** Upstream openclaw allowlists only `diagnostics-otel` and `diagnostics-prometheus` to receive `ctx.internalDiagnostics`. However, `onInternalDiagnosticEvent` is publicly exported from `openclaw/plugin-sdk/diagnostic-runtime`, so any plugin can subscribe regardless. This plugin prefers the host-granted `ctx.internalDiagnostics` path when available and falls back to the public SDK export otherwise. The startup log records which path is active (`subscriptionSource: "ctx" | "sdk"`). The bus is still load-bearing because `run.*`, `model.usage`, `context.assembled`, and `tool.execution.blocked` have no typed-hook equivalents.
- **`model.usage` parenting is best-effort.** `DiagnosticUsageEvent` carries `sessionKey`/`sessionId` but not `runId` or `callId`. v0.3.0 parents the usage span via, in order: (1) the matching `model.call` span via a dual-keyed session registry with a 5 s post-close TTL across the bus/hook race, (2) the open `run` span via a backstop registry as a fallback, (3) fully orphan when neither is available (groups visually via `session_id` metadata). In practice fully orphan should be rare; the run-backstop catches the case where a usage event arrives outside any model.call window.

## Development

```sh
npm install
npm run typecheck
npm test          # 81 tests: attribute mapping, IoBuffer lifecycle (two-phase tool capture, usage parenting TTL + dual-key + run backstop), integration-shape event→span+hook flow
npm run build     # tsc -> dist/
```

Live trace inspection against Braintrust (requires `BRAINTRUST_API_KEY`):

```sh
npm run inspect:real -- --project my-project --tag agent-myagent --summary
```

## License

MIT
