/**
 * `AgentSession` — the kernel handle a surface drives.
 *
 * This is where the old per-runner assembly contract converges into one
 * owner: the event pump, the durable log ("model-visible means logged" is
 * enforced HERE, not by each shell's bookkeeping), the running-prompt queue
 * (the queue lane every surface renders, generalized into kernel semantics), phase derivation
 * (surfaces stopped guessing "is it thinking" from delta sequences),
 * approvals as request/response events over the broker, compaction with
 * in-place surface splice + anchor reset, auto-compact pre/post gates, and
 * turn-failure classification after log repair.
 *
 * A surface never writes `messages` or the `Session` log itself; it drives
 * the handle and renders the event stream. That is the seam that makes the
 * browser / REPL / bot channels interchangeable consumers of the same kernel.
 */
import { runAgent } from '../agent/loop.js';
import { beginRun, type Run } from '../runtime/run.js';
import {
  emptyStats,
  type AgentOptions,
} from '../agent/options.js';
import { errMessage } from '../errors.js';
import { newId } from '../ids.js';
import type { Goal } from '../goal.js';
import { surfaceDivergence, type CompactedSession, type CompactSessionOptions } from '../compact.js';
import type { ImageAttachmentRef } from '../images.js';
import type {
  ApprovalBroker,
  ApprovalMode,
  ApprovalPolicy,
  AskResult,
  PermissionPort,
} from '../approval.js';
import type { JobRegistry } from '../jobs.js';
import type { JobSnapshot } from '../job-types.js';
import type { QuestionBroker, QuestionRequest, AskUserQuestionAnswer } from '../user-question.js';
import type { Session, SessionEvent } from '../session.js';
import { isContextFragment } from '../context-fragment.js';
import { recordSessionTitle, sessionTitleOf } from '../session/session-title.js';
import { generateSessionTitle, titleTranscript, TITLE_REGEN_PROMPTS } from './title.js';
import { persistMissingToolResults } from '../session/session-repair.js';
import type { SubagentProgress } from '../tools/subagent.js';
import type {
  AgentHooks,
  AgentMessage,
  ChatProvider,
  StreamEvent,
  ToolDefinition,
  Usage,
  UsageStats,
  UserMessage,
} from '../types.js';
import { EventPump } from './pump.js';
import { HumanAskSeam } from './human-ask.js';
import { CompactionRunner } from './compaction-runner.js';
import { PromptQueue } from './prompt-queue.js';
import { RunMeter } from './metrics.js';
import type { KernelEvent, NoticeCode, TurnPhase } from './protocol.js';
import { createAnchors, lastLoggedUsage, resetAnchors, type UsageAnchorState } from './usage-anchor.js';

export type { UsageAnchorState } from './usage-anchor.js';

export interface AgentSessionDeps {
  /** Durable append-only log (JSONL v2). */
  session: Session;
  /** Live model surface; this array object is OWNED and spliced in place. */
  messages: AgentMessage[];
  provider: ChatProvider;
  rootDir: () => string;
  tools: () => ToolDefinition[];
  /** Hook chain accessor — re-read per run (the host may rebuild between runs). */
  hooks: () => AgentHooks;
  jobs: JobRegistry;
  /** Approval request/response bridge (its asker was handed to PermissionService). */
  approvals: ApprovalBroker;
  /**
   * Question request/response bridge (its asker was handed to the
   * `ask_user_question` tool). Required rather than optional: a session built
   * without one has no way to fail an outstanding ask closed, and the ask tool
   * would be registered against a broker nobody publishes from.
   */
  questions: QuestionBroker;
  /** Permission engine view (mode readout/switch); omit for headless-never. */
  permission?: PermissionPort;
  /**
   * Whether a human can answer THIS session's `ask_user_question`.
   *
   * A THUNK read per call, not a boolean captured at open, because the answer is
   * a fact about the surface in force and that can change without a restart. It
   * is per SESSION rather than per process because one process can drive several
   * conversations with different ends: a bot peer whose chat window has nobody
   * watching must get the typed `NO_PROVIDER` refusal instead of a question card
   * published onto a stream no human is following — which parks the run with
   * nothing able to release it.
   *
   * Absent means false (fail-closed): a session assembled without this fact
   * cannot ask.
   */
  canAskUser?: () => boolean;
  systemPrompt?: string;
  maxTurns?: number;
  /** Spill dir for oversized tool results. */
  cacheDir: () => string;
  /** Auto-compact threshold (prompt tokens); omit to disable all gates. */
  autoCompactLimit?: number;
  /**
   * Headless single-run mode: the boundary gates (pre/post) are useless when
   * one run spans the whole task — the assembly layer gates INSIDE every
   * request by wrapping the composed hooks once (plugins'
   * `wrapHeadlessCompact`); this flag only makes the boundary gates stand
   * down so nobody double-compacts.
   */
  perRequestCompact?: boolean;
  /**
   * The compaction strategy. Defaults to the shipped summarizer; the assembly
   * passes in whatever the `compaction` service provides, which is what makes
   * summarization replaceable — it is where the token bill is decided.
   */
  compact?: (options: CompactSessionOptions) => Promise<CompactedSession>;
  /**
   * Input modalities of the model in force, read per request.
   *
   * Called LIVE at each request assembly rather than captured once, because the
   * model can be switched mid-session: an image attached under a vision model
   * must become a text placeholder the moment the user switches to a text-only
   * one. Omitted means "not declared", which counts as image-capable — see
   * `acceptsImages` for why an unknown capability must fail open.
   */
  inputModalities?: () => Promise<readonly string[] | undefined>;
  /**
   * The session-TITLE model's own client, read when the conversation's first
   * real prompt lands. A THUNK returning a promise because the client is built
   * from the config FILE (the authority the settings page writes) — a boot-time
   * capture would leave every new session titling with a model the operator
   * already replaced. Undefined, a throwing read or a missing endpoint all mean
   * "no titles": the listing falls back to the first prompt, and nothing else
   * notices.
   */
  titleProvider?: () => Promise<ChatProvider | undefined>;
}

