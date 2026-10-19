/**
 * The user-question vocabulary and its request/response bridge.
 *
 * The model occasionally needs a person: which of two designs to take, whether
 * a plan is right, what a missing detail is. Nothing in the kernel can answer
 * that, so a question travels the event stream to whichever surface has a human
 * and the answer comes back by id. This file is the core half of that seam and
 * holds the same three parts `approval.ts` holds for permissions: the shapes,
 * the single fail-closed parser for the UNTRUSTED answer coming back (a browser
 * frame, a bot channel, a scripted client), and the broker that owns the wait.
 *
 * Kept apart from `approval.ts` rather than generalized with it because the two
 * asks differ where it matters: a permission answer is a verdict the engine
 * enforces against a call it already holds, while a question answer is data the
 * model reads — so only this one validates its answer against the specific
 * questions that were asked, and only this one can be dismissed by the human
 * instead of answered.
 */
import { newId } from './ids.js';
import { hasControlChars } from './text.js';

/** One selectable answer offered to the user. */
export interface AskUserQuestionOption {
  /** User-facing label; echoed verbatim in the answer. */
  label: string;
  /** Optional extra context a capable surface renders beside the label. */
  description?: string;
}

/** One question in a request. */
export interface AskUserQuestionItem {
  /** Stable caller-provided id, echoed in the answer. */
  id: string;
  /** The question to display. */
  question: string;
  /** Optional supporting detail rendered with the question. */
  detail?: string;
  /** Optional short heading/group label. */
  header?: string;
  /** Optional choices the surface renders as a menu. */
  options?: AskUserQuestionOption[];
  /** Whether more than one option may be selected. Defaults to single-select. */
  multiSelect?: boolean;
}

/** One answered question. */
export interface AskUserQuestionAnswerItem {
  /** The answered question's id. */
  id: string;
  /** Selected option labels; empty means the question was skipped. */
  selected: string[];
  /** Optional free-text answer ("Other"). */
  custom?: string;
}

/** The human's answer to the whole batch. */
export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[];
}

/** One outstanding question batch: everything a surface needs to render the ask. */
export interface QuestionRequest {
  /** Correlation id; the answer comes back via `AgentSession.resolveQuestion`. */
  id: string;
  /** The question batch, already normalized by the asker. */
  questions: readonly AskUserQuestionItem[];
}

/** Where a pending question's wait ended. */
export type QuestionResolution =
  | { source: 'user'; answer: AskUserQuestionAnswer }
  /** The human dismissed the whole batch (the surface's cancel control). */
  | { source: 'cancelled' }
  /**
   * The surface could not put the question in front of anyone, so nobody was
   * asked. Distinct from `cancelled` on purpose: the tool result is what the
   * model relays to the peer, and "the user cancelled" is a false account of a
   * card that never arrived — observed live, the model repeated it verbatim.
   */
  | { source: 'undelivered'; reason: string }
  /** The run was interrupted while the question was outstanding. */
  | { source: 'aborted' }
  /** The session closed with the question outstanding (terminal). */
  | { source: 'closed' }
  /**
   * 没人答复，等到了内核的兜底上限（见 {@link DEFAULT_QUESTION_WAIT_MS}）。与
   * `cancelled` 分开：那一条是**人按了取消**，这一条是**没有人出现过**。
   */
  | { source: 'timeout' };

/** The ask seam: somebody with a human answers, or fails. */
export type AskQuestionsFn = (
  questions: readonly AskUserQuestionItem[],
  signal?: AbortSignal,
) => Promise<AskUserQuestionAnswer>;

/* ── bounds: every field below arrives from an untrusted or unbounded source ── */

