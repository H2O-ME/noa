/**
 * The user-question seam in core: the untrusted-answer parser, the semantic
 * validator that holds a request, and the broker that owns the wait.
 *
 * Every guard below is asserted by REMOVING it in principle: an answer that
 * names a question nobody asked, two questions with one id, a label that was
 * never offered, a second label on a single-select question, an abort with a
 * question outstanding — each of these must fail closed rather than settle a
 * wait with something no human said.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_ANSWER_CHARS,
  MAX_OPTION_LABEL_CHARS,
  MAX_QUESTIONS,
  QuestionBroker,
  UserQuestionError,
  deriveUserQuestions,
  parseQuestionAnswer,
  validateQuestionAnswer,
  type AskUserQuestionItem,
  type QuestionResolution,
} from '../src/index.js';

const QUESTIONS: AskUserQuestionItem[] = [
  {
    id: 'q1',
    question: 'Which mode?',
    options: [{ label: 'Fast' }, { label: 'Thorough (Recommended)' }],
  },
  { id: 'q2', question: 'Anything else?', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
];

describe('parseQuestionAnswer (untrusted input, fail-closed)', () => {
  it('accepts the wire shape and drops blank custom text', () => {
    expect(parseQuestionAnswer({ answers: [{ id: 'q1', selected: ['Fast'] }] })).toEqual({
      answers: [{ id: 'q1', selected: ['Fast'] }],
    });
    expect(parseQuestionAnswer({ answers: [{ id: 'q1', selected: [], custom: '   ' }] })).toEqual({
      answers: [{ id: 'q1', selected: [] }],
    });
  });

  it('keeps a real custom answer, trimmed and capped', () => {
    const long = 'x'.repeat(MAX_CUSTOM_ANSWER_CHARS + 500);
    const parsed = parseQuestionAnswer({ answers: [{ id: 'q1', selected: [], custom: `  ${long}  ` }] });
    expect(parsed?.answers[0]?.custom).toHaveLength(MAX_CUSTOM_ANSWER_CHARS);
  });

  it('refuses every malformed shape instead of guessing', () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      'answers',
      [],
      {}, // no `answers`
      { answers: 'no' },
      { answers: [{ id: '', selected: [] }] }, // empty id
      { answers: [{ id: 'q1', selected: 'Fast' }] }, // selected is not a list
      { answers: [{ id: 'q1', selected: [7] }] }, // label is not a string
      { answers: [{ id: 'q1', selected: [''] }] }, // empty label
      { answers: [{ id: 'q1', selected: ['x'.repeat(MAX_OPTION_LABEL_CHARS + 1)] }] },
      { answers: [{ id: 'q1', selected: [], custom: 5 }] },
      { answers: [{ id: 'q1', selected: [], custom: 'a\u0000b' }] },
      { answers: [{ id: 'q1', selected: ['a\u0007b'] }] },
      { answers: Array.from({ length: MAX_QUESTIONS + 1 }, () => ({ id: 'q', selected: [] })) },
    ];
    for (const value of bad) {
      expect(parseQuestionAnswer(value), JSON.stringify(value)?.slice(0, 60)).toBeUndefined();
    }
  });
});

describe('validateQuestionAnswer (the request is held here)', () => {
  const ok = { answers: [{ id: 'q1', selected: ['Fast'] }] };

  it('accepts an answer that fits the batch', () => {
    expect(validateQuestionAnswer(QUESTIONS, ok)).toBe(true);
    // A question left unanswered is legal: the model is told which ones came
    // back, so a skipped question is a stated fact rather than a silent gap.
    expect(validateQuestionAnswer(QUESTIONS, { answers: [{ id: 'q1', selected: [] }] })).toBe(true);
    expect(validateQuestionAnswer(QUESTIONS, { answers: [] })).toBe(true);
  });

  it('refuses an answer that does not fit the batch', () => {
    const bad = [
      { answers: [{ id: 'nobody', selected: [] }] }, // unknown question
      { answers: [{ id: 'q1', selected: ['Fast'] }, { id: 'q1', selected: ['Thorough (Recommended)'] }] }, // twice
      { answers: [{ id: 'q1', selected: ['Something else'] }] }, // label never offered
      { answers: [{ id: 'q1', selected: ['Fast', 'Thorough (Recommended)'] }] }, // single-select
      { answers: [{ id: 'q2', selected: ['a', 'a'] }] }, // duplicate label
    ];
    for (const value of bad) {
      expect(validateQuestionAnswer(QUESTIONS, value), JSON.stringify(value)).toBe(false);
    }
  });

  it('allows several labels only where the question is multi-select', () => {
    expect(validateQuestionAnswer(QUESTIONS, { answers: [{ id: 'q2', selected: ['a', 'b'] }] })).toBe(true);
  });
});

/** A broker with the event ends recorded, as an AgentSession attaches them. */
function wired(): { broker: QuestionBroker; requests: string[]; resolutions: QuestionResolution[] } {
  const broker = new QuestionBroker();
  const requests: string[] = [];
  const resolutions: QuestionResolution[] = [];
  broker.attach(
    (request) => requests.push(request.id),
    (_id, resolution) => resolutions.push(resolution),
  );
  return { broker, requests, resolutions };
}

