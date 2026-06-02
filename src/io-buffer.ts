// In-memory buffer for LLM input/output and tool middleware payloads,
// plus a session-keyed registry of open model.call spans used to parent
// model.usage events.
//
// This module is OTEL-agnostic on purpose. Spans are stored as `unknown`
// so the service owns all OTEL-typed concerns; the buffer is just a
// keyed registry.
//
// Lifecycle:
//   - LLM I/O is keyed by runId. firstInput/lastOutput snapshots are
//     attached to the openclaw.run span at run-close. Per-call I/O is
//     not captured: llm_input / llm_output are turn-level hooks and
//     can't be reliably attributed to a single model.call (a turn may
//     contain multiple calls).
//   - Tool middleware payloads are keyed by (runId, toolCallId). Each is
//     consumed once when the corresponding tool.execution span closes.
//   - Open model.call spans are keyed by sessionKey (preferred) or
//     sessionId. The most-recently-opened call for a session is the
//     parent of any model.usage event fired for that session, since
//     model.usage carries no runId or callId of its own.

export type LlmInputPayload = {
  runId: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages?: unknown[];
  imagesCount?: number;
  tools?: unknown[];
};

export type LlmOutputPayload = {
  runId: string;
  sessionId?: string;
  provider?: string;
  model?: string;
  prompt?: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  contextTokenBudget?: number;
  resolvedRef?: string;
  harnessId?: string;
};

export type ToolMiddlewarePayload = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  threadId?: string;
  turnId?: string;
  durationMs?: number;
  /**
   * Text reasoning from the assistant message that requested this tool call.
   * Extracted from TextContent blocks that precede the ToolCall block in the
   * assistant response (i.e. the model's stated rationale). Only present when
   * captureContent is enabled and the model emitted pre-tool text.
   */
  rationale?: string;
  /**
   * Extended thinking (scratchpad) content from the assistant message that
   * requested this tool call. Only present when captureContent is enabled,
   * the model uses extended thinking, and the thinking block was not redacted.
   */
  thinking?: string;
  /**
   * True when the assistant message contained a redacted thinking block before
   * this tool call. The thinking text itself is not available in that case.
   */
  thinkingRedacted?: boolean;
};

/**
 * Partial payload from `before_tool_call`. Records tool intent +
 * arguments before execution. Merged with the matching
 * `after_tool_call` payload at consume time.
 */
export type ToolBeforePayload = {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  threadId?: string;
  turnId?: string;
  /** Pre-tool reasoning text extracted from the preceding assistant message. */
  rationale?: string;
  /** Extended thinking content from the preceding assistant message. */
  thinking?: string;
  /** True if the preceding assistant message had a redacted thinking block. */
  thinkingRedacted?: boolean;
};

/**
 * Partial payload from `after_tool_call`. Carries result + outcome
 * after execution. Joins to the matching `before_tool_call` payload
 * via toolCallId.
 */
export type ToolAfterPayload = {
  toolCallId: string;
  toolName?: string;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
};

// Minimal parsed shape of an AssistantMessage content block.
// We only need the fields used for reasoning extraction — keeping
// this narrow avoids coupling to the full openclaw agent-core types.
type AssistantTextBlock = { type: "text"; text: string };
type AssistantThinkingBlock = {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
};
type AssistantToolCallBlock = { type: "toolCall"; id: string };
type AssistantContentBlock =
  | AssistantTextBlock
  | AssistantThinkingBlock
  | AssistantToolCallBlock
  | { type: string }; // unknown block types — ignored

type PendingAssistantMessage = {
  content: AssistantContentBlock[];
};

type RunBuffer = {
  toolCalls: Map<string, ToolMiddlewarePayload>;
  // Run-level snapshots: first prompt seen and last assistant output
  // observed for the run. Used by buildRunIoAttrs at run-close to
  // populate braintrust.input / braintrust.output on the run span.
  firstInput?: LlmInputPayload;
  lastOutput?: LlmOutputPayload;
  // Most-recent assistant message for this run. Overwritten on each
  // llm_output. Read by extractToolRationale when before_tool_call
  // fires so tool spans carry the model's pre-call reasoning.
  pendingAssistant?: PendingAssistantMessage;
};

