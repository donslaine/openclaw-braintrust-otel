// Smoke test for the braintrust-otel plugin.
//
// Stubs the OpenClaw plugin context, fires a scripted sequence of
// synthetic diagnostic events through the real service, and flushes
// spans to Braintrust. No OpenClaw host required.
//
// Run:
//   BRAINTRUST_API_KEY=sk_... \
//   BRAINTRUST_PARENT=project_name:braintrust-otel-smoke \
//   BRAINTRUST_SESSION_HASH_SALT=smoke-salt \
//   npx tsx plugins/braintrust-otel/scripts/smoke.ts
//
// Flags:
//   --parent project_name:foo   override BRAINTRUST_PARENT
//   --service-name openclaw-x   override the service.name resource attr
//   --keep-content              capture braintrust.input / output
//
// Expected output in Braintrust: one root span "openclaw.run" with three
// children — "openclaw.model.call", "openclaw.model.usage" (type=llm,
// with token + cost metrics), and "openclaw.tool.execution" (type=tool).

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBraintrustOtelService } from "../src/service.js";

const HERE = dirname(fileURLToPath(import.meta.url));

type AnyEvent = { type: string; ts: number; seq: number; [k: string]: unknown };

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const parentOverride = flag("parent");
if (parentOverride) process.env.BRAINTRUST_PARENT = parentOverride;
const serviceName = flag("service-name") ?? "openclaw-smoke";
const keepContent = hasFlag("keep-content");

if (!process.env.BRAINTRUST_API_KEY) {
  console.error("BRAINTRUST_API_KEY is required");
  process.exit(1);
}
if (!process.env.BRAINTRUST_PARENT) {
  // Default to a throwaway project so smoke runs never touch real data.
  process.env.BRAINTRUST_PARENT = "project_name:braintrust-otel-smoke";
}
if (!process.env.BRAINTRUST_SESSION_HASH_SALT) {
  process.env.BRAINTRUST_SESSION_HASH_SALT = "smoke-salt";
}

// Stub for ctx.internalDiagnostics.onEvent — captures the listener so we
// can drive events from the script.
let listener:
  | ((event: AnyEvent, meta: { trusted: boolean }) => void)
  | undefined;
const ctx = {
  internalDiagnostics: {
    onEvent: (
      fn: (event: AnyEvent, meta: { trusted: boolean }) => void,
    ) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
  },
  config: {
    serviceName,
    tags: ["smoke-test"],
    captureContent: keepContent
      ? {
          input: true,
          output: true,
          toolInputs: true,
          toolOutputs: true,
          systemPrompt: false,
        }
      : undefined,
  },
};

function emit(event: AnyEvent) {
  if (!listener) throw new Error("service did not subscribe");
  listener(event, { trusted: true });
}

async function main() {
  const service = createBraintrustOtelService();
  await service.start(ctx as never);

  const runId = `smoke-run-${Date.now()}`;
  const callId = `smoke-call-${Date.now()}`;
  const toolCallId = `smoke-tool-${Date.now()}`;
  const sessionId = `smoke-session-abc123`;
  const sessionKey = `telegram:direct:5551234567`;

  let seq = 0;
  const now = () => Date.now();
  const ev = (extra: Record<string, unknown>): AnyEvent => ({
    ts: now(),
    seq: seq++,
    runId,
    sessionId,
    sessionKey,
    ...extra,
  } as AnyEvent);

  console.log(`[smoke] firing events for runId=${runId}`);

  // Run starts.
  emit(
    ev({
      type: "run.started",
      agent: "jeffery",
      channel: "telegram",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      trigger: "message",
      sessionKind: "telegram_direct",
    }),
  );

  // Model call lifecycle.
  emit(
    ev({
      type: "model.call.started",
      callId,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      api: "messages",
      transport: "https",
      contextTokenBudget: 200_000,
      upstreamRequestIdHash: "abc12345",
    }),
  );

  // Tool execution lifecycle (nested inside the run, alongside the model call).
  emit(
    ev({
      type: "tool.execution.started",
      toolName: "search",
      toolCallId,
      paramsSummary: { query: "smoke test" },
    }),
  );
  await sleep(20);
  emit(
    ev({
      type: "tool.execution.completed",
      toolName: "search",
      toolCallId,
      durationMs: 18,
    }),
  );

  await sleep(30);
  emit(
    ev({
      type: "model.call.completed",
      callId,
      durationMs: 450,
      requestPayloadBytes: 1234,
      responseStreamBytes: 5678,
      timeToFirstByteMs: 220,
    }),
  );

  // Model usage (llm span with cost + tokens).
  emit(
    ev({
      type: "model.usage",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      costUsd: 0.0123,
      tokens: { input: 1024, output: 256, cache: 0, total: 1280 },
      input: [
        { role: "system", content: "you are a smoke test" },
        { role: "user", content: "hello" },
      ],
      output: "hi there",
    }),
  );

  // Run completes.
  emit(ev({ type: "run.completed" }));

  console.log("[smoke] flushing spans...");
  await service.stop();
  const salt = process.env.BRAINTRUST_SESSION_HASH_SALT ?? "";
  const runIdHash = createHash("sha256")
    .update(salt)
    .update(runId)
    .digest("hex")
    .slice(0, 16);

  const manifest = {
    parent: process.env.BRAINTRUST_PARENT,
    serviceName,
    tags: ["smoke-test"],
    runId,
    runIdHash,
    callId,
    toolCallId,
    expected: {
      // What we expect verify.ts to find.
      spanNames: [
        "openclaw.run",
        "openclaw.model.call",
        "openclaw.model.usage",
        "openclaw.tool.execution",
      ],
      metrics: {
        prompt_tokens: 1024,
        completion_tokens: 256,
        tokens: 1280,
        cost: 0.0123,
      },
      spanTypes: {
        "openclaw.model.usage": "llm",
        "openclaw.tool.execution": "tool",
      },
    },
    timestamp: new Date().toISOString(),
  };
  const manifestPath = resolve(HERE, "..", ".last-smoke.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("[smoke] done. Check Braintrust:");
  console.log(`  parent: ${process.env.BRAINTRUST_PARENT}`);
  console.log(`  service.name: ${serviceName}`);
  console.log(`  tags: ["smoke-test"]`);
  console.log(`  runId: ${runId}`);
  console.log(`  manifest: ${manifestPath}`);
  console.log(`\nRun: npm run verify`);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exit(1);
});
