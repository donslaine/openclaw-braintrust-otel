# @donslaine/openclaw-braintrust-otel

OpenClaw plugin that subscribes to internal diagnostic events and exports Braintrust-shaped OTLP spans to [Braintrust](https://braintrust.dev).

Gives you per-run, per-model-call, per-tool, per-turn observability for any [OpenClaw](https://github.com/openclaw/openclaw) agent — without needing to wrap your model client or instrument tool code.

## What you get

Five span types, all carrying `braintrust.tags`, `braintrust.metadata.service_name`, and hashed session identifiers so any span is filterable by tag or service in Braintrust:

| Span | Source events | Highlights |
|------|---------------|------------|
| `openclaw.run` | `run.started/completed`, `harness.run.started/completed/error` | channel, provider, model, trigger, agent, session kind |
| `openclaw.model.call` | `model.call.started/completed/error` | provider/model/api/transport, request/response bytes, TTFB, duration, error category, upstream request id hash |
| `openclaw.model.usage` | `model.usage` | `prompt_tokens`, `completion_tokens`, `tokens`, `prompt_cached_tokens`, `prompt_cache_creation_tokens`, `cost` (auto-mapped to Braintrust's metrics column), plus per-call deltas and context-budget metrics |
| `openclaw.tool.execution` | `tool.execution.started/completed/error/blocked` | tool name, duration, error category / blocked reason |
| `openclaw.context.assembled` | `context.assembled` | per-turn token-budget visibility: message count, history/system/prompt chars, image blocks, context token budget, reserve tokens |

`openclaw.run` is the trace root. `model.call`, `tool.execution`, and `context.assembled` parent to it via `runId`. `model.usage` is currently emitted as an orphan span (see Known limitations).

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
  }
}
```

- **`endpoint`** — OTLP base URL (`tracesEndpoint` derives as `${endpoint}/v1/traces`). Defaults to `https://api.braintrust.dev/otel`.
- **`serviceName`** — value sent as `service.name` resource attribute and Braintrust metadata. Defaults to `openclaw`.
- **`tags`** — array of strings written to `braintrust.tags` on every span. Filterable in the Braintrust UI.
- **`sessionIdentifiers.raw`** — when true, emits raw `sessionKey`/`sessionId`/`runId`. Off by default. Only safe if your session keys are not sensitive (e.g. cron names, not phone numbers or account ids).
- **`sessionIdentifiers.hash`** — when true (default), emits SHA-256(salt + id) truncated to 16 hex chars.
- **`sessionIdentifiers.hashSaltSecretRef`** — name of the env var holding the salt. Defaults to `BRAINTRUST_SESSION_HASH_SALT`.

## Privacy posture

- LLM request/response bodies are **never** captured. Diagnostic events don't carry them — the OpenClaw runtime counts response bytes but discards the payload. Capturing I/O text would require a different integration point (wrapping the model client at the provider level) and is out of scope for this plugin.
- Session identifiers are hashed by default. Raw ids are opt-in.
- Choose a salt your team controls. Don't commit it to source.

## Known limitations

- **`model.usage` is orphan-parented.** Upstream `DiagnosticUsageEvent` carries `sessionKey`/`sessionId` but not `runId` or `callId`, so the usage span cannot be linked to its parent run/call from the payload alone. Spans group visually in Braintrust via the `session_id_hash` metadata column. Will be fixed when openclaw propagates trace context into the event or when we add an in-memory `session → last open run` map.
- **Trust gate inconsistency.** Upstream openclaw allowlists only `diagnostics-otel` and `diagnostics-prometheus` to receive `ctx.internalDiagnostics`. However, `onInternalDiagnosticEvent` is publicly exported from `openclaw/plugin-sdk/diagnostic-runtime`, so any plugin can subscribe regardless. This plugin prefers the host-granted `ctx.internalDiagnostics` path when available and falls back to the public SDK export otherwise. The startup log records which path is active (`subscriptionSource: "ctx" | "sdk"`).

## Development

```sh
npm install
npm run typecheck
npm test          # 32 unit tests covering attribute-mapping for every span type
npm run build     # tsc -> dist/
```

Live trace inspection against Braintrust (requires `BRAINTRUST_API_KEY`):

```sh
npm run inspect:real -- --project my-project --tag agent-myagent --summary
```

## License

MIT