export type IoBufferOptions = {
  /**
   * Initial enabled state. The service flips this at start() based on
   * the resolved `captureContent.enabled` config via setEnabled().
   * Default is true so tests don't need to opt in; the plugin entry
   * constructs the buffer with `false` to keep content capture off
   * until config explicitly turns it on.
   */
  enabled?: boolean;
  /**
   * Milliseconds after `clearOpenModelCallSpanForSession` during which
   * the entry is still findable by `getOpenModelCallSpanForSession`.
   * Fixes the race where `model.usage` arrives after the matching
   * `model_call_ended` has already cleared the registry — happens
   * routinely in practice because the bus event is asynchronous and
   * the typed hook fires synchronously. Default 5000 ms.
   */
  openModelCallTtlMs?: number;
  /**
   * Clock injection for tests. Defaults to `Date.now`. Tests can swap
   * a controllable clock to drive the TTL behavior deterministically.
   */
  now?: () => number;
};

type OpenCallEntry = {
  span: unknown;
  // Wall-clock timestamp of the matching clearOpenModelCallSpanForSession.
  // Undefined while the call is still open.
  closedAt?: number;
};

export class IoBuffer {
  private byRun = new Map<string, RunBuffer>();
  /**
   * Open or recently-closed model.call entries, keyed under BOTH
   * sessionKey and sessionId when both are present. Closed entries
   * persist for `openModelCallTtlMs` so a trailing model.usage event
   * still finds its parent (the typical race in production).
   */
  private openModelCallBySession = new Map<string, OpenCallEntry>();
  /**
   * Backstop registry: sessionKey / sessionId → openclaw.run span.
   * Populated on run.started, cleared on run.completed. Used by
   * model.usage when no matching model.call entry exists (call closed
   * + TTL expired, or call never opened) so the usage span at least
   * parents to the run instead of going fully orphan.
   */
  private openRunBySession = new Map<string, unknown>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private enabled: boolean;