export class AgentSession {
  /** The event pump: `subscribe` for callbacks, `events()` for iteration. */
  readonly events: EventPump;
  private readonly deps: AgentSessionDeps;
  /** The two human-ask brokers and their event wiring (see `human-ask.ts`). */
  private readonly askSeam: HumanAskSeam;
  /** The compaction lifecycle and its in-flight interlock (see `compaction-runner.ts`). */
  private readonly compaction: CompactionRunner;
  private readonly stats: UsageStats = emptyStats();
  private readonly anchors: UsageAnchorState = createAnchors();
  /** Per-run timings for the `run_stats` event (one run at a time). */
  private readonly meter = new RunMeter();
  private readonly pending = new PromptQueue();
  private runController: AbortController | undefined;
  /**
   * The current (or most recent) run. Replaces the old `runController !==
   * undefined` busy check: a boolean forgot a run the moment it ended, while a
   * Run keeps its identity and terminal state (see `runtime/run.ts`).
   */
  private currentRun: Run | undefined;
  /** In-flight title request (first prompt only); aborted with the session. */
  private titleController: AbortController | undefined;
  /** Real prompts landed since the title was last (re)generated — the
   *  re-ask cadence counter. Reset when a fresh title is recorded. */
  private titlePrompts = 0;
  private phase: TurnPhase = 'idle';
  /** The last message this run appended (the durable stats row's anchor). */
  private lastMessageId: string | undefined;
  private closed = false;

  constructor(deps: AgentSessionDeps) {
    this.deps = deps;
    // A throwing surface listener is reported onto the same stream instead of
    // escaping from inside the run loop (which crashed the process).
    this.events = new EventPump((err) => {
      this.publish({
        type: 'notice',
        code: 'listener_failed',
        text: `事件订阅者抛错（已忽略）：${errMessage(err)}`,
      });
    });
    // Both asks park the run the same way and hand the phase back the same way;
    // `HumanAskSeam` owns that pair so neither can be wired without the other.
    this.askSeam = new HumanAskSeam(
      {
        publish: (event) => { this.publish(event); },
        setPhase: (phase) => { this.setPhase(phase); },
        running: () => this.running,
      },
      deps.approvals,
      deps.questions,
    );
    // Compaction owns its own in-flight bookkeeping: the phase it parks in, the
    // controller its abort cancels, and the anchors it resets after a splice.
    this.compaction = new CompactionRunner(
      {
        session: () => deps.session,
        messages: () => deps.messages,
        provider: () => deps.provider,
        strategy: () => deps.compact,
        publishStart: (trigger) => { this.publish({ type: 'compaction', progress: { state: 'start', trigger } }); },
        commitCompaction: (trigger, outcome) => { this.commitCompaction(outcome, trigger); },
        publishError: (trigger, message) => {
          this.publish({ type: 'compaction', progress: { state: 'error', trigger, error: message } });
        },
        setPhase: (phase) => { this.setPhase(phase); },
        running: () => this.running,
        closed: () => this.closed,
        requestSystemPrompt: () => deps.systemPrompt ?? '',
        requestTools: () => deps.tools(),
        notice: (text) => { this.notice('compact_failed', text); },
        anchors: () => this.anchors,
      },
      deps.autoCompactLimit,
      deps.perRequestCompact === true,
    );
  }

  /** The durable log (surfaces read it; writes go through this class). */
  get session(): Session {
    return this.deps.session;
  }

  /** Live model surface (read-only; the class splices it in place on compact). */
  get messages(): readonly AgentMessage[] {
    return this.deps.messages;
  }

  /** The most recent run, live or settled; `undefined` before the first one. */
  get run(): Run | undefined {
    return this.currentRun;
  }

  /**
   * Whether a compaction is in flight. Session-level, NOT a run: compaction
   * splices the message array rather than executing a turn, so it never gets a
   * Run of its own. Split out of the old `status` union, which mixed the two.
   */
  get compacting(): boolean {
    return this.compaction.busy;
  }

  get running(): boolean {
    return this.currentRun?.active === true;
  }

  get currentPhase(): TurnPhase {
    return this.phase;
  }

