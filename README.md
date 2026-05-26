# @donslaine/openclaw-braintrust-otel

OpenClaw plugin that subscribes to internal diagnostic events and exports Braintrust-shaped OTLP spans to [Braintrust](https://braintrust.dev).

Gives you per-run, per-model-call, per-tool, per-turn observability for any [OpenClaw](https://github.com/openclaw/openclaw) agent — without needing to wrap your model client or instrument tool code.

## What you get

Five span types, all carrying `braintrust.tags`, `braintrust.metadata.service_name`, and hashed session identifiers so any span is filterable by tag or service in Braintrust:

| Span                         | Source events                                                  | Highlights                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openclaw.run`               | `run.started/completed`, `harness.run.started/completed/error` | channel, provider, model, trigger, agent, session kind                                                                                                                                                       |
| `openclaw.model.call`        | `model.call.started/completed/error`                           | provider/model/api/transport, request/response bytes, TTFB, duration, error category, upstream request id hash                                                                                               |
| `openclaw.model.usage`       | `model.usage`                                                  | `prompt_tokens`, `completion_tokens`, `tokens`, `prompt_cached_tokens`, `prompt_cache_creation_tokens`, `cost` (auto-mapped to Braintrust's metrics column), plus per-call deltas and context-budget metrics |
| `openclaw.tool.execution`    | `tool.execution.started/completed/error/blocked`               | tool name, duration, error category / blocked reason                                                                                                                                                         |
| `openclaw.context.assembled` | `context.assembled`                                            | per-turn token-budget visibility: message count, history/system/prompt chars, image blocks, context token budget, reserve tokens                                                                             |

`openclaw.run` is the trace root. `model.call`, `tool.execution`, and `context.assembled` parent to it via `runId`. `model.usage` parents to the most-recently-opened `model.call` span for its session; it falls back to an orphan when no open call is registered.

With `captureContent.enabled = true` (see [Eval-grade capture](#eval-grade-capture)), `model.call` and `tool.execution` spans also carry full `braintrust.input_json` / `braintrust.output_json`, and the `openclaw.run` span carries `braintrust.input` / `braintrust.output` derived from the run's first prompt and last assistant response.

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

All optional:

```json
{
  "endpoint": "https://api.braintrust.dev/otel",
  "serviceName": "openclaw-myagent",
  "tags": ["agent-myagent"],
  "sessionIdentifiers": {
    "raw": false,
    "hash": true,
    "hashSaltSecretRef": "BRAINTRUST_SESSION_HASH_SALT"
  },
  "captureContent": {
    "enabled": false
  },
  "versioning": {
    "agentPromptVersion": "jeffery-v3",
    "toolPolicyVersion": "default-v2",
    "runbookVersion": "m1-runbook-2026-05-26",
    "environment": "prod"
  }
}
```

- **`endpoint`** — OTLP base URL (`tracesEndpoint` derives as `${endpoint}/v1/traces`). Defaults to `https://api.braintrust.dev/otel`.
- **`serviceName`** — value sent as `service.name` resource attribute and Braintrust metadata. Defaults to `openclaw`.
- **`tags`** — array of strings written to `braintrust.tags` on every span. Filterable in the Braintrust UI.
- **`sessionIdentifiers.raw`** — when true, emits raw `sessionKey`/`sessionId`/`runId`. Off by default. Only safe if your session keys are not sensitive (e.g. cron names, not phone numbers or account ids).
- **`sessionIdentifiers.hash`** — when true (default), emits SHA-256(salt + id) truncated to 16 hex chars.
- **`sessionIdentifiers.hashSaltSecretRef`** — name of the env var holding the salt. Defaults to `BRAINTRUST_SESSION_HASH_SALT`.
- **`captureContent.enabled`** — when true, exports raw LLM prompts, assistant outputs, tool args, and tool results. **Default false.** See [Eval-grade capture](#eval-grade-capture) for the privacy posture before enabling.
- **`versioning.*`** — operator labels that travel on every span as top-level `braintrust.metadata.*`. Promoted dataset examples carry them automatically, so experiments can slice regressions by prompt/policy/runbook/environment. `openclaw_version` is added automatically from the resolved openclaw package; the four below are operator-supplied.

## Eval-grade capture

`captureContent.enabled = true` turns this plugin from observability-grade into eval-grade. The same span tree gets:

- `braintrust.input_json` and `braintrust.output_json` on every `openclaw.model.call` span (system prompt + prompt + history; assistant texts).
- `braintrust.metadata.tools` on `model.call` spans whose call had tool definitions attached.
- `braintrust.input_json` and `braintrust.output_json` on `openclaw.tool.execution` spans (tool args and result), plus `braintrust.metadata.tool_call_id` and `braintrust.metadata.is_error`.
- `braintrust.input` and `braintrust.output` on `openclaw.run` spans, derived from the first user prompt and the last assistant response of the run.

Mechanism: an in-memory `IoBuffer` subscribes to OpenClaw's plugin SDK hooks (`llm_input`, `llm_output`, `AgentToolResultMiddleware`) and joins payloads to the matching span at close time. Hooks register at plugin init but no-op until `captureContent.enabled` flips to true, so registering the plugin in a config that doesn't set the flag has the same behavior as v0.1.0.

### Privacy posture

- **Content capture is OFF by default.**
- When enabled, the plugin exfiltrates raw user prompts, assistant outputs, tool args, and tool results to the configured Braintrust endpoint.
- This is acceptable **only** when the destination Braintrust instance is internal/admin-only and approved for that data.
- For client-facing or externally shared deployments: do **not** enable `captureContent` without an explicit per-deployment privacy review. The plugin logs a loud warning at startup whenever the flag is on so accidental enablement is hard to miss.
- Session identifiers remain hashed by default regardless of `captureContent`. Raw ids are still a separate opt-in via `sessionIdentifiers.raw`.

## Known limitations

- **Trust gate inconsistency.** Upstream openclaw allowlists only `diagnostics-otel` and `diagnostics-prometheus` to receive `ctx.internalDiagnostics`. However, `onInternalDiagnosticEvent` is publicly exported from `openclaw/plugin-sdk/diagnostic-runtime`, so any plugin can subscribe regardless. This plugin prefers the host-granted `ctx.internalDiagnostics` path when available and falls back to the public SDK export otherwise. The startup log records which path is active (`subscriptionSource: "ctx" | "sdk"`).
- **`model.usage` orphan fallback.** `DiagnosticUsageEvent` carries `sessionKey`/`sessionId` but not `runId` or `callId`. The plugin parents the usage span to the most-recently-opened `model.call` span for the session; if no open call is registered (usage arrived after close, or session ids absent), the span falls back to its orphan form and groups visually via the `session_id_hash` metadata column.

## Development

```sh
npm install
npm run typecheck
npm test          # 77 unit tests covering attribute-mapping + IoBuffer lifecycle
npm run build     # tsc -> dist/
```

Live trace inspection against Braintrust (requires `BRAINTRUST_API_KEY`):

```sh
npm run inspect:real -- --project my-project --tag agent-myagent --summary
```

## License

MIT