/** Questions one batch may carry (a modal pager, not a survey). */
export const MAX_QUESTIONS = 20;
/** Chars of one question text. */
export const MAX_QUESTION_CHARS = 2000;
/** Chars of one question's optional supporting detail. */
export const MAX_QUESTION_DETAIL_CHARS = 20_000;
/** Chars of one question's optional heading. */
export const MAX_QUESTION_HEADER_CHARS = 64;
/** Chars of one question id (a caller-minted token, echoed on the wire). */
export const MAX_QUESTION_ID_CHARS = 64;
/** Options one question may offer. */
export const MAX_QUESTION_OPTIONS = 12;
/** Chars of one option label. */
export const MAX_OPTION_LABEL_CHARS = 200;
/** Chars of one option's explanation. */
export const MAX_OPTION_DESCRIPTION_CHARS = 1000;
/** Chars of one free-text answer. */
export const MAX_CUSTOM_ANSWER_CHARS = 4000;

/** Stable error codes for the ask path (the tool renders the message verbatim). */
export type UserQuestionErrorCode =
  | 'EMPTY_QUESTIONS'
  | 'NO_PROVIDER'
  | 'ASK_ABORTED'
  | 'ASK_CANCELLED'
  | 'ASK_UNDELIVERED'
  | 'ASK_TIMEOUT';

/**
 * The model-facing failure text, one string per code. Exported so the tool, the
 * asker and the tests name the same sentence — these strings reach the model, so
 * they are pinned verbatim rather than composed at each site.
 */
export const USER_QUESTION_ERRORS: Record<UserQuestionErrorCode, string> = {
  EMPTY_QUESTIONS: 'ask_user_question requires at least one question',
  NO_PROVIDER: 'no user-questions answerer accepted the request',
  ASK_ABORTED: 'ask_user_question was aborted before the user answered',
  ASK_CANCELLED: 'the user cancelled ask_user_question',
  // The one failure that is NOT the peer's doing, so it must not read like a
  // refusal. The reason is appended by the caller (it comes from the surface),
  // and the sentence ends by telling the model what to do INSTEAD of retrying: a
  // retry spends another card from an allowance that just ran out, so it fails
  // the same way and costs the peer a second silent round.
  ASK_UNDELIVERED:
    'ask_user_question never reached the user, so nobody was asked — do not retry it; say so in your reply instead',
  // 与 `ASK_UNDELIVERED` 不同，这一条里卡片**可能确实送到过**，只是等到上限也没有人答。
  // 所以它既不能读成「用户拒绝了」（没有人表态），也不能读成「你没问到人」。
  ASK_TIMEOUT:
    'nobody answered ask_user_question before the wait limit, so it was cancelled — say so plainly rather than assuming an answer',
};

/** A typed ask failure: the code is what callers branch on, the message is for the model. */
export class UserQuestionError extends Error {
  constructor(
    readonly code: UserQuestionErrorCode,
    /** Surface-supplied detail for `ASK_UNDELIVERED`; ignored by the other codes. */
    readonly detail?: string,
  ) {
    super(
      detail === undefined || detail.length === 0
        ? USER_QUESTION_ERRORS[code]
        : `${USER_QUESTION_ERRORS[code]} (${detail})`,
    );
    this.name = 'UserQuestionError';
  }
}

/* ── the untrusted answer: one parser, fail-closed ─────────────────────────── */

/**
 * Parse an UNTRUSTED answer's SHAPE into the kernel's `AskUserQuestionAnswer`.
 *
 * Shape only, because this runs at the wire — where the asked questions are not
 * in hand — exactly as `parseAskResult` does for permissions. What the answer
 * MEANS for a specific request is a second, narrower check
 * ({@link validateQuestionAnswer}) performed by the broker, which does hold the
 * request. Fail-closed: anything malformed comes back `undefined` and the caller
 * refuses the frame; an answer is never assembled by guess.
 */
export function parseQuestionAnswer(value: unknown): AskUserQuestionAnswer | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)['answers'];
  if (!Array.isArray(raw) || raw.length > MAX_QUESTIONS) return undefined;
  const answers: AskUserQuestionAnswerItem[] = [];
  for (const entry of raw) {
    const item = parseAnswerItem(entry);
    if (item === undefined) return undefined;
    answers.push(item);
  }
  return { answers };
}

