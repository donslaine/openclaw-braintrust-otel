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

## Smoke test (no OpenClaw host needed)

Stubs the plugin context, fires a scripted sequence of synthetic diagnostic
events, and flushes real spans to Braintrust. Defaults to a throwaway project
so it never touches production observability data.

```sh
BRAINTRUST_API_KEY=sk_... \
BRAINTRUST_PARENT=project_name:braintrust-otel-smoke \
BRAINTRUST_SESSION_HASH_SALT=smoke-salt \
npx tsx plugins/braintrust-otel/scripts/smoke.ts
```

Flags: `--parent <x-bt-parent value>`, `--service-name <name>`, `--keep-content`
(captures `braintrust.input`/`output`).

Expected in Braintrust: one root `openclaw.run` span with three children —
`openclaw.model.call`, `openclaw.model.usage` (`type=llm`, with `prompt_tokens`,
`completion_tokens`, `tokens`, and `cost` metrics), and `openclaw.tool.execution`
(`type=tool`). All tagged `smoke-test`.

## Install (local instance)

This plugin is not published. Install by pointing the OpenClaw host at this directory.

## TODO

- Wire real types from `@openclaw/infra` (`DiagnosticEventPayload`) and `@openclaw/plugin-sdk` (`OpenClawPluginService`) once the plugin is brought into the workspace.
- Read plugin config from `ctx.config.plugins?.["braintrust-otel"]` instead of treating `ctx.config` as the plugin's own config.
- ACP-aware spans pending an upstream `runtime`/`acp.*` field on diagnostic events.
- Vitest coverage for span shape.
