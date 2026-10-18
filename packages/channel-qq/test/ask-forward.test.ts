/**
 * 一条 ask 的生命周期：先推卡片，再等——**但只在卡片真的推出去之后才等**。
 *
 * 两个线上事故的形状都锁在这里，因为它们都是「操作者那边看起来一切正常」的失败：
 *
 *  - 卡片被叙述额度挤掉：一轮碰了三个工具，三条「正在: …」正好花光叙述上限，审批卡
 *    被同一个上限拒掉，而调用方丢掉了返回值——聊天里什么都没出现，这一轮却停在三分钟
 *    的等待上，最后报「对端超时未答复」。对端从没被问到。
 *  - 推送失败后仍然空等：没有窗口时卡片发不出去，同样白停一整段超时。没人被问到的
 *    问题不该占着这一轮。
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

/** 一个只记「收敛成什么」的会话。 */
function recordingAgent() {
  const decisions: unknown[] = [];
  const cancelled: string[] = [];
  const agent = {
    resolveApproval: (_id: string, resolution: unknown) => {
      decisions.push(resolution);
      return true;
    },
    cancelQuestion: (id: string) => {
      cancelled.push(id);
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
    // 类别不是装饰：`narration` 会被叙述额度（3）拦，`interaction` 不会。少了这个
    // 类别，三个工具的进度就足以让审批卡永远发不出去。
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

    const note = pushes.at(-1)?.text ?? '';
    expect(note).toContain('没能发到聊天里');
    expect(note).toContain('no live passive-reply window');
    // 而且没有留下一个会再响一次的定时器。
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
  it('is pushed as an interaction and cancelled outright when it never went out', () => {
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier({ ok: false, reason: 'interaction allowance spent for this message (4)' });
    const { agent, cancelled } = recordingAgent();

    new PendingAsks(notify).forwardQuestion(agent, PEER, { id: 'q-1', questions: QUESTIONS });

    expect(pushes[0]?.kind).toBe('interaction');
    expect(cancelled).toEqual(['q-1']);
    const note = pushes.at(-1)?.text ?? '';
    expect(note).toContain('没能发到聊天里');
    expect(note).not.toContain('超时');
    vi.advanceTimersByTime(REMOTE_QUESTION_TIMEOUT_MS * 2);
    expect(cancelled).toHaveLength(1);
  });

  it('cancels rather than inventing an answer when the peer never replies', () => {
    vi.useFakeTimers();
    const { notify, pushes } = recordingNotifier();
    const { agent, cancelled } = recordingAgent();

    new PendingAsks(notify).forwardQuestion(agent, PEER, { id: 'q-1', questions: QUESTIONS });
    vi.advanceTimersByTime(REMOTE_QUESTION_TIMEOUT_MS);

    expect(cancelled).toEqual(['q-1']);
    expect(pushes.at(-1)?.text).toContain('提问超时');
  });
});