function parseAnswerItem(value: unknown): AskUserQuestionAnswerItem | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = raw['id'];
  const selected = raw['selected'];
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_QUESTION_ID_CHARS) return undefined;
  if (!Array.isArray(selected) || selected.length > MAX_QUESTION_OPTIONS) return undefined;
  const labels: string[] = [];
  for (const label of selected) {
    if (typeof label !== 'string' || label.length === 0 || label.length > MAX_OPTION_LABEL_CHARS) return undefined;
    // A label reaches the model as the answer, so control bytes are refused
    // rather than trimmed: the text is data the model reads, not a document.
    if (hasControlChars(label)) return undefined;
    labels.push(label);
  }
  const custom = raw['custom'];
  if (custom === undefined) return { id, selected: labels };
  if (typeof custom !== 'string' || hasControlChars(custom, { multiline: true })) return undefined;
  const trimmed = custom.trim();
  if (trimmed.length === 0) return { id, selected: labels };
  return { id, selected: labels, custom: trimmed.slice(0, MAX_CUSTOM_ANSWER_CHARS) };
}

/**
 * Does this answer actually answer THIS batch? The broker's semantic check,
 * run on the untrusted answer before it is allowed to settle a wait.
 *
 * Rules, each of which exists because the alternative hands the model a fact
 * nobody stated: an answer may only name a question that was asked (an unknown
 * id means the two sides disagree about the request, so nothing is trusted);
 * no question is answered twice; a selected label must be one of that question's
 * own options, no label may be repeated within one answer, and a question with no
 * options has nothing to select; a single-select question carries at most one
 * label. A question left unanswered is legal — a surface may report a batch whose
 * extra questions the human skipped, and the model sees exactly which ones came
 * back.
 */
export function validateQuestionAnswer(
  questions: readonly AskUserQuestionItem[],
  answer: AskUserQuestionAnswer,
): boolean {
  const asked = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  for (const item of answer.answers) {
    const question = asked.get(item.id);
    if (question === undefined || seen.has(item.id)) return false;
    seen.add(item.id);
    if (item.selected.length === 0) continue;
    if (question.multiSelect !== true && item.selected.length > 1) return false;
    const offered = new Set((question.options ?? []).map((option) => option.label));
    const picked = new Set<string>();
    for (const label of item.selected) {
      // A repeated label is not two choices: it would reach the model as a
      // selection list it cannot tell from a genuine multi-pick.
      if (!offered.has(label) || picked.has(label)) return false;
      picked.add(label);
    }
  }
  return true;
}

/* ── the broker: the ask/answer seam an AgentSession exposes ───────────────── */

/** One outstanding wait: the request plus both ways it can end. */
interface Waiter {
  request: QuestionRequest;
  settle(answer: AskUserQuestionAnswer): void;
  fail(error: unknown): void;
  /** Detaches the abort listener registered for this wait, if any. */
  release?(): void;
}

/**
 * 内核兜底的提问等待上限。
 *
 * 与 `approval.ts` 的 `DEFAULT_APPROVAL_WAIT_MS` 同一条理由：**沉默必须有个尽头**。
 * 提问的失败方向是取消（fail-closed），但「取消」原先只有通道层的 10 分钟定时器会落
 * 下来，内核自己没有任何上限——一个不带超时的 surface 会让这一轮永久停在这里。
 *
 * 比审批那档更宽，因为回答一个问题本来就是慢事；它是兜底不是策略。
 */
export const DEFAULT_QUESTION_WAIT_MS = 30 * 60_000;

/**
 * Request/response bridge between the model's ask and whichever surface holds a
 * human: the asker publishes a `QuestionRequest`, the surface answers by id, and
 * every outstanding wait ends — including the fail-closed ends (a dismissal, an
 * aborted run, a closed session, the wait limit) which reject with a typed error
 * instead of hanging or fabricating an answer.
 *
 * Serialization is NOT here: the tool that asks is registered without
 * `isConcurrencySafe`, so the loop already runs one ask at a time.
 */
