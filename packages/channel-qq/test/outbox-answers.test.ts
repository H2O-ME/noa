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
import { QqOutbox, INTERACTION_ALLOWANCE, NARRATION_ALLOWANCE, WINDOW_ALLOWANCE } from '../src/outbox.js';
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
      return ['out-1'];
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
    // 通知那一层有上限（而且留了回复的名额），回复自己则没有「通知」那层限制：同一个
    // 窗口里多条回复——一个 `/answer` 旁路、一张回执——能把平台的上限用满。此时必须
    // 如实拒绝，而不是发进平台自己的边界里等它失败。
    const { outbox, sent } = rig();
    for (let i = 0; i < WINDOW_ALLOWANCE; i++) {
      expect((await outbox.reply(PEER, `答 ${i}`)).ok).toBe(true);
    }
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

  it('lets a card through after progress lines have spent the narration cap', () => {
    // The live failure, in one test: a turn touched three tools, the progress lines
    // spent the narration cap exactly (`PROGRESS_MAX_UPDATES` and
    // `NARRATION_ALLOWANCE` are both 2 now), and the approval card — the one message
    // the whole run was stopped on — was refused by that same cap. Nothing appeared
    // in the chat, so nothing could be clicked, and the approval died on its timer
    // reporting that the peer had not answered a question they never received.
    const { outbox, sent } = rig();
    for (let i = 0; i < NARRATION_ALLOWANCE; i++) outbox.narrate(PEER, `正在: 工具 ${i}`);

    const card = outbox.narrate(PEER, '**需要审批：bash**', undefined, 'interaction');

    expect(card).toEqual({ ok: true });
    expect(sent.map((entry) => entry.content)).toContain('**需要审批：bash**');
  });

  it('keeps two slots for cards no matter how much narration a turn wants', () => {
    // 这是那台机器上真实发生的形状：一轮里播报 3 条（旧上限）+ 审批卡 + 提问卡，
    // 而提问卡被拒。现在叙述和互动各有计数器，且叙述被额外限制在互动预留之外——
    // 最坏情况 2 播报 + 2 卡片 + 1 回复 = 5，正好是平台上限。
    const { outbox, sent } = rig();
    for (let i = 0; i < NARRATION_ALLOWANCE + 5; i++) outbox.narrate(PEER, `进展 ${i}`);
    expect(sent).toHaveLength(NARRATION_ALLOWANCE);

    expect(outbox.narrate(PEER, '卡片 A', undefined, 'interaction')).toEqual({ ok: true });
    expect(outbox.narrate(PEER, '卡片 B', undefined, 'interaction')).toEqual({ ok: true });
    const third = outbox.narrate(PEER, '卡片 C', undefined, 'interaction');
    expect(third.ok).toBe(false);
    expect(third.reason).toContain('interaction allowance spent');

    // 播报**不能**动预留：把叙述上限调高就能看到真正起作用的那条约束是预留，
    // 而不是叙述自己的上限——这个区分让「卡片为什么没发出去」在日志里是可读的。
    const roomy = rig({ narrationAllowance: 5 });
    roomy.outbox.narrate(PEER, '进展 1');
    roomy.outbox.narrate(PEER, '进展 2');
    const overNarration = roomy.outbox.narrate(PEER, '再来一条进展');
    expect(overNarration.ok).toBe(false);
    expect(overNarration.reason).toContain('interaction reserve');
  });

  it('still never lets a card spend the reply it is waiting on', async () => {
    // Cards outrank narration, but the reserve is the one thing they cannot take:
    // the run they belong to still has to be able to say its conclusion. With the
    // per-class counters this is structural — notices are capped at
    // `windowAllowance - 1`, so the reply's slot cannot be spent by a notice at all.
    const { outbox, sent } = rig();
    for (let i = 0; i < INTERACTION_ALLOWANCE + 3; i++) {
      outbox.narrate(PEER, `卡片 ${i}`, undefined, 'interaction');
    }
    expect(sent.map((entry) => entry.content)).toHaveLength(INTERACTION_ALLOWANCE);

    const reply = await outbox.reply(PEER, '结论');
    expect(reply.ok).toBe(true);
    expect(sent.at(-1)?.content).toBe('结论');
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