  constructor(opts: IoBufferOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.ttlMs = Math.max(0, opts.openModelCallTtlMs ?? 5000);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Flip the content-capture gate. Called by service.start() once the
   * plugin config has been resolved. Hooks registered at module load
   * (before start) gate their record* calls on this value.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ---- LLM I/O ----------------------------------------------------------

  recordLlmInput(payload: LlmInputPayload): void {
    if (!this.enabled) return;
    const buf = this.ensure(payload.runId);
    // llm_input is a turn-level hook (fires once per turn, not per
    // model call). Capture the first prompt for run-level
    // braintrust.input attribution. We deliberately do not attempt to
    // pair per-call: the openclaw runtime fires llm_input once per
    // turn but emits N model.call.started events per turn, so any
    // pairing is wrong by construction (v0.2.x bug).
    if (!buf.firstInput) buf.firstInput = payload;
  }

  recordLlmOutput(payload: LlmOutputPayload): void {
    if (!this.enabled) return;
    const buf = this.ensure(payload.runId);
    // Same shape as recordLlmInput: turn-level capture only. Last
    // observed output wins so multi-turn runs surface the final
    // assistant message on the run span.
    buf.lastOutput = payload;
  }

  /**
   * Store the raw `lastAssistant` object from an `llm_output` hook
   * event so subsequent `before_tool_call` events for the same run can
   * extract per-tool reasoning via `extractToolRationale`.
   *
   * Parses only the fields needed for reasoning extraction (type, text,
   * thinking, id) — ignores everything else so we stay decoupled from
   * the full openclaw AssistantMessage type. Gated by `enabled` because
   * thinking/text content is conversation data.
   */
  setPendingAssistantMessage(runId: string, lastAssistant: unknown): void {
    if (!this.enabled) return;
    if (!runId) return;
    const raw = lastAssistant as
      | { content?: unknown[] }
      | null
      | undefined;
    if (!raw?.content) return;
    const content: AssistantContentBlock[] = [];
    for (const block of raw.content) {
      const b = block as Record<string, unknown>;
      if (b["type"] === "text" && typeof b["text"] === "string") {
        content.push({ type: "text", text: b["text"] });
      } else if (
        b["type"] === "thinking" &&
        typeof b["thinking"] === "string"
      ) {
        content.push({
          type: "thinking",
          thinking: b["thinking"],
          redacted: b["redacted"] === true,
        });
      } else if (b["type"] === "toolCall" && typeof b["id"] === "string") {
        content.push({ type: "toolCall", id: b["id"] });
      } else if (typeof b["type"] === "string") {
        content.push({ type: b["type"] });
      }
    }
    this.ensure(runId).pendingAssistant = { content };
  }

  /**
   * Extract the reasoning that preceded a specific tool call from the
   * most-recently-stored pending assistant message for the run.
   *
   * Scans the assistant content blocks for the `toolCall` block whose
   * `id` matches `toolCallId`, then collects:
   *   - text blocks before it → `rationale` (joined by newline)
   *   - non-redacted thinking blocks before it → `thinking`
   *   - whether any redacted thinking block was present → `thinkingRedacted`
   *
   * Returns empty object if there is no pending message, if the
   * toolCallId is not found, or if no relevant blocks precede it.
   */
  extractToolRationale(
    runId: string,
    toolCallId: string,
  ): {
    rationale?: string;
    thinking?: string;
    thinkingRedacted?: boolean;
  } {
    const buf = this.byRun.get(runId);
    const msg = buf?.pendingAssistant;
    if (!msg) return {};
    const idx = msg.content.findIndex(
      (b) => b.type === "toolCall" && (b as AssistantToolCallBlock).id === toolCallId,
    );
    if (idx === -1) return {};
    // Only collect blocks between the PREVIOUS toolCall (exclusive) and this
    // one. Text/thinking before an earlier tool call belongs to that call's
    // rationale, not this one. Find the last toolCall block before idx.
    const prevToolCallIdx = (() => {
      for (let i = idx - 1; i >= 0; i--) {
        if (msg.content[i].type === "toolCall") return i;
      }
      return -1;
    })();
    const before = msg.content.slice(prevToolCallIdx + 1, idx);
    const textParts = before
      .filter((b): b is AssistantTextBlock => b.type === "text")
      .map((b) => b.text)
      .filter(Boolean);
    const thinkingParts = before.filter(
      (b): b is AssistantThinkingBlock =>
        b.type === "thinking" && "thinking" in b && !b.redacted,
    );
    const hasRedacted = before.some(
      (b): b is AssistantThinkingBlock =>
        b.type === "thinking" && "thinking" in b && !!b.redacted,
    );
    return {
      rationale: textParts.length > 0 ? textParts.join("\n") : undefined,
      thinking:
        thinkingParts.length > 0
          ? thinkingParts.map((b) => b.thinking).join("\n")
          : undefined,
      thinkingRedacted: hasRedacted ? true : undefined,
    };
  }

  /**
   * Non-consuming peek used by the run-level attribute mapper to derive
   * `braintrust.input` (first prompt) and `braintrust.output` (last
   * assistant text) when the run span closes.
   */
  peekRunIo(runId: string): {
    firstInput?: LlmInputPayload;
    lastOutput?: LlmOutputPayload;
  } {
    const buf = this.byRun.get(runId);
    if (!buf) return {};
    return { firstInput: buf.firstInput, lastOutput: buf.lastOutput };
  }

  // ---- Tool middleware payloads ----------------------------------------

  /**
   * Record an args-side tool payload from `before_tool_call`. If an
   * `after_tool_call` payload has already landed for this toolCallId
   * (out-of-order delivery, rare but possible), the existing record is
   * augmented rather than overwritten.
   *
   * Identity fields (toolCallId, toolName, threadId, turnId) are always
   * recorded — they are structural context, not conversation content.
   * Args are only recorded when content capture is enabled.
   */
  recordToolBefore(
    payload: ToolBeforePayload,
    runId: string | undefined,
  ): void {
    if (!runId) return;
    const buf = this.ensure(runId);
    const existing = buf.toolCalls.get(payload.toolCallId);
    buf.toolCalls.set(payload.toolCallId, {
      ...existing,
      toolCallId: payload.toolCallId,
      // before_tool_call is authoritative on tool identity. If we
      // optimistically stored a placeholder when an out-of-order after
      // landed first, replace it now.
      toolName: payload.toolName,
      // args are content — only capture when enabled.
      args: this.enabled ? (payload.args ?? existing?.args) : existing?.args,
      threadId: payload.threadId ?? existing?.threadId,
      turnId: payload.turnId ?? existing?.turnId,
      // reasoning fields are content — already undefined when captureContent
      // is off because extractToolRationale returns {} when setPendingAssistantMessage
      // is gated. Pass through whatever the caller extracted.
      rationale: payload.rationale ?? existing?.rationale,
      thinking: payload.thinking ?? existing?.thinking,
      thinkingRedacted: payload.thinkingRedacted ?? existing?.thinkingRedacted,
    });
  }

  /**
   * Record a result-side tool payload from `after_tool_call`. Joins to
   * the matching `before_tool_call` payload by toolCallId. When no
   * before-payload has landed yet (unusual — tool fired without prior
   * args capture), a result-only entry is created.
   *
   * Identity fields (toolCallId, toolName, durationMs, isError) are always
   * recorded. Result content is only recorded when content capture is enabled.
   */
  recordToolAfter(payload: ToolAfterPayload, runId: string | undefined): void {
    if (!runId) return;
    const buf = this.ensure(runId);
    const existing = buf.toolCalls.get(payload.toolCallId);
    buf.toolCalls.set(payload.toolCallId, {
      ...existing,
      toolCallId: payload.toolCallId,
      // Prefer the toolName from a prior before_tool_call (it's
      // authoritative). Fall back to whatever after surfaces. Leave
      // unset rather than substituting "unknown" — consumer code can
      // decide how to display a missing name.
      toolName: existing?.toolName ?? payload.toolName ?? "",
      // result is content — only capture when enabled.
      result: this.enabled
        ? (payload.result ?? existing?.result)
        : existing?.result,
      isError: payload.isError ?? existing?.isError,
      durationMs: payload.durationMs ?? existing?.durationMs,
    });
  }

  /**
   * @deprecated Single-call tool recording from the legacy
   * `AgentToolResultMiddleware` path. Kept for back-compat with
   * existing tests; new code should use recordToolBefore +
   * recordToolAfter to mirror the public before_tool_call /
   * after_tool_call hooks landing separately.
   */
  recordToolResult(
    payload: ToolMiddlewarePayload,
    runId: string | undefined,
  ): void {
    if (!this.enabled) return;
    if (!runId) return;
    const buf = this.ensure(runId);
    buf.toolCalls.set(payload.toolCallId, payload);
  }

  takeToolIo(
    runId: string,
    toolCallId: string,
  ): ToolMiddlewarePayload | undefined {
    const buf = this.byRun.get(runId);
    if (!buf) return undefined;
    const v = buf.toolCalls.get(toolCallId);
    if (v) buf.toolCalls.delete(toolCallId);
    return v;
  }

  // ---- Open model.call span tracking (for model.usage parenting) -------

  /**
   * Register an open model.call span for a session. Subsequent model.usage
   * events for the same session look this span up via
   * `getOpenModelCallSpanForSession`.
   *
   * Indexed under BOTH `sessionKey` and `sessionId` when both are
   * present — the upstream `DiagnosticUsageEvent` carries one or both
   * (inconsistently), so dual-keying makes the lookup robust to
   * whichever side the runtime populated. When both calls exist
   * concurrently for a single session (rare), the most recent
   * overwrites the previous; the older call's usage event would be
   * misparented. Acceptable given model.usage carries neither runId
   * nor callId — upstream limitation.
   */
  setOpenModelCallSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
    span: unknown,
  ): void {
    const entry: OpenCallEntry = { span };
    if (sessionKey) this.openModelCallBySession.set(sessionKey, entry);
    if (sessionId && sessionId !== sessionKey)
      this.openModelCallBySession.set(sessionId, entry);
  }

