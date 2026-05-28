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
};

export class IoBuffer {
  private byRun = new Map<string, RunBuffer>();
  /** sessionKey || sessionId → most-recently-opened open model.call span. */
  private openModelCallBySession = new Map<string, unknown>();
  private enabled: boolean;

  constructor(opts: IoBufferOptions = {}) {
    this.enabled = opts.enabled ?? true;
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
   * Key is `sessionKey ?? sessionId`. When both calls exist concurrently
   * for a single session (rare), the most recent overwrites the previous;
   * the older call's usage event would be misparented. Acceptable given
   * model.usage carries neither runId nor callId — upstream limitation.
   */
  setOpenModelCallSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
    span: unknown,
  ): void {
    const key = sessionKey ?? sessionId;
    if (!key) return;
    this.openModelCallBySession.set(key, span);
  }

  clearOpenModelCallSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
    span: unknown,
  ): void {
    const key = sessionKey ?? sessionId;
    if (!key) return;
    // Only clear if the span matches — guards against a newer concurrent
    // call clobbering its own registration when an older call closes.
    if (this.openModelCallBySession.get(key) === span) {
      this.openModelCallBySession.delete(key);
    }
  }

  getOpenModelCallSpanForSession(
    sessionKey: string | undefined,
    sessionId: string | undefined,
  ): unknown {
    const key = sessionKey ?? sessionId;
    if (!key) return undefined;
    return this.openModelCallBySession.get(key);
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
