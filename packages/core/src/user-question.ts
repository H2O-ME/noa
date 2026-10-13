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
  /** The run was interrupted while the question was outstanding. */
  | { source: 'aborted' }
  /** The session closed with the question outstanding (terminal). */
  | { source: 'closed' };

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
export type UserQuestionErrorCode = 'EMPTY_QUESTIONS' | 'NO_PROVIDER' | 'ASK_ABORTED' | 'ASK_CANCELLED';

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
};

/** A typed ask failure: the code is what callers branch on, the message is for the model. */
export class UserQuestionError extends Error {
  constructor(readonly code: UserQuestionErrorCode) {
    super(USER_QUESTION_ERRORS[code]);
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
 * Request/response bridge between the model's ask and whichever surface holds a
 * human: the asker publishes a `QuestionRequest`, the surface answers by id, and
 * every outstanding wait ends — including the fail-closed ends (a dismissal, an
 * aborted run, a closed session) which reject with a typed error instead of
 * hanging or fabricating an answer.
 *
 * Serialization is NOT here: the tool that asks is registered without
 * `isConcurrencySafe`, so the loop already runs one ask at a time.
 */
export class QuestionBroker {
  private readonly waiters = new Map<string, Waiter>();
  /** Installed by the owning AgentSession; called for live surfaces only. */
  private publish: ((request: QuestionRequest) => void) | undefined;
  private resolved: ((id: string, resolution: QuestionResolution) => void) | undefined;
  private closed = false;

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
      try {
        this.publish?.(request);
      } catch (err) {
        // A throwing publisher must not strand the ask either (fail closed).
        waiter.fail(err);
      }
    });
  };

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

  /** The human dismissed the whole batch; the ask fails with `ASK_CANCELLED`. */
  cancel(id: string): boolean {
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
