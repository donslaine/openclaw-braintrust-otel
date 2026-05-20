// Dumps the raw spans from the most recent smoke run, so we can eyeball
// exactly which fields landed vs. fell off the wire.
//
// Run:
//   BRAINTRUST_API_KEY=sk_... npx tsx plugins/braintrust-otel/scripts/inspect.ts
//
// Flags:
//   --raw     dump the full span JSON (no field grouping)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "..", ".last-smoke.json");

const apiKey = process.env.BRAINTRUST_API_KEY;
if (!apiKey) {
  console.error("BRAINTRUST_API_KEY is required");
  process.exit(1);
}

const raw = process.argv.includes("--raw");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  parent: string;
  runIdHash: string;
};
const projectName = manifest.parent.replace(/^project_name:/, "");

async function resolveProjectId(name: string): Promise<string> {
  const url = `https://api.braintrust.dev/v1/project?project_name=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`GET /v1/project ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { objects?: Array<{ id: string; name: string }> };
  const match = body.objects?.find((p) => p.name === name);
  if (!match) throw new Error(`Project '${name}' not found`);
  return match.id;
}

async function btql(query: string) {
  const res = await fetch("https://api.braintrust.dev/btql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, fmt: "json" }),
  });
  if (!res.ok) throw new Error(`BTQL ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: unknown[] } | unknown[];
  return Array.isArray(body) ? body : body.data ?? [];
}

async function main() {
  const projectId = await resolveProjectId(projectName);
  const spans = (await btql(`
    select: *
    | from: project_logs('${projectId}')
    | filter: metadata.openclaw.run_id_hash = '${manifest.runIdHash}'
    | sort: created ASC
    | limit: 100
  `)) as Array<Record<string, unknown>>;

  console.log(`\n${spans.length} span(s) for runIdHash=${manifest.runIdHash}\n`);

  if (raw) {
    console.log(JSON.stringify(spans, null, 2));
    return;
  }

  for (const s of spans) {
    const attrs = (s.span_attributes ?? {}) as Record<string, unknown>;
    const name = attrs.name ?? "(unnamed)";
    const type = attrs.type ?? "(none)";
    console.log("=".repeat(72));
    console.log(`${name}   [type=${type}]`);
    console.log(`  id:         ${s.id}`);
    console.log(`  root:       ${s.root_span_id ?? "(none)"}`);
    console.log(`  parents:    ${JSON.stringify(s.span_parents ?? [])}`);
    console.log(`  tags:       ${JSON.stringify(s.tags ?? [])}`);
    console.log(`  metrics:`);
    for (const [k, v] of Object.entries(
      (s.metrics ?? {}) as Record<string, unknown>,
    )) {
      console.log(`    ${k}: ${JSON.stringify(v)}`);
    }
    console.log(`  metadata:`);
    printNested((s.metadata ?? {}) as Record<string, unknown>, "    ");
    if (s.input !== undefined && s.input !== null) {
      console.log(`  input:      ${truncate(JSON.stringify(s.input))}`);
    }
    if (s.output !== undefined && s.output !== null) {
      console.log(`  output:     ${truncate(JSON.stringify(s.output))}`);
    }
  }
  console.log("=".repeat(72));
}

function printNested(obj: Record<string, unknown>, indent: string) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      console.log(`${indent}${k}:`);
      printNested(v as Record<string, unknown>, indent + "  ");
    } else {
      console.log(`${indent}${k}: ${JSON.stringify(v)}`);
    }
  }
}

function truncate(s: string, n = 200) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

main().catch((err) => {
  console.error("[inspect] failed:", err);
  process.exit(1);
});
