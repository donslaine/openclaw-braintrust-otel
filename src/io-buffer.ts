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

type RunBuffer = {
  toolCalls: Map<string, ToolMiddlewarePayload>;
  // Run-level snapshots: first prompt seen and last assistant output
  // observed for the run. Used by buildRunIoAttrs at run-close to
  // populate braintrust.input / braintrust.output on the run span.
  firstInput?: LlmInputPayload;
  lastOutput?: LlmOutputPayload;
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
   */
  recordToolBefore(
    payload: ToolBeforePayload,
    runId: string | undefined,
  ): void {
    if (!this.enabled) return;
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
      args: payload.args ?? existing?.args,
      threadId: payload.threadId ?? existing?.threadId,
      turnId: payload.turnId ?? existing?.turnId,
    });
  }

  /**
   * Record a result-side tool payload from `after_tool_call`. Joins to
   * the matching `before_tool_call` payload by toolCallId. When no
   * before-payload has landed yet (unusual — tool fired without prior
   * args capture), a result-only entry is created.
   */
  recordToolAfter(payload: ToolAfterPayload, runId: string | undefined): void {
    if (!this.enabled) return;
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
      result: payload.result ?? existing?.result,
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
