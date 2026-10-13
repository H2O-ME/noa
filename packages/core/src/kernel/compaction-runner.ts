/**
 * The session's compaction lifecycle: the public "compact now" door, the
 * run-boundary gates, and the in-flight bookkeeping that keeps one compaction
 * from overlapping another.
 *
 * This lived inside `AgentSession` and is separated for two reasons. It is a
 * distinct responsibility — WHEN the session compacts, as opposed to how a run
 * consumes events — and it carries a failure that is easy to reintroduce: the
 * public door rejects while a run is active, so the boundary gates must call the
 * private path instead. Routing them through the door rejected *every* automatic
 * compaction with "cannot compact while a run is active", which surfaced as a
 * `compact_failed` notice on every over-limit turn and made automatic compaction
 * never once happen.
 *
 * The host interface is deliberately narrow: the runner publishes, moves the
 * phase, and asks whether a run is open. It does not reach into the session's
 * message array, because the one thing that must stay true about compaction is
 * that the SPLICE is visible to every consumer holding that same array.
 */
import { shouldCompactBefore } from '../auto-compact.js';
import { compactSession } from '../compact.js';
import type { CompactedSession, CompactSessionOptions } from '../compact.js';
import type { AgentMessage, ChatProvider, ToolDefinition } from '../types.js';
import type { Session } from '../session.js';
import { errMessage } from '../errors.js';
import type { UsageAnchorState } from './usage-anchor.js';

/** What the compaction runner needs from the session that owns it. */
export interface CompactionHost {
  /** The durable log (the strategy appends its own events to it). */
  session(): Session;
  /** The ONE live message array, spliced in place on success. */
  messages(): AgentMessage[];
  /** The provider the summary request is billed to. */
  provider(): ChatProvider;
  /** The strategy seam; core's own `compactSession` when the assembly set none. */
  strategy(): ((options: CompactSessionOptions) => Promise<CompactedSession>) | undefined;
  /** Publish onto the session's one event stream. */
  publishStart(trigger: 'auto' | 'manual'): void;
  /**
   * Commit a finished compaction: splice the live surface in place, reset the
   * anchors, publish `compaction` done. Owned by the session, so this gate and
   * the headless per-request gate cannot disagree about what a finished
   * compaction means.
   */
  commitCompaction(trigger: 'auto' | 'manual', outcome: CompactedSession): void;
  publishError(trigger: 'auto' | 'manual', message: string): void;
  /** Move the run's phase to `compacting`, and back afterwards. */
  setPhase(phase: 'compacting' | 'tool' | 'idle'): void;
  /** Is a run open right now? Decides the phase to hand back to. */
  running(): boolean;
  /** Terminal for prompts: a closed session compacts nothing more. */
  closed(): boolean;
  /** The system prompt the preflight prediction sizes (it is part of a request). */
  requestSystemPrompt(): string;
  /** The live tool set the preflight prediction sizes (also part of a request). */
  requestTools(): ToolDefinition[];
  /** Operational line to the surface (a failed auto-compaction is reported, not thrown). */
  notice(text: string): void;
  /** The session's anchor state, reset when the surface is spliced. */
  anchors(): UsageAnchorState;
}

/**
 * One compaction at a time, per host.
 *
 * The interlock is per-instance rather than global because two sessions
 * compacting at once is fine; the same session doing it twice is not.
 */
export class CompactionRunner {
  private controller: AbortController | undefined;
  private active = false;
  /**
   * The in-flight compaction, so a run that starts while the surface is being
   * spliced can WAIT for it. Without this a `prompt()` landing during a manual
   * compaction started a run that assembled a request against the array the
   * compaction was about to replace.
   */
  private inflight: Promise<unknown> | undefined;

  constructor(
    private readonly host: CompactionHost,
    /** The auto-compact threshold; absent disables the boundary gates entirely. */
    private readonly autoCompactLimit: number | undefined,
    /** The assembly owns per-request gating for headless runs (see `gate`). */
    private readonly perRequestCompact: boolean,
  ) {}

