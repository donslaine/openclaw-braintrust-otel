// In-memory buffer for LLM input/output and tool middleware payloads,
// plus a session-keyed registry of open model.call spans used to parent
// model.usage events.
//
// This module is OTEL-agnostic on purpose. Spans are stored as `unknown`
// so the service owns all OTEL-typed concerns; the buffer is just a
// keyed registry.
//
// Lifecycle:
//   - LLM I/O is keyed by runId. Cleared when the run span closes.
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
};

export type CallSlot = {
  input?: LlmInputPayload;
  output?: LlmOutputPayload;
};

type RunBuffer = {
  calls: CallSlot[];
  toolCalls: Map<string, ToolMiddlewarePayload>;
};

export type IoBufferOptions = {
  /** Max LLM call slots retained per run. Older slots are dropped on overflow. */
  maxCallsPerRun?: number;
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
  private readonly maxCalls: number;
  private enabled: boolean;

  constructor(opts: IoBufferOptions = {}) {
    this.maxCalls = Math.max(1, opts.maxCallsPerRun ?? 50);
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
    buf.calls.push({ input: payload });
    this.trim(buf);
  }

  recordLlmOutput(payload: LlmOutputPayload): void {
    if (!this.enabled) return;
    const buf = this.ensure(payload.runId);
    // Match to the most recent call slot that has an input but no output.
    for (let i = buf.calls.length - 1; i >= 0; i--) {
      const slot = buf.calls[i];
      if (slot && slot.input && !slot.output) {
        slot.output = payload;
        return;
      }
    }
    // Output without a prior input (raw-run path or input was gated).
    buf.calls.push({ output: payload });
    this.trim(buf);
  }

  /**
   * Pop the oldest paired call slot for this run. If no fully-paired slot
   * exists, returns the oldest slot with just an input. Used by the
   * attribute mapper when closing a model.call span.
   */
  takeCallIo(runId: string): CallSlot | undefined {
    const buf = this.byRun.get(runId);
    if (!buf || buf.calls.length === 0) return undefined;
    for (let i = 0; i < buf.calls.length; i++) {
      const slot = buf.calls[i];
      if (slot && slot.input && slot.output) {
        return buf.calls.splice(i, 1)[0];
      }
    }
    for (let i = 0; i < buf.calls.length; i++) {
      const slot = buf.calls[i];
      if (slot && slot.input) {
        return buf.calls.splice(i, 1)[0];
      }
    }
    return buf.calls.shift();
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
    let firstInput: LlmInputPayload | undefined;
    for (const slot of buf.calls) {
      if (slot.input) {
        firstInput = slot.input;
        break;
      }
    }
    let lastOutput: LlmOutputPayload | undefined;
    for (let i = buf.calls.length - 1; i >= 0; i--) {
      const slot = buf.calls[i];
      if (slot && slot.output) {
        lastOutput = slot.output;
        break;
      }
    }
    return { firstInput, lastOutput };
  }

  // ---- Tool middleware payloads ----------------------------------------

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
    totalCalls: number;
    totalToolCalls: number;
    sessionParents: number;
  } {
    let totalCalls = 0;
    let totalToolCalls = 0;
    for (const buf of this.byRun.values()) {
      totalCalls += buf.calls.length;
      totalToolCalls += buf.toolCalls.size;
    }
    return {
      runs: this.byRun.size,
      totalCalls,
      totalToolCalls,
      sessionParents: this.openModelCallBySession.size,
    };
  }

  // ---- Internals -------------------------------------------------------

  private ensure(runId: string): RunBuffer {
    let buf = this.byRun.get(runId);
    if (!buf) {
      buf = { calls: [], toolCalls: new Map() };
      this.byRun.set(runId, buf);
    }
    return buf;
  }

  private trim(buf: RunBuffer): void {
    while (buf.calls.length > this.maxCalls) {
      buf.calls.shift();
    }
  }
}
