# braintrust-otel

Internal OpenClaw plugin: subscribes to internal diagnostics events and emits
Braintrust-shaped OTEL spans to `api.braintrust.dev/otel/v1/traces`.

See [`docs/braintrust-otel-plugin.md`](../../docs/braintrust-otel-plugin.md) for design.

**Status:** stage 1 thin slice — emits `openclaw.run` and `openclaw.model.usage`
spans only. Tool spans, model.call spans, and ACP handling are TODO.

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

## TODO before stage 2

- Wire real types from `@openclaw/infra` (`DiagnosticEventPayload`) and `@openclaw/plugin-sdk` (`OpenClawPluginService`)
- Verify the parent-span context plumbing (current `globalThis.opentelemetryActiveContext` hack needs to use the proper OTEL `context` API)
- Add `openclaw.model.call` and `openclaw.tool.execution` spans
- ACP coarse spans + `runtime=acp` tagging
- Vitest coverage for span shape