  /**
   * Mark the call's registry entries as closed (TTL starts). Entries
   * remain findable by `getOpenModelCallSpanForSession` for
   * `openModelCallTtlMs` milliseconds so a trailing model.usage event
   * still pairs with the just-closed call. Guards against the
   * concurrent-call race by only marking entries whose span matches.
   */
  clearOpenModelCallSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
    span: unknown,
  ): void {
    const closedAt = this.now();
    const markIfMatch = (key: string | undefined) => {
      if (!key) return;
      const existing = this.openModelCallBySession.get(key);
      if (existing && existing.span === span && existing.closedAt === undefined)
        existing.closedAt = closedAt;
    };
    markIfMatch(sessionKey);
    markIfMatch(sessionId);
  }

  /**
   * Look up the open or recently-closed model.call span for a session.
   * Tries `sessionKey` first, then `sessionId`. Returns undefined if
   * the entry is missing or the post-close TTL has elapsed.
   */
  getOpenModelCallSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
  ): unknown {
    const tryKey = (key: string | undefined): unknown => {
      if (!key) return undefined;
      const entry = this.openModelCallBySession.get(key);
      if (!entry) return undefined;
      // Use >= so ttlMs:0 means "no grace period" (immediate expiry
      // on close). Otherwise ttlMs:0 with `now()===closedAt` would
      // still return the entry on the close-time call.
      if (
        entry.closedAt !== undefined &&
        this.now() - entry.closedAt >= this.ttlMs
      )
        return undefined;
      return entry.span;
    };
    return tryKey(sessionKey) ?? tryKey(sessionId);
  }

  // ---- Open run span tracking (model.usage backstop) -------------------

  /**
   * Register the open openclaw.run span for a session. Subsequent
   * model.usage events that find no matching model.call entry use
   * this as a backstop parent so the span at least lands under the
   * run instead of going fully orphan. Indexed under both sessionKey
   * and sessionId.
   */
  setOpenRunSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
    span: unknown,
  ): void {
    if (sessionKey) this.openRunBySession.set(sessionKey, span);
    if (sessionId && sessionId !== sessionKey)
      this.openRunBySession.set(sessionId, span);
  }

  clearOpenRunSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
    span: unknown,
  ): void {
    if (sessionKey && this.openRunBySession.get(sessionKey) === span)
      this.openRunBySession.delete(sessionKey);
    if (sessionId && this.openRunBySession.get(sessionId) === span)
      this.openRunBySession.delete(sessionId);
  }

  getOpenRunSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
  ): unknown {
    if (sessionKey) {
      const v = this.openRunBySession.get(sessionKey);
      if (v) return v;
    }
    if (sessionId) {
      const v = this.openRunBySession.get(sessionId);
      if (v) return v;
    }
    return undefined;
  }

  // ---- Run lifecycle ---------------------------------------------------

  clearRun(runId: string): void {
    this.byRun.delete(runId);
  }

  stats(): {
    runs: number;
    totalToolCalls: number;
    sessionParents: number;
  } {
    let totalToolCalls = 0;
    for (const buf of this.byRun.values()) {
      totalToolCalls += buf.toolCalls.size;
    }
    return {
      runs: this.byRun.size,
      totalToolCalls,
      sessionParents: this.openModelCallBySession.size,
    };
  }

  // ---- Internals -------------------------------------------------------

  private ensure(runId: string): RunBuffer {
    let buf = this.byRun.get(runId);
    if (!buf) {
      buf = { toolCalls: new Map() };
      this.byRun.set(runId, buf);
    }
    return buf;
  }
}