describe('QuestionBroker', () => {
  it('publishes the request before anyone can answer and settles on resolve', async () => {
    const { broker, requests, resolutions } = wired();
    const answer = { answers: [{ id: 'q1', selected: ['Fast'] }] };
    const pending = broker.asker(QUESTIONS);
    expect(requests).toHaveLength(1);
    expect(broker.outstanding()).toHaveLength(1);
    expect(broker.resolve(requests[0] as string, answer)).toBe(true);
    await expect(pending).resolves.toEqual(answer);
    expect(broker.outstanding()).toHaveLength(0);
    expect(resolutions).toEqual([{ source: 'user', answer }]);
  });

  it('refuses an answer that does not fit, leaving the wait open for a good one', async () => {
    const { broker, requests, resolutions } = wired();
    const pending = broker.asker(QUESTIONS);
    const id = requests[0] as string;
    expect(broker.resolve(id, { answers: [{ id: 'nobody', selected: [] }] })).toBe(false);
    expect(broker.outstanding()).toHaveLength(1);
    expect(resolutions).toHaveLength(0);
    // The refused answer settled nothing; the corrected one does.
    expect(broker.resolve(id, { answers: [{ id: 'q1', selected: ['Fast'] }] })).toBe(true);
    await pending;
  });

  it('rejects an empty batch without publishing anything', async () => {
    const { broker, requests } = wired();
    await expect(broker.asker([])).rejects.toBeInstanceOf(UserQuestionError);
    await expect(broker.asker([])).rejects.toMatchObject({ code: 'EMPTY_QUESTIONS' });
    expect(requests).toHaveLength(0);
  });

  it('rejects an already-aborted signal without publishing', async () => {
    const { broker, requests } = wired();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.asker(QUESTIONS, controller.signal)).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(requests).toHaveLength(0);
  });

  it('settles an outstanding ask when the signal aborts mid-wait', async () => {
    const { broker, requests, resolutions } = wired();
    const controller = new AbortController();
    const pending = broker.asker(QUESTIONS, controller.signal);
    expect(broker.outstanding()).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(broker.outstanding()).toHaveLength(0);
    expect(requests).toHaveLength(1);
    // The signal path REPORTS its resolution. The session's `abort()` sweeps the
    // broker itself, but it aborts the run controller too, and that abort reaches
    // this same listener — if only one of the two reported, the surface could be
    // left with a card for a wait that is already over. Reporting here makes the
    // event true whichever fires first; the map guards against a double report.
    expect(resolutions).toEqual([{ source: 'aborted' }]);
  });

  it('fails every outstanding ask closed and reports each one the session way', async () => {
    const { broker, requests, resolutions } = wired();
    const pending = broker.asker(QUESTIONS);
    expect(broker.outstanding()).toHaveLength(1);
    broker.failAll('aborted');
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(broker.outstanding()).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(resolutions).toEqual([{ source: 'aborted' }]);
    // A second sweep finds nothing and reports nothing: one ask, one event.
    broker.failAll('aborted');
    expect(resolutions).toEqual([{ source: 'aborted' }]);
  });

  it('reports a dismissal as cancelled and refuses one for an unknown id', async () => {
    const { broker, requests, resolutions } = wired();
    const pending = broker.asker(QUESTIONS);
    const id = requests[0] as string;
    expect(broker.cancel('nope')).toBe(false);
    expect(broker.cancel(id)).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' });
    expect(resolutions).toEqual([{ source: 'cancelled' }]);
    // One ask, one end: a second cancel of the same id is not a second event.
    expect(broker.cancel(id)).toBe(false);
  });

  it('refuses new asks once the session closed, and marks the close terminal', async () => {
    const { broker, requests, resolutions } = wired();
    const pending = broker.asker(QUESTIONS);
    broker.failAll('closed');
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(resolutions).toEqual([{ source: 'closed' }]);
    await expect(broker.asker(QUESTIONS)).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(requests).toHaveLength(1);
  });

  it('does not strand the ask when the publisher throws', async () => {
    // A surface whose publish path throws must not leave the model parked with
    // no card anywhere — the failure is the ask's failure.
    const broker = new QuestionBroker();
    broker.attach(() => { throw new Error('socket gone'); }, () => undefined);
    await expect(broker.asker(QUESTIONS)).rejects.toThrow('socket gone');
    expect(broker.outstanding()).toHaveLength(0);
  });

  it('reports the abort once when the signal and the sweep both fire', async () => {
    // The session's `abort()` sweeps the broker AND aborts the run controller,
    // so both endings arrive. Two `question_resolved` events for one ask would
    // make a surface clear a card that a later ask had already replaced.
    const { broker, resolutions } = wired();
    const controller = new AbortController();
    const pending = broker.asker(QUESTIONS, controller.signal);
    broker.failAll('aborted');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(resolutions).toHaveLength(1);
  });

  it('settles a surface that answers inside the publish call', async () => {
    // A scripted client or a same-tick channel reply answers before `asker`
    // returns. Registering the waiter AFTER publishing used to swallow that
    // answer, and the run then hung on an ask nobody could reach.
    const broker = new QuestionBroker();
    const answer = { answers: [{ id: 'q1', selected: ['Fast'] }] };
    broker.attach((request) => { broker.resolve(request.id, answer); }, () => undefined);
    await expect(broker.asker(QUESTIONS)).resolves.toEqual(answer);
    expect(broker.outstanding()).toHaveLength(0);
  });
});

describe('deriveUserQuestions — "does this surface have a person"', () => {
  // The one derivation every assembly host copies (`runtime-env` service
  // provider, cli `buildSurfaceRuntime`). Fail-closed by default, and the
  // explicit declaration beats the interactive default: a surface that says
  // `answersQuestions: false` must never get an answerer a run could park on.
  it('answers true when the surface declares it can answer', () => {
    expect(deriveUserQuestions({ answersQuestions: true })).toBe(true);
  });

  it('answers true for an interactive surface even without a declaration', () => {
    // A person is at both ends of a TTY; the TUI only claims interactive runs.
    expect(deriveUserQuestions({ interactive: true })).toBe(true);
    expect(deriveUserQuestions({ answersQuestions: true, interactive: false })).toBe(true);
  });

  it('fails closed (false) when nothing says a person is present', () => {
    expect(deriveUserQuestions({})).toBe(false);
    expect(deriveUserQuestions({ interactive: false })).toBe(false);
    expect(deriveUserQuestions({ answersQuestions: false })).toBe(false);
    // A surface that explicitly says it cannot answer must not be resurrected by
    // the interactive default.
    expect(deriveUserQuestions({ answersQuestions: false, interactive: true })).toBe(false);
  });
});
