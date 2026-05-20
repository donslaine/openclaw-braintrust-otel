# braintrust-otel

Internal OpenClaw plugin: subscribes to internal diagnostics events and emits
Braintrust-shaped OTEL spans to `api.braintrust.dev/otel/v1/traces`.

See [`docs/braintrust-otel-plugin.md`](../../docs/braintrust-otel-plugin.md) for design.

**Status:** stage 2 — emits `openclaw.run`, `openclaw.model.usage`,
`openclaw.model.call`, and `openclaw.tool.execution` spans.
ACP-specific spans are deferred (current diagnostic events carry no ACP
marker; see the design doc's "ACP gap" section).

## Required env

- `BRAINTRUST_API_KEY` — Braintrust service token
- `BRAINTRUST_PARENT` — e.g. `project_name:smith-industries`
- `BRAINTRUST_SESSION_HASH_SALT` — salt for hashing session identifiers (only required if `sessionIdentifiers.hash` is on, which is the default)

## Plugin config (optional)

```json
{
  "endpoint": "https://api.braintrust.dev/otel",
  "serviceName": "openclaw-jeffery",
  "tags": ["agent-jeffery"],
  "captureContent": { "input": false, "output": true },
  "sessionIdentifiers": { "raw": false, "hash": true }
}
```

## Install (local instance)

This plugin is not published. Install by pointing the OpenClaw host at this directory.

## TODO

- Wire real types from `@openclaw/infra` (`DiagnosticEventPayload`) and `@openclaw/plugin-sdk` (`OpenClawPluginService`) once the plugin is brought into the workspace.
- Read plugin config from `ctx.config.plugins?.["braintrust-otel"]` instead of treating `ctx.config` as the plugin's own config.
- Verify `braintrust.metrics.cost` lands on the first real trace (undocumented).
- ACP-aware spans pending an upstream `runtime`/`acp.*` field on diagnostic events.
- Vitest coverage for span shape.
