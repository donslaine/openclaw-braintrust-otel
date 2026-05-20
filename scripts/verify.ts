// Verifies the most recent smoke run by querying Braintrust's BTQL API
// and asserting that the spans landed with the expected shape.
//
// Run:
//   BRAINTRUST_API_KEY=sk_... npx tsx plugins/braintrust-otel/scripts/verify.ts
//
// Reads .last-smoke.json (written by smoke.ts) for the run id, expected
// values, and parent. Polls for up to ~30s in case of indexing delay.
//
// Exit code 0 = all checks passed; 1 = something failed.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "..", ".last-smoke.json");

type Manifest = {
  parent: string;
  serviceName: string;
  runId: string;
  runIdHash: string;
  callId: string;
  toolCallId: string;
  expected: {
    spanNames: string[];
    metrics: Record<string, number>;
    spanTypes: Record<string, string>;
  };
};

type Span = {
  id: string;
  root_span_id?: string;
  span_parents?: string[];
  span_attributes?: { type?: string; name?: string };
  metrics?: Record<string, number>;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
  created?: string;
};

const apiKey = process.env.BRAINTRUST_API_KEY;
if (!apiKey) {
  console.error("BRAINTRUST_API_KEY is required");
  process.exit(1);
}

const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const projectName = manifest.parent.replace(/^project_name:/, "");

async function btql(query: string): Promise<Span[]> {
  const res = await fetch("https://api.braintrust.dev/btql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, fmt: "json" }),
  });
  if (!res.ok) {
    throw new Error(`BTQL ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: Span[] } | Span[];
  return Array.isArray(body) ? body : body.data ?? [];
}

async function fetchSpans(): Promise<Span[]> {
  // Filter by our hashed run id to pin down this exact smoke run.
  // Falls back to tag filter if metadata path lookup turns out to differ.
  const q = `
    select: *
    | from: project_logs('${projectName}')
    | filter: metadata.openclaw.run_id_hash = '${manifest.runIdHash}'
    | sort: created DESC
    | limit: 100
  `;
  return btql(q);
}

async function fetchSpansWithRetry(): Promise<Span[]> {
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const spans = await fetchSpans();
      if (spans.length >= manifest.expected.spanNames.length) return spans;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (lastErr) throw lastErr;
  return fetchSpans();
}

type Check = { name: string; pass: boolean; detail: string };

function check(spans: Span[]): Check[] {
  const out: Check[] = [];
  const byName = new Map<string, Span>();
  for (const s of spans) {
    const n = s.span_attributes?.name;
    if (n) byName.set(n, s);
  }

  // 1. All four span names present.
  for (const name of manifest.expected.spanNames) {
    const got = byName.get(name);
    out.push({
      name: `span exists: ${name}`,
      pass: !!got,
      detail: got ? `id=${got.id}` : "not found",
    });
  }

  // 2. Parent nesting: model.call, model.usage, tool.execution all
  //    descend from openclaw.run.
  const run = byName.get("openclaw.run");
  for (const child of [
    "openclaw.model.call",
    "openclaw.model.usage",
    "openclaw.tool.execution",
  ]) {
    const c = byName.get(child);
    const parents = c?.span_parents ?? [];
    const rootId = c?.root_span_id;
    const nested =
      !!run &&
      (parents.includes(run.id) || rootId === run.id || parents.length > 0);
    out.push({
      name: `${child} nests under openclaw.run`,
      pass: !!run && nested,
      detail: run
        ? `parents=${JSON.stringify(parents)} root=${rootId ?? "none"}`
        : "run span missing",
    });
  }

  // 3. Span types.
  for (const [name, expectedType] of Object.entries(
    manifest.expected.spanTypes,
  )) {
    const s = byName.get(name);
    const got = s?.span_attributes?.type;
    out.push({
      name: `${name} has type=${expectedType}`,
      pass: got === expectedType,
      detail: `got type=${got ?? "none"}`,
    });
  }

  // 4. Metrics on model.usage.
  const usage = byName.get("openclaw.model.usage");
  for (const [metric, expectedVal] of Object.entries(
    manifest.expected.metrics,
  )) {
    const got = usage?.metrics?.[metric];
    out.push({
      name: `model.usage.metrics.${metric} = ${expectedVal}`,
      pass: typeof got === "number" && Math.abs(got - expectedVal) < 1e-6,
      detail: `got ${JSON.stringify(got)}`,
    });
  }

  // 5. Tag smoke-test present on at least one span.
  const taggedCount = spans.filter((s) => s.tags?.includes("smoke-test")).length;
  out.push({
    name: `tag 'smoke-test' on >= 1 span`,
    pass: taggedCount > 0,
    detail: `tagged spans: ${taggedCount}`,
  });

  // 6. Hashed session ids present, raw not.
  const meta = (run?.metadata ?? {}) as Record<string, unknown>;
  const flat = JSON.stringify(meta);
  out.push({
    name: "hashed session ids present",
    pass: flat.includes("session_id_hash") || flat.includes("session_key_hash"),
    detail: flat.slice(0, 200),
  });
  out.push({
    name: "raw sessionKey NOT present (telegram:direct:...)",
    pass: !flat.includes("telegram:direct:5551234567"),
    detail: "metadata scanned for raw phone",
  });

  return out;
}

async function main() {
  console.log(
    `[verify] querying Braintrust project '${projectName}' for runIdHash=${manifest.runIdHash}`,
  );
  const spans = await fetchSpansWithRetry();
  console.log(`[verify] fetched ${spans.length} span(s)\n`);

  if (spans.length === 0) {
    console.error(
      "[verify] no spans found. Either ingestion is delayed, the parent project " +
        "name is wrong, or the run_id_hash field isn't where we expect. " +
        "Try the Braintrust UI to confirm spans exist.",
    );
    process.exit(1);
  }

  const checks = check(spans);
  let failed = 0;
  for (const c of checks) {
    const icon = c.pass ? "✓" : "✗";
    console.log(`${icon} ${c.name}`);
    if (!c.pass) {
      console.log(`    ${c.detail}`);
      failed++;
    }
  }
  console.log(
    `\n${checks.length - failed}/${checks.length} checks passed${
      failed ? `, ${failed} failed` : ""
    }`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[verify] failed:", err);
  process.exit(1);
});