  /** Cumulative usage stats (copy; safe to render). */
  usageSnapshot(): UsageStats {
    return { ...this.stats };
  }

  get lastUsage(): Usage | undefined {
    return this.anchors.lastUsage ?? lastLoggedUsage(this.deps.messages);
  }

  /**
   * The size of the most recent request, or 0 when nothing was ever billed. The
   * live anchor when this process ran the turn, otherwise recovered from the
   * log so a surface need not rebuild it. One message's own `usage.promptTokens`,
   * never a run total: `RunStats.promptTokens` sums every request, so on a
   * multi-request run it is a multiple of what the next request costs (+96%
   * measured on a 2-request run).
   */
  get lastPromptTokens(): number {
    if (this.anchors.lastPromptTokens > 0) return this.anchors.lastPromptTokens;
    return lastLoggedUsage(this.deps.messages)?.promptTokens ?? 0;
  }

  /** Prompts committed while a run was in flight and not yet read by a request. */
  get queued(): readonly string[] {
    return this.pending.items;
  }

  /**
   * This session's OWN permission engine — the one that decides ITS tool calls.
   *
   * Read by consumers that hold a `ToolCallScope` (the approval gate) and by a
   * surface driving "the tier of the conversation I am looking at" (the CLI's
   * `/perm`). Both must reach the session that issued the call, never a
   * process-global engine: one kernel runs several sessions at once, and a tier
   * that leaked between them would let a chat peer raise the desktop's
   * permissions.
   *
   * Undefined for an embedded session assembled without one; the gate then
   * reports that it cannot decide rather than allowing the call.
   */
  get permission(): PermissionPort | undefined {
    return this.deps.permission;
  }

  /**
   * This session's question seam (the broker the `ask_user_question` tool parks
   * inside and the surface answers over the event stream).
   *
   * Exposed so the ask tool — registered ONCE per roster, with no session of its
   * own — can route a call to the session that made it. A single shared broker
   * was the defect here: whoever created the newest session re-pointed the
   * publish slot, so A's question card appeared on B and only B could answer it.
   */
  get questions(): QuestionBroker {
    return this.deps.questions;
  }

  /**
   * Whether this session can ask a human anything at all.
   *
   * Read by the `ask_user_question` tool through the session that issued the
   * call: a question is only worth publishing where somebody can answer it, and
   * "somebody" is per conversation (see `AgentSessionDeps.canAskUser`).
   * Fail-closed: absent means no.
   */
  get answersQuestions(): boolean {
    return this.deps.canAskUser?.() === true;
  }

  /** True once `dispose()` has run: the handle is finished and must not be reused. */
  get disposed(): boolean {
    return this.closed;
  }

  get approvalMode(): ApprovalMode | undefined {
    return this.deps.permission?.approvalMode;
  }

  /** The process-wide 'ask' | 'never' policy in force (see `PermissionPort`). */
  get approvalPolicy(): ApprovalPolicy | undefined {
    return this.deps.permission?.approvalPolicy;
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.deps.permission?.setMode(mode);
  }

  setApprovalPolicy(policy: ApprovalPolicy): void {
    this.deps.permission?.setPolicy(policy);
  }

  /** Outstanding approval requests (a reconnecting surface re-renders these). */
  pendingApprovals(): ReturnType<ApprovalBroker['outstanding']> {
    return this.deps.approvals.outstanding();
  }

  /**
   * Outstanding question requests (a reconnecting surface re-renders these).
   *
   * Read from the broker, not from a copy: the ask lives in the kernel and a
   * surface that reattached mid-question must be able to restore the very card
   * the previous socket was showing, or the run stays parked with nobody able to
   * answer it.
   */
  pendingQuestions(): QuestionRequest[] {
    return this.askSeam.pendingQuestions();
  }

