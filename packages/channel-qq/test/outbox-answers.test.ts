/**
 * The one outbox, the question mapping, and the stop verb.
 *
 * All three exist because a single chat window has to stand in for a whole UI, and
 * each of them has a failure mode that looks like success from the operator's side:
 *
 *  - an outbox that does not share its ledger lets one path spend the allowance the
 *    answer was holding → the peer gets narration and never the result;
 *  - a question mapping that is silently wrong is REJECTED by the broker, so the run
 *    stays parked while the peer believes they answered;
 *  - `/stop` cannot be allowed to queue behind the run it is meant to release.
 */
import { describe, expect, it } from 'vitest';
import type { AskUserQuestionItem } from '@noa/core';
import { QqOutbox, NARRATION_ALLOWANCE, WINDOW_ALLOWANCE } from '../src/outbox.js';
import { layoutQuestions, renderQuestions } from '../src/question-reply.js';
import { parseAnswer } from '../src/question-answer.js';
import { parseRemoteCommand, remoteBypassesQueue } from '../src/remote-parse.js';

const PEER = 'c2c:U1';

/** An outbox over a recording transport with one live window. */
function rig(overrides: { windowAllowance?: number; narrationAllowance?: number } = {}) {
  const sent: { peerId: string; content: string; msgId?: string }[] = [];
  let window: string | undefined = 'IN1';
  const outbox = new QqOutbox({
    send: async (peerId, content, msgId) => {
      sent.push({ peerId, content, ...(msgId !== undefined ? { msgId } : {}) });
      return '1 message(s), last id out-1';
    },
    lastMsgIdOf: () => window,
    ...overrides,
  });
  return { outbox, sent, setWindow: (next: string | undefined) => { window = next; } };
}

describe('the outbox owns the window and the allowance', () => {
  it('refuses everything without a live window, instead of sending proactively', async () => {
    const { outbox, sent, setWindow } = rig();
    setWindow(undefined);
    expect(outbox.narrate(PEER, '进程')).toEqual({ ok: false, reason: 'no live passive-reply window for this peer' });
    expect((await outbox.reply(PEER, '结论')).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it('keeps a reply in reserve when the narration allowance is spent', async () => {
    // The property the whole ledger exists for: narration is droppable, the result
    // is not. A shared counter with no reserve drops the ANSWER.
    const { outbox, sent } = rig();
    for (let i = 0; i < NARRATION_ALLOWANCE + 2; i++) outbox.narrate(PEER, `进展 ${i}`);
    expect(sent.map((entry) => entry.content)).toHaveLength(NARRATION_ALLOWANCE);
    const reply = await outbox.reply(PEER, '结论');
    expect(reply.ok).toBe(true);
    expect(sent.at(-1)?.content).toBe('结论');
  });

  it('enforces the platform bound on the reply too, and says so', async () => {
    const { outbox, sent } = rig({ narrationAllowance: 5 });
    for (let i = 0; i < WINDOW_ALLOWANCE; i++) outbox.narrate(PEER, `进展 ${i}`);
    const refused = await outbox.reply(PEER, '结论');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('reply allowance spent');
    expect(sent).toHaveLength(WINDOW_ALLOWANCE);
  });

  it('counts per inbound window, so the next message gets a fresh allowance', async () => {
    const { outbox, setWindow } = rig();
    for (let i = 0; i < NARRATION_ALLOWANCE; i++) outbox.narrate(PEER, `a${i}`);
    expect(outbox.narrate(PEER, 'over')).toMatchObject({ ok: false });
    setWindow('IN2');
    expect(outbox.narrate(PEER, 'fresh')).toEqual({ ok: true });
  });

  it('ignores an empty reply rather than spending the allowance on it', async () => {
    const { outbox, sent } = rig();
    expect((await outbox.reply(PEER, '   ')).ok).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('a question over a chat window', () => {
  const single: AskUserQuestionItem[] = [
    {
      id: 'db',
      question: '用哪个数据库？',
      options: [{ label: 'postgres' }, { label: 'sqlite' }],
    },
  ];
  const multi: AskUserQuestionItem[] = [
    { id: 'ui', question: '要哪些界面？', multiSelect: true, options: [{ label: 'web' }, { label: 'cli' }] },
    { id: 'note', question: '还有别的吗？' },
  ];

  it('renders numbered options, because "the second one" has to be sayable', () => {
    const rendered = renderQuestions(single);
    expect(rendered).toContain('1. postgres');
    expect(rendered).toContain('2. sqlite');
    expect(layoutQuestions(single)[0]?.choices).toHaveLength(2);
  });

  it('maps a number to the option label the kernel will validate', () => {
    // The answer is checked against the questions asked, so a wrong mapping is
    // REFUSED there — the run stays parked and the peer thinks they answered.
    expect(parseAnswer(single, '2')).toEqual({ ok: true, answer: { answers: [{ id: 'db', selected: ['sqlite'] }] } });
  });

  it('treats prose against a menu as a free-text answer, not an error', () => {
    expect(parseAnswer(single, '用 postgres 吧')).toEqual({
      ok: true,
      answer: { answers: [{ id: 'db', selected: [], custom: '用 postgres 吧' }] },
    });
  });

  it('answers a question with no options from the line itself', () => {
    const parsed = parseAnswer([{ id: 'q', question: '项目叫什么？' }], 'nova');
    expect(parsed).toEqual({ ok: true, answer: { answers: [{ id: 'q', selected: [], custom: 'nova' }] } });
  });

  it('requires id=answer for a batch, and says which ids exist', () => {
    const bad = parseAnswer(multi, '随便');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false ? bad.reason : '').toContain('编号=回答');
    // Numbers address the batch by position.
    const byNumber = parseAnswer(multi, '1=1,2 2=没有');
    expect(byNumber).toEqual({
      ok: true,
      answer: {
        answers: [
          { id: 'ui', selected: ['web', 'cli'] },
          { id: 'note', selected: [], custom: '没有' },
        ],
      },
    });
    // Unmentioned questions are SKIPPED, never invented: putting words in the
    // peer's mouth is worse than an empty answer.
    expect(parseAnswer(multi, 'ui=1')).toEqual({
      ok: true,
      answer: { answers: [{ id: 'ui', selected: ['web'] }, { id: 'note', selected: [] }] },
    });
  });

  it('refuses an out-of-range number and a multi-pick on a single-select', () => {
    expect(parseAnswer(single, '9').ok).toBe(false);
    const both = parseAnswer(single, '1,2');
    expect(both.ok).toBe(false);
    expect(both.ok === false ? both.reason : '').toContain('只能选一个');
  });
});

describe('/stop and /answer are unblocking', () => {
  it('parses both, and both skip the serial queue', () => {
    // A verb that must release a run cannot wait behind that run: queueing either
    // of these is the deadlock the bypass exists to prevent.
    expect(parseRemoteCommand('/stop').command).toEqual({ kind: 'stop' });
    expect(parseRemoteCommand('/answer 1').command).toEqual({ kind: 'answer', text: '1' });
    expect(remoteBypassesQueue({ kind: 'stop' })).toBe(true);
    expect(remoteBypassesQueue({ kind: 'answer', text: '1' })).toBe(true);
    // Empty arguments are the one thing each refuses (as a prompt, so nothing is
    // swallowed).
    expect(parseRemoteCommand('/answer').command).toBeUndefined();
  });
});
