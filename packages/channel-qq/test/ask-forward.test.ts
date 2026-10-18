/**
 * 一条 ask 的生命周期：先推卡片，再等——**但只在卡片真的推出去之后才等**。
 *
 * 三个线上事故的形状都锁在这里，因为它们都是「操作者那边看起来一切正常」的失败：
 *
 *  - 卡片被叙述额度挤掉：一轮碰了三个工具，三条「正在: …」正好花光叙述上限，审批卡
 *    被同一个上限拒掉，而调用方丢掉了返回值——聊天里什么都没出现，这一轮却停在三分钟
 *    的等待上，最后报「对端超时未答复」。对端从没被问到。
 *  - 推送失败后仍然空等：没有窗口时卡片发不出去，同样白停一整段超时。没人被问到的
 *    问题不该占着这一轮。
 *  - **收敛理由被丢掉**：卡片没发出去，收敛却只报「取消了」，模型于是如实转述成
 *    「你取消了」——对一个从没看到问题的对端说。理由必须进工具结果（见下面那条
 *    提问用例），而且**不能**改走一条 narration 去解释：拒绝这张卡的原因（额度用尽、
 *    没有窗口）同样会拒绝那条解释，发出去只是给自己留一条「我说过了」的假日志。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AskUserQuestionItem } from '@noa/core';
import { PendingAsks, REMOTE_QUESTION_TIMEOUT_MS } from '../src/ask-forward.js';
import { REMOTE_APPROVAL_TIMEOUT_MS } from '../src/remote.js';
import type { PeerNotifier } from '../src/peers.js';
import type { OutboxResult } from '../src/outbox.js';
import type { Peer } from '../src/types.js';

const PEER: Peer = { kind: 'c2c', openid: 'U1', peerId: 'c2c:U1', actorId: 'U1' };
const REQUEST = { id: 'ap-1', call: { name: 'bash', args: { command: 'Get-ChildItem $HOME\\.noa' } } };
const QUESTIONS: AskUserQuestionItem[] = [
  { id: 'db', question: '用哪个数据库？', options: [{ label: 'postgres' }, { label: 'sqlite' }] },
];

/** 记录每次推送（含类别）并按给定结果答复的 notifier。 */
function recordingNotifier(result: OutboxResult | undefined = { ok: true }) {
  const pushes: { text: string; kind: string | undefined }[] = [];
  const notify: PeerNotifier = (_peer, text, _rich, kind) => {
    pushes.push({ text, kind });
    return result;
  };
  return { notify, pushes };
}