  /** Subscribe to the kernel event stream (callback view of the pump). */
  subscribe(listener: (event: KernelEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  /** Operational line from the assembly layer (auto-compact fuse etc.). */
  notice(code: NoticeCode, text: string): void {
    this.publish({ type: 'notice', code, text });
  }

  /**
   * Announce a slash command's lifecycle. Published (rather than answered to
   * the caller alone) so every attached view shows the same command row, and so
   * a command that runs long keeps its row until it settles.
   */
  announceCommand(name: string, phase: 'run' | 'done', text?: string): void {
    this.publish({ type: 'command', name, phase, ...(text !== undefined && text !== '' ? { text } : {}) });
  }

  /**
   * Announce a model change on the event stream. The swap itself is the
   * provider's (`ChatProvider.setModel` — one client instance serves the whole
   * kernel), so the session publishes the fact instead of owning it: a switch
   * made from any surface reaches every other consumer without a reload, which
   * is what keeps two attached views from disagreeing about the model.
   *
   * `name`/`contextWindow` ride along because the surface that switched holds
   * the metadata for its choice: an id is what the wire needs, a display name
   * and a window are what a reader does.
   */
  announceModel(model: string, detail: { name?: string; contextWindow?: number } = {}): void {
    this.publish({
      type: 'model',
      model,
      ...(detail.name !== undefined ? { name: detail.name } : {}),
      ...(detail.contextWindow !== undefined ? { contextWindow: detail.contextWindow } : {}),
    });
  }

  /**
   * Record and publish a goal snapshot — the ONE door for a caller that is not a
   * tool.
   *
   * Durability is the point: the goal's only store is the session log, so a
   * publish-only method would move the panel while leaving nothing to resume from.
   * Ordering follows the log's rule elsewhere ("log first, then tell the world"):
   * `appendEvent` writes the durable record, and the `goal` event goes out after
   * it — so a surface can never render a goal the log does not have.
   *
   * The tool path needs no call here: its `goal/change` write is picked up by the
   * log-watch in `agentOptions` (same as `todo/write`). But a `/goal` COMMAND and
   * the plugin-side continuation hook reach the session through this method — they
   * have no `ctx.emit` and no `Session` handle.
   * @param goal - the whole goal, or null when it was cleared.
   */
  async announceGoal(goal: Goal | null): Promise<void> {
    await this.deps.session.appendEvent({ type: 'goal/change', goal, at: Date.now() });
    this.publish({ type: 'goal', goal });
  }

  /** Relay a nested subagent lifecycle moment (wired by the assembly factory). */
  observeSubagent(progress: SubagentProgress): void {
    this.publish({ type: 'subagent_update', progress });
  }

  /** Relay a background-job transition (wired via JobRegistry.setListener). */
  observeJob(job: JobSnapshot): void {
    this.publish({ type: 'job_update', job });
  }

  /** Known background jobs — a reconnecting surface rebuilds its rows from these. */
  jobSnapshots(): JobSnapshot[] {
    // Scoped to THIS session: the registry is per-process, so an unscoped list
    // would rebuild another conversation's rows into this one's transcript.
    return this.deps.jobs.list(this.deps.session.id);
  }

  /**
   * Ask a background job to stop (a surface's stop control; the model's route
   * is the `jobs` tool). Returns whether the registry knew the id. The outcome
   * arrives as a `job_update` like every other transition, so no caller has to
   * await this to stay in sync — and stopping an already-settled job is a
   * no-op rather than an error.
   */
  async stopJob(id: string): Promise<boolean> {
    // Scoped: a surface's stop control must not be able to kill another
    // session's job just because it guessed the id.
    return (await this.deps.jobs.stop(id, undefined, this.deps.session.id)) !== undefined;
  }

  /**
   * Commit a user prompt (log + `user_message` event) and start a run when
   * idle; when a run is in flight the prompt queues — the NEXT run covers
   * every committed message (they all ride its first request), the queue
   * itself is the pending-trigger ledger surfaces render as the queue lane.
   */
  async prompt(text: string, images?: readonly ImageAttachmentRef[]): Promise<void> {
    if (this.closed) throw new Error('agent session is closed');
    // Read BEFORE the push: whether this is the conversation's opening prompt is
    // "no real user message yet", and after the push it never is.
    const opening = !this.deps.messages.some((m) => m.role === 'user' && !isContextFragment(m));
    const userMsg: UserMessage = {
      id: newId('msg'),
      ts: Date.now(),
      role: 'user',
      content: text,
      // Absent rather than empty when there are none: a text-only log must stay
      // byte-identical to what it was before images existed.
      ...(images === undefined || images.length === 0 ? {} : { images }),
    };
    // Log FIRST, then the live surface (the same write-then-memory order
    // `appendEvent` follows): if the append fails, the transcript must not show
    // a message the durable log never received — a divergence that survives
    // every later resume.
    await this.deps.session.append(userMsg);
    this.deps.messages.push(userMsg);
    this.publish({ type: 'user_message', message: userMsg });
    // The title does not wait for the turn (nor care whether one is already
    // running): it labels the PROMPT, it rides no queue, and it must never delay
    // or fail the reply. The FIRST prompt titles immediately; after that the
    // label is re-asked only every TITLE_REGEN_PROMPTS prompts, so a growing
    // conversation keeps tracking its topic at one small call per few turns.
    this.titlePrompts += 1;
    if (opening || this.titlePrompts > TITLE_REGEN_PROMPTS) this.scheduleTitle();
    // The message is committed to the live array BEFORE the branch below, so an
    // in-flight run's next request already carries it: steering needs no extra
    // channel. The queue entry is only the GUARANTEE that the prompt also gets a
    // run of its own when this run ends without assembling another request.
    //
    // THE RACE (this is the "no reply" defect): the flag below is read only
    // after the `await this.deps.session.append(userMsg)` above, which is a real
    // suspension point. A run that decides to stop while this call is suspended
    // is invisible to us — we resume, see `running === true`, and queue into a
    // loop that already chose to exit. `runLoop` is written so this queue is
    // re-read after the run instead of decided from a snapshot, which is what
    // makes queueing here safe; the entry's watermark (`prompt-queue.ts`) is what
    // keeps it from also causing a duplicate run when the live run DID read it.
    // A compaction holds the SAME message array a run would assemble from, so a
    // prompt arriving mid-compaction is queued rather than allowed to start a
    // run that would be spliced out from under it. `compact()` serves the queue
    // when it finishes.
    if (this.running || this.compaction.busy) {
      this.pending.enqueue(text);
      this.publish({ type: 'queue_update', items: this.pending.items });
      return;
    }
    void this.runLoop();
  }

  /**
   * Interrupt the current run (or a compaction in progress). Outstanding
   * approvals are fail-closed HERE, not only when the run unwinds: the loop
   * is suspended inside the approval `await` and the abort signal alone never
   * releases it (the old REPL's Ctrl+C cancelled the approval wait for
   * exactly this reason).
   *
   * ABORT AND THE PROMPT QUEUE — the decision, stated once: abort WITHDRAWS every
   * trigger that has not been absorbed by a request yet.
   *
   *  - Not "kept for the next prompt": a prompt the operator queued and then
   *    cancelled must not come back to life later. Silently re-running it on some
   *    unrelated future prompt is the worst option — the operator believes the
   *    instruction was stopped and it executes anyway, minutes later, out of
   *    context.
   *  - Not lost, either: `prompt()` already appended the message to the durable
   *    log and to `messages` before this method could run, and both are
   *    append-only. The TEXT stays in the conversation and the model reads it on
   *    the next run; only the "start a run for this on its own" claim is
   *    withdrawn — exactly the claim the operator cancelled.
   *
   * The withdrawal happens BEFORE the signal so a prompt committed after the stop
   * is distinguishable from the withdrawn ones: `runLoop` treats a non-empty queue
   * at an aborted boundary as post-stop intent and gives it a fresh run, instead
   * of dropping a message the operator sent right after pressing stop.
   */
  abort(): void {
    // A standalone compaction (no run around it) is interrupted by its own
    // controller: the run's controller does not exist to carry the signal.
    if (this.compaction.abort() && this.runController === undefined) {
      if (this.pending.clear()) this.publish({ type: 'queue_update', items: [] });
      return;
    }
    // Sweep BEFORE aborting the controller: the run's signal abort reaches the
    // parked tool call (and, through it, the question broker's own abort
    // listener), so aborting first made the listener and this sweep race for the
    // same wait. Sweeping first gives the wait its reason here, where the
    // session's intent is known, and leaves the listener as a safety net for a
    // signal aborted from anywhere else.
    this.askSeam.failQuestions('aborted');
    this.deps.approvals.failAll('aborted');
    if (this.pending.clear()) this.publish({ type: 'queue_update', items: [] });
    this.runController?.abort();
  }

  /** Answer one outstanding approval; false for unknown/consumed ids. */
  resolveApproval(id: string, answer: AskResult): boolean {
    return this.deps.approvals.resolve(id, answer);
  }

  /**
   * Answer one outstanding question; false for an unknown id or an answer that
   * does not fit the questions that were asked (see `validateQuestionAnswer`) —
   * a refused answer leaves the wait open for a corrected frame.
   */
  resolveQuestion(id: string, answer: AskUserQuestionAnswer): boolean {
    return this.askSeam.resolveQuestion(id, answer);
  }

  /** The human dismissed a question batch; false for unknown/consumed ids. */
  cancelQuestion(id: string): boolean {
    return this.askSeam.cancelQuestion(id);
  }

  /**
   * Compact now, from OUTSIDE a run. Rejects while a run is active: an external
   * caller (a `/compact` command, a surface button) must not splice the message
   * array out from under a live request.
   */
  async compact(trigger: 'auto' | 'manual' = 'manual'): Promise<CompactedSession> {
    const outcome = await this.compaction.compact(trigger);
    // A prompt that arrived while the compaction held the surface was QUEUED
    // (see `prompt`); this is what gives it its run, since a manual compaction
    // has no run loop around it.
    if (!this.running && !this.closed && !this.pending.empty) void this.runLoop();
    return outcome;
  }

  /**
   * Commit a FINISHED compaction — the ONE place its three effects happen
   * together: splice the live surface IN PLACE (every consumer holds that array),
   * reset the token anchors (the old measurement describes a surface that no
   * longer exists), and publish the `compaction` event.
   *
   * Both the run-boundary gate and the headless per-request gate come through
   * here, so neither can leave the session sizing its next request against the
   * pre-compaction usage — which is what the headless path did while it spliced
   * on its own.
   */
  commitCompaction(outcome: CompactedSession, trigger: 'auto' | 'manual'): void {
    const messages = this.deps.messages;
    messages.splice(0, messages.length, ...outcome.surface);
    resetAnchors(this.anchors);
    // "Model-visible means logged", checked at the one moment it can break: a
    // surface replacement. This used to live only in a test helper
    // (`surfaceDivergence`), which is a fixture proving the producer right
    // rather than a check on the real path.
    const divergence = surfaceDivergence(this.deps.session, messages);
    if (divergence !== undefined) {
      this.notice('compact_alias_broken', `压缩后模型面与日志投影不一致：${divergence}`);
    }
    this.publish({
      type: 'compaction',
      progress: {
        state: 'done',
        trigger,
        retained: outcome.retained,
        summaryChars: outcome.summary.length,
      },
    });
  }

  /** Close: terminal for prompts, outstanding asks deny, pump drains and ends. */
  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Terminal reason first, for the same race the abort path documents: once
    // the controller is aborted, a waiter that is still outstanding settles as
    // 'aborted', and 'closed' would be lost even though this is the end of the
    // session rather than of a turn.
    this.askSeam.failQuestions('closed');
    this.abort();
    this.titleController?.abort();
    this.deps.approvals.failAll('closed');
    // The session's OWN background jobs stop HERE, not at each surface: the
    // registry is per-process, so the cancel was implemented once per caller
    // (web did it three times, cli once) and a surface that forgot left shells
    // running with nowhere to report. Cancelling before the seal below also
    // lets a job's last event land in the log instead of being rejected.
    await this.deps.jobs.disposeSession(this.deps.session.id);
    // Seal BEFORE closing the pump: a run still in flight may yet try to commit,
    // and the seal is what stops it from recreating a log the surface deleted.
    // `drain` then waits for writes already past the seal check to land, so the
    // caller may safely unlink the file the moment this resolves.
    this.deps.session.seal();
    await this.deps.session.drain();
    this.events.close();
  }

  // ---------------------------------------------------------------- internals

  private publish(event: KernelEvent): void {
    this.events.publish(event);
  }

  /**
   * Fire-and-forget title generation: on the conversation's opening prompt,
   * then again every `TITLE_REGEN_PROMPTS` prompts so the label tracks the
   * conversation as it grows.
   *
   * Everything about this is best-effort by construction: the provider read may
   * be absent or throw, the model may answer nothing usable, and the append may
   * race the run — the write chain serializes that last one, and the first two
   * fall back to the listing's first-prompt label. At most one title request in
   * flight (a prompt landing during one neither queues a second nor resets the
   * cadence — the recorded title resets the counter, so the skipped prompt is
   * simply part of the last window).
   */
  private scheduleTitle(): void {
    const readProvider = this.deps.titleProvider;
    if (readProvider === undefined || this.titleController !== undefined) return;
    // The CURRENT title travels with the request: a model that still finds it
    // accurate repeats it, so a same-topic conversation does not churn its label
    // every regeneration; one that drifted replaces it (the newest marker wins).
    const transcript = titleTranscript(this.deps.messages, sessionTitleOf(this.deps.session));
    const controller = new AbortController();
    this.titleController = controller;
    void readProvider()
      .then((provider) => {
        if (provider === undefined) return undefined;
        return generateSessionTitle(provider, transcript, controller.signal);
      })
      .then((title) => {
        if (title === undefined || controller.signal.aborted || this.closed) return;
        this.titlePrompts = 0;
        // The live signal beside the durable marker: surfaces refresh what they
        // show about this session (the sidebar row) without polling.
        this.publish({ type: 'session_titled', title });
        return recordSessionTitle(this.deps.session, title);
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.titleController === controller) this.titleController = undefined;
      });
  }