export class QuestionBroker {
  private readonly waiters = new Map<string, Waiter>();
  /** 每个未决提问的兜底定时器（见 `DEFAULT_QUESTION_WAIT_MS`）。 */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Installed by the owning AgentSession; called for live surfaces only. */
  private publish: ((request: QuestionRequest) => void) | undefined;
  private resolved: ((id: string, resolution: QuestionResolution) => void) | undefined;
  private closed = false;

  constructor(
    /** 兜底等待上限；`0` 或非有限值表示不设兜底（装配方自己保证会收敛）。 */
    private readonly waitMs: number = DEFAULT_QUESTION_WAIT_MS,
  ) {}

  /** Attach the event-stream ends (see `AgentSession`'s constructor). */
  attach(
    publish: (request: QuestionRequest) => void,
    onResolved: (id: string, resolution: QuestionResolution) => void,
  ): void {
    this.publish = publish;
    this.resolved = onResolved;
  }

  /** Outstanding requests in ask order (a reconnecting surface re-renders these). */
  outstanding(): QuestionRequest[] {
    return [...this.waiters.values()].map((waiter) => waiter.request);
  }

  /** The `AskQuestionsFn` the ask tool is wired to. */
  readonly asker: AskQuestionsFn = async (questions, signal) => {
    if (questions.length === 0) throw new UserQuestionError('EMPTY_QUESTIONS');
    if (this.closed) throw new UserQuestionError('ASK_ABORTED');
    if (signal?.aborted === true) throw new UserQuestionError('ASK_ABORTED');
    const request: QuestionRequest = { id: newId('qst'), questions };
    // Register the waiter BEFORE publishing: a surface may answer inside the
    // publish call (a scripted client, a channel reply in the same tick), and an
    // answer landing before the wait existed used to be swallowed — the ask then
    // never settled, and the run hung on it with nothing left to answer.
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const waiter: Waiter = {
        request,
        settle: (answer) => {
          this.retire(request.id);
          resolve(answer);
        },
        fail: (error) => {
          this.retire(request.id);
          reject(error);
        },
      };
      if (signal !== undefined) {
        // The run's own abort releases the ask, and it fires BEFORE the
        // session's `failAll` sweep (`abort()` aborts the controller first). A
        // bare rejection here would therefore retire the waiter and leave the
        // sweep with nothing to report — the surface would never learn the card
        // is gone. Reporting the resolution from THIS path is what keeps the
        // event true regardless of which of the two runs first; `failOne` is
        // guarded by the waiter map, so exactly one of them reports.
        const onAbort = (): void => {
          this.failOne(request.id, new UserQuestionError('ASK_ABORTED'), { source: 'aborted' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.release = () => { signal.removeEventListener('abort', onAbort); };
      }
      this.waiters.set(request.id, waiter);
      // 兜底定时器在**发布之前**就位：发布可能同步应答（脚本化的客户端、同 tick 的
      // 通道），那之后 `retire` 会把它清掉；先应答后布置则会留下一个已经无人可取消的
      // 定时器，在半小时后把一条早已结束的提问再取消一次。
      this.armWait(request.id);
      try {
        this.publish?.(request);
      } catch (err) {
        // A throwing publisher must not strand the ask either (fail closed).
        waiter.fail(err);
      }
    });
  };

  /** 布置一次兜底等待；`waitMs` 非正或非有限时不布置（调用方自己负责收敛）。 */
  private armWait(id: string): void {
    if (!(this.waitMs > 0) || !Number.isFinite(this.waitMs)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        // 走与「人按了取消」同一条收敛路径，但带的是 `ASK_TIMEOUT`：读者必须能分清
        // 「没有人出现过」和「有人拒绝了」。
        this.failOne(id, new UserQuestionError('ASK_TIMEOUT'), { source: 'timeout' });
      }, this.waitMs),
    );
  }

  /** Answer one outstanding request; false for unknown ids or an invalid answer. */
  resolve(id: string, answer: AskUserQuestionAnswer): boolean {
    const waiter = this.waiters.get(id);
    // An answer that does not fit this request settles nothing: the wait stays
    // open for a corrected frame rather than the model being told something no
    // human said. `validateQuestionAnswer` is the only place that rule lives.
    if (waiter === undefined || !validateQuestionAnswer(waiter.request.questions, answer)) return false;
    waiter.settle(answer);
    this.resolved?.(id, { source: 'user', answer });
    return true;
  }

  /**
   * The human dismissed the whole batch; the ask fails with `ASK_CANCELLED`.
   *
   * `reason` is for the case where there was no dismissal to speak of — the
   * surface could not deliver the card at all. It switches the failure to
   * `ASK_UNDELIVERED` so the model relays "nobody was asked" instead of telling
   * the peer they cancelled a question they never saw.
   */
  cancel(id: string, reason?: string): boolean {
    if (reason !== undefined && reason.length > 0) {
      return this.failOne(id, new UserQuestionError('ASK_UNDELIVERED', reason), { source: 'undelivered', reason });
    }
    return this.failOne(id, new UserQuestionError('ASK_CANCELLED'), { source: 'cancelled' });
  }

  /**
   * Fail-closed sweep: every outstanding ask rejects as aborted. 'aborted' is
   * per-run (the session can ask again next turn); 'closed' is terminal.
   *
   * The spread is load-bearing, not a style choice: the loop below deletes from
   * `waiters`, and `failOne` publishes, so a listener can ask again
   * re-entrantly. Iterating the live map would sweep that brand-new ask too,
   * killing a wait the human was never given a chance to answer.
   */
  failAll(reason: 'aborted' | 'closed'): void {
    if (reason === 'closed') this.closed = true;
    // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot the set this sweep owns
    for (const id of [...this.waiters.keys()]) {
      this.failOne(id, new UserQuestionError('ASK_ABORTED'), { source: reason });
    }
  }

  /**
   * End ONE wait, reporting the resolution exactly once.
   *
   * Every ending funnels through here — including the abort listener, which
   * races the session's `failAll` sweep (both fire off the same abort, in
   * whichever order the caller happens to abort). The waiter-map lookup is the
   * guard: whoever gets there first reports, and the loser sees nothing to do
   * instead of publishing a second `question_resolved` for an ask the surface
   * already cleared.
   * @param id - the request to end.
   * @param error - what the parked tool call fails with.
   * @param resolution - what the event stream reports.
   * @returns whether this call is the one that ended the wait.
   */
  private failOne(id: string, error: Error, resolution: QuestionResolution): boolean {
    const waiter = this.waiters.get(id);
    if (waiter === undefined) return false;
    waiter.fail(error);
    this.resolved?.(id, resolution);
    return true;
  }

  private retire(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.waiters.get(id)?.release?.();
    this.waiters.delete(id);
  }
}

/**
 * "Does this surface have a person to answer `ask_user_question`?" — the ONE
 * derivation, fail-closed by default.
 *
 * Every assembly host copies this rule (the `userQuestions` service provider in
 * `plugins/runtime-env.ts` reads `registry.current()`, and `buildSurfaceRuntime`
 * in the cli reads the surface it just loaded). A future owner of the rule is a
 * single function, not a boolean hand-written at each site: `answersQuestions`
 * declares the person explicitly; an interactive surface defaults to having one
 * (a person is at both ends); everything else (unattended exec / qqbot) stays
 * `false` so a run never parks on a question no card can release.
 */
export function deriveUserQuestions(caps: {
  readonly answersQuestions?: boolean;
  readonly interactive?: boolean;
}): boolean {
  return caps.answersQuestions ?? caps.interactive ?? false;
}