/** 一个只记「收敛成什么」的会话（含提问那条路的理由）。 */
function recordingAgent() {
  const decisions: unknown[] = [];
  const cancelled: { id: string; reason: string | undefined }[] = [];
  const agent = {
    resolveApproval: (_id: string, resolution: unknown) => {
      decisions.push(resolution);
      return true;
    },
    cancelQuestion: (id: string, reason?: string) => {
      cancelled.push({ id, reason });
      return true;
    },
  } as unknown as AgentSession;
  return { agent, decisions, cancelled };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('an approval card', () => {
  it('is pushed as an interaction, so narration cannot spend the slot it needs', () => {
    // 类别不是装饰：`narration` 会被叙述额度拦（现在是 2），`interaction` 走自己的
    // 计数器、并且叙述被额外限制在互动预留之外。少了这个类别，三条进度就足以让审批卡
    // 永远发不出去。
    const { notify, pushes } = recordingNotifier();
    const { agent } = recordingAgent();

    new PendingAsks(notify).forwardApproval(agent, PEER, REQUEST);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.kind).toBe('interaction');
    expect(pushes[0]?.text).toContain('需要审批：bash');
  });

  it('waits out its timeout, then denies and says the peer ran out of time', () => {
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier();
    const { agent, decisions } = recordingAgent();

    new PendingAsks(notify).forwardApproval(agent, PEER, REQUEST);
    expect(decisions).toEqual([]);

    vi.advanceTimersByTime(REMOTE_APPROVAL_TIMEOUT_MS);

    expect(decisions).toEqual([{ answer: 'deny', reason: 'QQ 对端超时未答复，按拒绝处理' }]);
    expect(pushes.at(-1)?.text).toContain('审批超时');
  });

  it('does not wait at all when the card never went out', () => {
    // 没人被问到的问题不该占着这一轮：等满三分钟只会拖住整轮，然后给出一个把责任
    // 推给对端的理由。卡片没出去 = 直接按拒绝收敛，并且如实说原因。
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier({ ok: false, reason: 'no live passive-reply window for this peer' });
    const { agent, decisions } = recordingAgent();

    new PendingAsks(notify).forwardApproval(agent, PEER, REQUEST);

    // 理由也要如实：它进工具结果、被模型转述给读者。上一次线上事故里模型说的
    // 「审批请求发到了你的 QQ，但你没及时答复」就是从这句假理由里来的。
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ answer: 'deny' });
    expect(JSON.stringify(decisions[0])).toContain('没能发到聊天里');
    expect(JSON.stringify(decisions[0])).not.toContain('对端超时未答复');

    // 而且**不再**补一条 narration 去解释：拒绝这张卡的原因（额度用尽、没有窗口）
    // 同样会拒绝那条解释，发出去只是留一条「我说过了」的假日志。解释走工具结果 +
    // 模型的回复，回复有保底名额。
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.text).toContain('需要审批');
    // 没有留下一个会再响一次的定时器。
    const settled = pushes.length;
    vi.advanceTimersByTime(REMOTE_APPROVAL_TIMEOUT_MS * 2);
    expect(pushes).toHaveLength(settled);
    expect(decisions).toHaveLength(1);
  });

  it('stands its timer down once the peer answers', () => {
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier();
    const { agent, decisions } = recordingAgent();
    const asks = new PendingAsks(notify);

    asks.forwardApproval(agent, PEER, REQUEST);
    asks.settled(REQUEST.id);
    vi.advanceTimersByTime(REMOTE_APPROVAL_TIMEOUT_MS * 2);

    expect(decisions).toEqual([]);
    expect(pushes).toHaveLength(1);
  });

  it('keeps waiting when the notifier cannot say whether it went out', () => {
    // 缺省座位（测试与降级装配）返回 `undefined`：不知道就等于照旧等，不能凭空
    // 把一条可能已经送达的卡片当成失败。
    vi.useFakeTimers();
    const { notify } = recordingNotifier(undefined);
    const { agent, decisions } = recordingAgent();

    new PendingAsks(notify).forwardApproval(agent, PEER, REQUEST);
    vi.advanceTimersByTime(REMOTE_APPROVAL_TIMEOUT_MS);

    expect(decisions).toHaveLength(1);
  });
});

describe('a question card', () => {
  it('carries the delivery failure into the tool result instead of claiming a cancellation', () => {
    // 线上实测：额度被前面的审批卡用光，提问卡没发出去，而收敛只报「取消了」——
    // 模型于是如实对用户说「你取消了」，可用户从没看到过任何问题。理由必须一路
    // 传到工具结果，让模型说的是「我没能问出去」。
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier({ ok: false, reason: 'interaction allowance spent for this message (4)' });
    const { agent, cancelled } = recordingAgent();

    new PendingAsks(notify).forwardQuestion(agent, PEER, { id: 'q-1', questions: QUESTIONS });

    expect(pushes[0]?.kind).toBe('interaction');
    expect(cancelled).toEqual([{ id: 'q-1', reason: 'interaction allowance spent for this message (4)' }]);
    // 只推了那张没成功的卡，没有第二条解释。
    expect(pushes).toHaveLength(1);
    vi.advanceTimersByTime(REMOTE_QUESTION_TIMEOUT_MS * 2);
    expect(cancelled).toHaveLength(1);
  });

  it('cancels rather than inventing an answer when the peer never replies', () => {
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier();
    const { agent, cancelled } = recordingAgent();

    new PendingAsks(notify).forwardQuestion(agent, PEER, { id: 'q-1', questions: QUESTIONS });
    vi.advanceTimersByTime(REMOTE_QUESTION_TIMEOUT_MS);

    // 超时是**对端**没答复：没有理由，内核据此报 `ASK_CANCELLED`，措辞与「卡片没发出去」
    // 完全不同。两条路必须可分辨，否则模型分不清是谁的问题。
    expect(cancelled).toEqual([{ id: 'q-1', reason: undefined }]);
    expect(pushes.at(-1)?.text).toContain('提问超时');
  });
});