  /**
   * Commit one model-visible message: durable log FIRST, live surface second.
   *
   * `runAgent` pushes onto `messages` and then yields the message, so by the
   * time this runs the live surface already carries it. If the durable append
   * fails, that push is undone — the log is the truth, and a message it never
   * received must not survive in memory, or the model's next request (built from
   * `messages`) and a later resume (built from the log) would disagree about
   * history. The failure then propagates, so the run is reported as failed
   * rather than silently continuing on a phantom history.
   *
   * The push is undone BY IDENTITY, not by "is it the tail": a concurrent
   * writer (a `prompt()` that landed during the append's await) leaves this
   * message in the middle of the array, and a tail-only check would then accept
   * the divergence. `indexOf` finds the exact object this commit appended.
   */
  private async commit(message: AgentMessage): Promise<void> {
    try {
      await this.deps.session.append(message);
    } catch (err) {
      const messages = this.deps.messages;
      const at = messages.indexOf(message);
      if (at >= 0) messages.splice(at, 1);
      throw err;
    }
  }

  /**
   * One run, then a run for any queued prompt that still needs one.
   *
   * INVARIANT: a prompt that enqueued because it saw `running === true` always
   * gets a run. `prompt()` decides "queue or start" from `running`
   * (`runController !== undefined`), and it reads that flag only AFTER
   * `await session.append(...)` — a real suspension point. So a prompt can queue
   * while this loop is between runs, and the loop must be able to hand ownership
   * to it. Both defects below came from getting that handoff wrong:
   *
   *  - The dropped trigger ("no reply"). The old loop read
   *    `flushed = this.pending.length`, IMMEDIATELY cleared `pending`, and only
   *    then consulted its continue condition —
   *    `while (flushed > 0 && !closed && !signal.aborted)`. Once the signal was
   *    aborted that condition was false, so entries it had just cleared were
   *    never run: the queue was DESTROYED instead of deferred. A prompt sent
   *    after the user pressed stop was logged and displayed, then silently denied
   *    the run it had queued for (its text did survive in `messages`, so it only
   *    resurfaced if the user happened to send something else later). This loop
   *    never clears here at all (the one clear point is the queue's absorption
   *    when a request reads the entries), it re-reads the LIVE queue after each
   *    run, and at an aborted boundary it adopts a FRESH controller so entries
   *    committed after the stop still get their run.
   *  - The double answer. Clearing only after the whole run meant an interjection
   *    the run had already read and answered stayed queued and earned a SECOND
   *    run: the model was handed a history ending in its own reply to that text
   *    and answered it again (see `countingProvider`).
   *
   * The controller is cleared before the queue is re-read so that a racing
   * `prompt()` either sees `running === false` and starts its own loop, or finds
   * its entry still queued and gets served here. That ordering is belt-and-
   * braces — the two statements are adjacent with no `await` between them — but
   * it keeps the invariant local and readable rather than resting on that fact.
   *
   * `abort()` withdraws leftover triggers deliberately — see the note there.
   */
  private async runLoop(): Promise<void> {
    if (this.running || this.closed) return;
    let controller = new AbortController();
    this.runController = controller;
    try {
      for (;;) {
        const before = this.pending.requestCount;
        const run = beginRun(this.deps.session.id);
        this.currentRun = run;
        await this.startRun(controller.signal, run);
        if (this.closed) break;
        await this.postTurnCompact();
        if (controller.signal.aborted) {
          // `abort()` withdrew everything committed BEFORE the stop, so a
          // non-empty queue here is post-stop intent (the user stopped, then said
          // something new): give it a fresh signal and serve it. The old loop
          // dropped it on the way out — the real lost-message defect.
          if (this.pending.empty) break;
          controller = new AbortController();
          this.runController = controller;
          continue;
        }
        // Clear before deciding, so a racing `prompt()` starts its own loop
        // rather than queueing into one that is already stopping.
        this.runController = undefined;
        if (this.pending.empty) break;
        // A run that assembled nothing cannot have read the prompt, and an
        // identical retry would assemble nothing again (`maxTurns: 0`, aborted
        // signal): looping would spin without ever answering.
        if (this.pending.requestCount === before) break;
        this.runController = controller;
      }
    } finally {
      this.runController = undefined;
      this.setPhase('idle');
      // Reachable with a queue only when the loop could not serve it (closed
      // session, run that assembled nothing). Withdraw the triggers so none can
      // silently execute later; the TEXT stays in the append-only log.
      if (this.pending.clear()) this.publish({ type: 'queue_update', items: [] });
    }
  }

