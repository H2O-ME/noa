/**
 * Per-run timing and throughput (M11 批6, surfaces' stats rows).
 *
 * A surface that wants to say "用时 13分59秒 · 首 token 5.6秒 · 42 tok/s" —
 * or to split a session's wall clock into provider time and tool time — needs
 * to know WHEN things happened, and the event stream deliberately carries no
 * timestamps (an event is protocol, not telemetry). So the timings are taken
 * where the events are already passing through once: `AgentSession.consume`.
 *
 * One run = one user prompt → its final answer, which may span several loop
 * iterations (`turn_start` … tools … `turn_start` …). Within it:
 *   - `llmMs` accumulates each provider request, so a run that spent its time
 *     in tools does not look like model latency;
 *   - `toolMs` accumulates each call (`tool_call_start` → `tool_call_result`);
 *   - `firstTokenMs` is the run's time-to-first-token, the number a user
 *     actually feels — it excludes queueing and the request's own preamble;
 *   - `retries` counts in-flight re-requests (`llm_retry`), which is why the
 *     reported duration can exceed the sum of the parts.
 *
 * **A request's window is opened and closed by explicit boundary calls, not
 * inferred from the event stream.** Neither end works by inference: `turn_start`
 * fires before `assembleRequest` (so hook, image-projection and in-place
 * auto-compaction time was charged to `llmMs`), and `usage` may never arrive (so
 * a request cut short by an abort silently vanished from `llmMs`). See
 * {@link RunMeter.requestStart} / {@link RunMeter.requestEnd}.
 *
 * Per-request timings (`RequestTiming`) record the same milestones PER LOOP
 * ITERATION — started/firstToken/finished — so a Timing card can draw a
 * TTFT/response-duration series across one run's requests without re-deriving
 * it from the event stream. A request that produced no tokens has no
 * `firstTokenAt` (a function-call-only reply); `finishedAt` is absent only for a
 * request still in flight when the run ends (abort, crash).
 *
 * Token counters sum the run's per-request `usage` reports. Nothing here is
 * model-visible or persisted: stats ride a `run_stats` event and die with the
 * surface (a resumed session starts counting at its own first run).
 */

/** One loop iteration's three timings, drawn as one row on a Timing card. */
export interface RequestTiming {
  /** The loop iteration this request belongs to (1-based, matches `turn_start.turn`). */
  turn: number;
  /** ms epoch when the assembled request reached the provider. */
  startedAt: number;
  /** ms epoch when the FIRST streamed token arrived; absent if none did. */
  firstTokenAt?: number;
  /** ms epoch when the request's stream settled; absent only if it was still open at run end. */
  finishedAt?: number;
}

/**
 * One run's timing and token summary. Emitted when the run ends — after
 * `done`, or after `run_failed` with whatever the abandoned run had
 * accumulated. Observability only: never logged, never model-visible, so a
 * surface can render throughput and split its session clock into model time
 * and tool time without re-deriving any of it from deltas.
 */
export interface RunStats {
  /** Wall-clock start (ms epoch) and total duration of the run. */
  startedAt: number;
  durationMs: number;
  /** Time to the run's first streamed token; absent when none arrived. */
  firstTokenMs?: number;
  /** Time inside provider requests / inside tool calls (both exclude waiting on approvals). */
  llmMs: number;
  toolMs: number;
  /** Provider requests (every hand-off to the provider, retries included). */
  requests: number;
  /** Tool calls executed. */
  toolCalls: number;
  /** In-flight re-requests (`llm_retry`) within those requests. */
  retries: number;
  /** Summed over the run's per-request usage reports. */
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /**
   * Per-request timings, one per loop iteration in the run (so length ===
   * `requests` when every request closed cleanly). A surface renders TTFT
   * and response-duration series from this; absent on old logs that predate
   * the field (a missing array reads as "no per-request timings" — the card
   * simply does not appear).
   */
  requestTimings?: readonly RequestTiming[];
}

/** Accumulates one run's timings. Injectable clock keeps it testable. */
export class RunMeter {
  private startedAt = 0;
  private firstTokenAt: number | undefined;
  private requestStartAt: number | undefined;
  private currentTurn = 0;
  private currentFirstTokenAt: number | undefined;
  private readonly requestTimings: RequestTiming[] = [];
  private llmMs = 0;
  private toolMs = 0;
  private readonly toolStarts = new Map<string, number>();
  private requests = 0;
  private toolCalls = 0;
  private retries = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private cachedTokens = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Begin a run: every counter resets, the clock starts. */
  start(): void {
    this.startedAt = this.now();
    this.firstTokenAt = undefined;
    this.requestStartAt = undefined;
    this.currentTurn = 0;
    this.currentFirstTokenAt = undefined;
    this.requestTimings.length = 0;
    this.llmMs = 0;
    this.toolMs = 0;
    this.toolStarts.clear();
    this.requests = 0;
    this.toolCalls = 0;
    this.retries = 0;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.cachedTokens = 0;
  }