  /** Is a compaction in flight? (`AgentSession.status` reports it.) */
  get busy(): boolean {
    return this.active;
  }

  /** Resolve once no compaction is in flight (a no-op when none is). */
  async wait(): Promise<void> {
    await this.inflight;
  }

  /**
   * Abort an in-flight compaction. Only meaningful when no run is open — a run's
   * controller owns its own abort, and the session's `abort()` prefers that.
   * @returns whether this call was the one that interrupted.
   */
  abort(): boolean {
    if (!this.active) return false;
    this.controller?.abort();
    return true;
  }

  /**
   * Compact now, from OUTSIDE a run. Rejects while a run is active: an external
   * caller (a `/compact` command, a surface button) must not splice the message
   * array out from under a live request.
   */
  async compact(trigger: 'auto' | 'manual' = 'manual'): Promise<CompactedSession> {
    if (this.host.running()) throw new Error('cannot compact while a run is active');
    return this.run(trigger);
  }

  /** The pre-run boundary gate: compact when the predicted request exceeds. */
  async preflight(): Promise<void> {
    await this.gate('pre');
  }

  /** The post-run boundary gate: compact when the last request exceeded. */
  async postTurn(): Promise<void> {
    await this.gate('post');
  }

  /**
   * The compaction itself. The run-boundary gates (pre/post) call THIS rather
   * than `compact()`: they fire from inside the run loop, where `running` is
   * true by definition, so the public guard rejected *every* automatic
   * compaction with "cannot compact while a run is active". Boundaries are
   * quiescent points: the previous turn's stream is fully consumed and the next
   * request has not been assembled yet.
   */
  private async run(trigger: 'auto' | 'manual'): Promise<CompactedSession> {
    if (this.active) throw new Error('a compaction is already running');
    this.active = true;
    this.controller = new AbortController();
    this.host.setPhase('compacting');
    this.host.publishStart(trigger);
    const promise = this.execute(trigger);
    this.inflight = promise.catch(() => undefined);
    try {
      return await promise;
    } finally {
      this.active = false;
      this.controller = undefined;
      this.inflight = undefined;
      this.host.setPhase(this.host.running() ? 'tool' : 'idle');
    }
  }

  /** The compaction body; `run` owns the interlock and the phase. */
  private async execute(trigger: 'auto' | 'manual'): Promise<CompactedSession> {
    try {
      const strategy = this.host.strategy() ?? compactSession;
      const outcome = await strategy({
        client: this.host.provider(),
        session: this.host.session(),
        messages: this.host.messages(),
        trigger,
        signal: this.controller?.signal,
      });
      // The session owns the commit: splice in place, reset anchors, publish.
      this.host.commitCompaction(trigger, outcome);
      return outcome;
    } catch (err) {
      this.host.publishError(trigger, errMessage(err));
      throw err;
    }
  }

  /** Shared auto-compact contract: which guard runs where (pre = before the
   * first request of a run, post = after a run whose prompt tokens exceeded). */
  private async gate(where: 'pre' | 'post'): Promise<void> {
    const limit = this.autoCompactLimit;
    if (limit === undefined || this.host.closed() || this.perRequestCompact) return;
    const anchors = this.host.anchors();
    const messages = this.host.messages();
    if (where === 'pre') {
      const { usageAnchor, anchorMsgCount } = anchors;
      const due = shouldCompactBefore({
        limit,
        ...(usageAnchor !== undefined ? { usageAnchor } : {}),
        anchorMsgCount,
        messages,
        request: {
          messages,
          systemPrompt: this.host.requestSystemPrompt(),
          tools: this.host.requestTools(),
        },
      });
      if (!due) return;
    } else {
      if (anchors.lastPromptTokens <= limit) return;
    }
    try {
      await this.run('auto');
    } catch (err) {
      // A failed compaction must never kill the turn; report and continue.
      this.host.notice(`自动压缩失败（继续运行）：${errMessage(err)}`);
    }
  }
}

/** Re-exported so the session can name the compaction seam's own types. */
export type { CompactedSession, CompactSessionOptions };
export type { UsageAnchorState } from './usage-anchor.js';