  private async startRun(signal: AbortSignal, run: Run): Promise<void> {
    // Never assemble a request while a compaction is splicing the array it
    // would read (see `CompactionRunner.wait`).
    await this.compaction.wait();
    this.meter.start();
    this.lastMessageId = undefined;
    let failed = false;
    try {
      await this.preflightCompact();
      const options = this.agentOptions(signal, run);
      for await (const event of runAgent(options)) {
        await this.consume(event);
      }
    } catch (err) {
      failed = true;
      // Repair the log BEFORE classification/propagation — the old trio of
      // persist → repair → classify, now owned by the run loop itself.
      await persistMissingToolResults(this.deps.session, this.deps.messages).catch(() => undefined);
      // A failed run still has numbers worth showing (how far it got, what it
      // spent); they precede `run_failed`, the terminator, like `done`'s do.
      await this.publishRunStats();
      this.publish({ type: 'run_failed', message: errMessage(err), aborted: signal.aborted });
    } finally {
      // Settle here, not in the loop: every exit of a run — natural end, abort,
      // throw — passes through this block exactly once.
      run.settle(failed ? 'failed' : signal.aborted ? 'cancelled' : 'completed');
      // Outstanding asks must not outlive the run that made them.
      this.deps.approvals.failAll('aborted');
      this.askSeam.failQuestions('aborted');
    }
  }

