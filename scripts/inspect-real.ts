// Inspect recent real-traffic spans in Braintrust. Filters by tag and
// pretty-prints every emitted field per span so we can diff what we
// hoped to emit against what actually lands.
//
// Run from cccc/plugins/braintrust-otel/:
//   BRAINTRUST_API_KEY=sk_... \
//     npx tsx scripts/inspect-real.ts \
//       --project smith-industries \
//       --tag agent-jeffery
//
// Flags:
//   --project <name>     project_name (required)
//   --tag <tag>          tag to filter on (default: agent-jeffery)
//   --since <minutes>    time window in minutes (default: 60)
//   --limit <n>          max spans to fetch (default: 50)
//   --raw                dump full JSON instead of formatted view
//   --tree               group spans into trace trees

import { setTimeout as sleep } from "node:timers/promises";

const apiKey = process.env.BRAINTRUST_API_KEY;
if (!apiKey) {
  console.error("BRAINTRUST_API_KEY is required");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (n: string) => args.includes(`--${n}`);

const projectName = flag("project");
if (!projectName) {
  console.error("--project <name> is required");
  process.exit(1);
}
const tag = flag("tag") ?? "agent-jeffery";
const sinceMinutes = Number(flag("since") ?? "60");
const limit = Number(flag("limit") ?? "50");
const raw = has("raw");
const tree = has("tree");

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

async function resolveProjectId(name: string): Promise<string> {
  const url = `https://api.braintrust.dev/v1/project?project_name=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`GET /v1/project ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { objects?: Array<{ id: string; name: string }> };
  const match = body.objects?.find((p) => p.name === name);
  if (!match) {
    const found = body.objects?.map((p) => p.name) ?? [];
    throw new Error(`Project '${name}' not found. Available: ${JSON.stringify(found)}`);
  }
  return match.id;
}

async function btql(query: string): Promise<Span[]> {
  const res = await fetch("https://api.braintrust.dev/btql", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, fmt: "json" }),
  });
  if (!res.ok) throw new Error(`BTQL ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: Span[] } | Span[];
  return Array.isArray(body) ? body : body.data ?? [];
}

function truncate(s: string, n = 250) {
  return s.length > n ? s.slice(0, n) + "…" : s;
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

function printSpan(s: Span, depth = 0) {
  const indent = "  ".repeat(depth);
  const attrs = (s.span_attributes ?? {}) as Record<string, unknown>;
  const name = attrs.name ?? "(unnamed)";
  const type = attrs.type ?? "(none)";
  console.log(`${indent}${name}   [type=${type}]   ${s.created ?? ""}`);
  console.log(`${indent}  id:       ${s.id}`);
  console.log(`${indent}  root:     ${s.root_span_id ?? "(none)"}`);
  console.log(`${indent}  parents:  ${JSON.stringify(s.span_parents ?? [])}`);
  console.log(`${indent}  tags:     ${JSON.stringify(s.tags ?? [])}`);
  const metrics = (s.metrics ?? {}) as Record<string, unknown>;
  if (Object.keys(metrics).length) {
    console.log(`${indent}  metrics:`);
    for (const [k, v] of Object.entries(metrics)) {
      console.log(`${indent}    ${k}: ${JSON.stringify(v)}`);
    }
  }
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  if (Object.keys(meta).length) {
    console.log(`${indent}  metadata:`);
    printNested(meta, `${indent}    `);
  }
  if (s.input !== undefined && s.input !== null) {
    console.log(`${indent}  input:    ${truncate(JSON.stringify(s.input))}`);
  }
  if (s.output !== undefined && s.output !== null) {
    console.log(`${indent}  output:   ${truncate(JSON.stringify(s.output))}`);
  }
}

async function main() {
  console.log(`[inspect-real] resolving project '${projectName}'...`);
  const projectId = await resolveProjectId(projectName);
  console.log(`[inspect-real] project id: ${projectId}`);
  console.log(
    `[inspect-real] querying spans tagged '${tag}' from the last ${sinceMinutes} minutes...`,
  );

  // BTQL: filter by tag + recency. We sort by created DESC to get the
  // freshest first. Note: BTQL syntax for tag membership is "INCLUDES".
  const q = `
    select: *
    | from: project_logs('${projectId}')
    | filter: tags INCLUDES '${tag}' AND created > now() - interval ${sinceMinutes} minute
    | sort: created DESC
    | limit: ${limit}
  `;

  const spans = await btql(q);
  console.log(`[inspect-real] fetched ${spans.length} span(s)\n`);

  if (spans.length === 0) {
    console.error(
      "[inspect-real] no spans match. Possible causes:\n" +
        `  - tag '${tag}' not actually on emitted spans (check config)\n` +
        `  - window too narrow (try --since 1440 for last day)\n` +
        `  - wrong project (you asked for '${projectName}')\n` +
        `  - spans never actually emitted (check gateway logs for heartbeat eventCount)`,
    );
    process.exit(1);
  }

  if (raw) {
    console.log(JSON.stringify(spans, null, 2));
    return;
  }

  if (tree) {
    // Group by root_span_id, then print each tree's spans together.
    const byRoot = new Map<string, Span[]>();
    for (const s of spans) {
      const root = s.root_span_id ?? s.id;
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root)!.push(s);
    }
    let i = 0;
    for (const [root, group] of byRoot) {
      i++;
      console.log("=".repeat(72));
      console.log(`Trace ${i} (root=${root}, ${group.length} span(s))`);
      console.log("=".repeat(72));
      // Sort: root first, then children by parent chain
      group.sort((a, b) => {
        if (a.id === root) return -1;
        if (b.id === root) return 1;
        return (a.created ?? "").localeCompare(b.created ?? "");
      });
      for (const s of group) {
        const depth = s.id === root ? 0 : 1;
        printSpan(s, depth);
        console.log("");
      }
    }
  } else {
    for (const s of spans) {
      console.log("=".repeat(72));
      printSpan(s);
    }
    console.log("=".repeat(72));
  }
}

main().catch((err) => {
  console.error("[inspect-real] failed:", err);
  process.exit(1);
});