  /**
   * An assembled request is being handed to the provider — the TRUE start of
   * provider time. Called by the session's counting provider, which is the one
   * place the request crosses into the provider; the event stream cannot mark
   * this instant (`turn_start` precedes request assembly and its hooks).
   *
   * A request that re-issues itself mid-stream (a `reset` retry) stays ONE
   * window: the session wraps the provider's whole `stream()` generator, so the
   * backoff between attempts is part of the latency the caller actually waited.
   * An empty-completion retry is a fresh `stream()` call and therefore a fresh
   * request, which is what it is on the wire.
   */
  requestStart(): void {
    this.requests += 1;
    this.requestStartAt = this.now();
    this.currentFirstTokenAt = undefined;
  }

  /**
   * The in-flight request's stream settled — EOF, error or abort. Closes the
   * window unconditionally, so a provider that never reports `usage` (or a
   * request cut short by an abort) still contributes its time instead of
   * silently vanishing from `llmMs` and from the per-request series.
   */
  requestEnd(): void {
    if (this.requestStartAt === undefined) return;
    const finishedAt = this.now();
    this.llmMs += finishedAt - this.requestStartAt;
    this.requestTimings.push({
      turn: this.currentTurn,
      startedAt: this.requestStartAt,
      ...(this.currentFirstTokenAt !== undefined ? { firstTokenAt: this.currentFirstTokenAt } : {}),
      finishedAt,
    });
    this.requestStartAt = undefined;
  }

  /** Fold one event into the run's numbers (called once, in consume()). */
  observe(event: { type: string } & Record<string, unknown>): void {
    switch (event.type) {
      case 'turn_start': {
        // Labels the requests that follow; it does NOT open one — the request
        // window belongs to `requestStart` (see the class doc).
        this.currentTurn = (event['turn'] as number | undefined) ?? this.currentTurn + 1;
        this.currentFirstTokenAt = undefined;
        break;
      }
      case 'usage': {
        // Token counters only. The request's WINDOW is closed by requestEnd —
        // closing it here was what stranded every request whose provider never
        // reported usage.
        const usage = event['usage'] as { promptTokens: number; completionTokens: number; cachedTokens: number };
        this.promptTokens += usage.promptTokens;
        this.completionTokens += usage.completionTokens;
        this.cachedTokens += usage.cachedTokens;
        break;
      }
      case 'text_delta':
      case 'reasoning_delta': {
        const now = this.now();
        this.firstTokenAt ??= now;
        // Record the first token of the CURRENT provider request (its TTFT),
        // not just the run's. The check is per-request: a request that
        // streams no tokens (a function-call-only response) stays without one.
        if (this.requestStartAt !== undefined) this.currentFirstTokenAt ??= now;
        break;
      }
      case 'tool_call_start': {
        const call = event['call'] as { id: string };
        this.toolCalls += 1;
        this.toolStarts.set(call.id, this.now());
        break;
      }
      case 'tool_call_result': {
        const call = event['call'] as { id: string };
        const startedAt = this.toolStarts.get(call.id);
        if (startedAt !== undefined) {
          this.toolMs += this.now() - startedAt;
          this.toolStarts.delete(call.id);
        }
        break;
      }
      case 'llm_retry':
        this.retries += 1;
        break;
      default:
        break;
    }
  }

  /** The run's summary. Safe to call at any point (a failed run reports partials). */
  finish(): RunStats {
    const endedAt = this.now();
    // If a request is still in flight when the run ends (abort mid-stream, a
    // consumer that stopped pulling), record it so the per-request series is
    // not silently shorter than `requests` — without a `finishedAt`, because
    // the request genuinely has not finished.
    const timings = [...this.requestTimings];
    if (this.requestStartAt !== undefined) {
      timings.push({
        turn: this.currentTurn,
        startedAt: this.requestStartAt,
        ...(this.currentFirstTokenAt !== undefined ? { firstTokenAt: this.currentFirstTokenAt } : {}),
      });
    }
    return {
      startedAt: this.startedAt,
      durationMs: Math.max(0, endedAt - this.startedAt),
      ...(this.firstTokenAt !== undefined ? { firstTokenMs: Math.max(0, this.firstTokenAt - this.startedAt) } : {}),
      llmMs: this.llmMs,
      toolMs: this.toolMs,
      requests: this.requests,
      toolCalls: this.toolCalls,
      retries: this.retries,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedTokens: this.cachedTokens,
      requestTimings: timings,
    };
  }
}