  /**
   * The provider `runAgent` receives: a pass-through that counts each ASSEMBLY at
   * the one moment a request is really sent, and absorbs the queue entries that
   * request has read — the single clear point for absorbed triggers, so a prompt
   * leaves the queue lane at the step boundary where the model read it instead of
   * after the whole run.
   *
   * Why here, and why identity-keyed:
   *  1. Not at `turn_start`: `runAgent` yields it immediately BEFORE
   *     `assembleRequest`, so a prompt landing in that gap is absent from the
   *     count yet present in the request about to be assembled — it would run
   *     twice.
   *  2. Not per `stream()` call: `streamCompletion` retries an empty completion by
   *     re-issuing the SAME frozen request, which does NOT contain a prompt that
   *     arrived during the failed attempt. Counting the retry would swallow it.
   *
   * Only `stream` is wrapped: that is the whole of `ChatProvider` the run loop
   * uses (`stream.ts` calls `opts.provider.stream(request)`), while the model
   * seat keeps its own reference to the real client.
   *
   * The same hand-off is also the meter's request boundary: this call site is
   * the one place a request crosses into the provider, which is why the meter is
   * told here rather than inferring it from `turn_start` (that fires before
   * request assembly, its hooks and an in-place auto-compaction — all of which
   * used to be charged to `llmMs`).
   */
  private countingProvider(): ChatProvider {
    const inner = this.deps.provider;
    return {
      stream: (request) => {
        // The one clear point for absorbed triggers, at the step boundary where
        // the model actually read them (not after the whole run). See the queue
        // for why the count is taken here and why it is identity-keyed.
        if (this.pending.recordAssembly(request)) {
          this.publish({ type: 'queue_update', items: this.pending.items });
        }
        this.meter.requestStart();
        return this.meteredStream(inner.stream(request));
      },
    };
  }

  /**
   * Close the meter's request window when the provider's stream settles. The
   * `finally` covers every exit — clean EOF, a provider error, and a consumer
   * that stops pulling (the run loop breaks out on abort, which calls
   * `.return()` on this generator) — so a request can no longer stay open
   * forever just because its provider never reported `usage`.
   */
  private async *meteredStream(source: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
    try {
      yield* source;
    } finally {
      this.meter.requestEnd();
    }
  }

  private agentOptions(signal: AbortSignal, run: Run): AgentOptions {
    const deps = this.deps;
    return {
      provider: this.countingProvider(),
      messages: deps.messages,
      rootDir: deps.rootDir(),
      systemPrompt: deps.systemPrompt,
      tools: deps.tools(),
      hooks: deps.hooks(),
      maxTurns: deps.maxTurns,
      cacheDir: deps.cacheDir(),
      jobs: deps.jobs,
      // The run froze this scope at creation; the loop reads it, never rebuilds it.
      scope: run.scope,
      emit: async (evt) => {
        await deps.session.appendEvent(evt);
        // The live plan panel cannot poll the log, so the snapshot the log just
        // recorded is published here too (the `todo` variant in `protocol.ts`).
        if (evt.type === 'todo/write') this.publish({ type: 'todo', todos: evt.todos });
        // Same rule as `todo`: the tool's log-only write is what the live surface
        // sees, so the log stays the truth and a resume restores the identical
        // value. `null` means cleared — a whole-value snapshot, last write wins.
        if (evt.type === 'goal/change') this.publish({ type: 'goal', goal: evt.goal });
      },
      onToolProgress: (call, text) => {
        this.publish({ type: 'tool_progress', callId: call.id, text });
      },
      // A closure, not a value: the model can change between runs, and this
      // accessor must answer with the model in force at the moment of the
      // request rather than the one that happened to be selected at start.
      ...(deps.inputModalities === undefined ? {} : { inputModalities: deps.inputModalities }),
      signal,
    };
  }

  /** Bookkeeping (durable log), phase derivation and publishing — one pass. */
  private async consume(event: KernelEvent): Promise<void> {
    this.meter.observe(event);
    switch (event.type) {
      case 'turn_start':
      case 'reasoning_delta':
        this.setPhase('thinking');
        break;
      case 'text_delta':
        this.setPhase('writing');
        break;
      case 'tool_call_start':
        this.setPhase('tool');
        break;
      case 'tool_call_result':
        await this.commit(event.result);
        if (!this.askSeam.waiting()) this.setPhase('tool');
        break;
      case 'llm_retry':
        this.setPhase('retrying');
        break;
      case 'message':
        await this.commit(event.message);
        this.lastMessageId = event.message.id;
        break;
      case 'turn_aborted':
        await this.commit(event.message);
        this.lastMessageId = event.message.id;
        break;
      case 'usage': {
        Object.assign(this.stats, event.stats);
        this.anchors.lastUsage = event.usage;
        this.anchors.lastPromptTokens = event.usage.promptTokens;
        // A usage block without prompt_tokens (coerced to 0) must not become
        // the anchor, or the context bar collapses to 0 until the next real
        // report (the old runner-loop guard, same owner now).
        if (event.usage.promptTokens > 0) {
          this.anchors.usageAnchor = event.usage;
          this.anchors.anchorMsgCount = this.deps.messages.length;
        }
        break;
      }
      default:
        break;
    }
    // A run's numbers go out BEFORE its terminator: `done` is the last frame a
    // consumer waits for, so stats after it would be missed (the smoke did once).
    if (event.type === 'done') await this.publishRunStats();
    this.publish(event);
  }

  /**
   * The run's numbers go onto the live stream AND into the log: the log record
   * is what makes the row survive a resume (the numbers are measured here, so a
   * resumed reader cannot re-derive them). A failed append must not turn a
   * finished run into a failed one — the stats are observability, the outcome is
   * already settled.
   */
  private async publishRunStats(): Promise<void> {
    const stats = this.meter.finish();
    const evt: Extract<SessionEvent, { type: 'run/stats' }> = {
      type: 'run/stats',
      stats,
      ...(this.lastMessageId !== undefined ? { afterMessageId: this.lastMessageId } : {}),
      at: Date.now(),
    };
    await this.deps.session.appendEvent(evt).catch(() => undefined);
    this.publish({ type: 'run_stats', stats });
  }

  private setPhase(phase: TurnPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.publish({ type: 'phase', phase });
  }

  private preflightCompact(): Promise<void> {
    return this.compaction.preflight();
  }

  private postTurnCompact(): Promise<void> {
    return this.compaction.postTurn();
  }

  /**
   * The per-request gate for headless single-run tasks lives in the assembly
   * layer (`plugins.createAgentKernel` wraps the composed hooks once); this
   * flag only tells the boundary gates to stand down.
   */
}
