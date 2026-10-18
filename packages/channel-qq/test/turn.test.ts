/**
 * 一轮的收尾语义：回复取哪条、被打断怎么报、失败怎么抛。
 *
 * 这里没有流式，所以「回复」这件事只有一条定义：**最后一条非空助手文本**。它同时也要
 * 经过观察者（那条文本可能成为过程叙述——由后一次工具调用冲刷），但答案本身由调用方
 * 通过回复座位送出，不经叙述配额。这两件事在流式那套东西删掉之后尤其容易再次走散，
 * 所以钉在这里。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@noa/core';
import { PendingAsks } from '../src/ask-forward.js';
import { promptOnce, type TurnObserver } from '../src/turn.js';
import type { Peer } from '../src/types.js';

const PEER: Peer = { kind: 'c2c', openid: 'U1', peerId: 'c2c:U1', actorId: 'U1' };

/** 一个按剧本发事件的最小会话；`prompt` 就是「剧本开始播放」。 */
function scriptedAgent(events: readonly unknown[]): AgentSession {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    subscribe: (cb: (event: unknown) => void) => {
      listeners.push(cb);
      return () => {
        const at = listeners.indexOf(cb);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
    prompt: async () => {
      for (const event of events) for (const cb of listeners) cb(event);
    },
  } as unknown as AgentSession;
}

/** 一条助手消息事件。 */
function assistant(id: string, content: string): unknown {
  return { type: 'message', message: { id, role: 'assistant', content, ts: 0 } };
}

/** 一轮结束。 */
const IDLE = { type: 'phase', phase: 'idle' };

/** 记录叙述与工具名的观察者。 */
function recordingObserver(): TurnObserver & { texts: string[]; tools: string[] } {
  const texts: string[] = [];
  const tools: string[] = [];
  return { texts, tools, text: (body) => texts.push(body), tool: (name) => tools.push(name) };
}

describe('promptOnce', () => {
  it('takes the LAST assistant text as the reply, and lets every text reach the observer', async () => {
    const agent = scriptedAgent([
      assistant('m1', '先看一眼代码'),
      { type: 'tool_call_start', call: { name: 'read_file' } },
      assistant('m2', '结论：没问题'),
      IDLE,
    ]);
    const observer = recordingObserver();
    const result = await promptOnce(agent, new PendingAsks(), { text: '看看' }, PEER, observer);

    expect(result.reply).toBe('结论：没问题');
    // 每条文本都交给观察者：是不是叙述由它按预算决定，这里不做取舍。
    expect(observer.texts).toEqual(['先看一眼代码', '结论：没问题']);
    expect(observer.tools).toEqual(['read_file']);
  });

  it('reports an empty reply for a turn that said nothing (the caller owns the floor line)', async () => {
    // 兜底文案属于对端编排（`peers.ts` 把它当作答案返回），不在这一层凭空造一句。
    const agent = scriptedAgent([{ type: 'tool_call_start', call: { name: 'bash' } }, IDLE]);
    const result = await promptOnce(agent, new PendingAsks(), { text: '跑一下' }, PEER, recordingObserver());
    expect(result.reply).toBe('');
    expect(result.aborted).toBeUndefined();
  });

  it('ignores whitespace-only assistant messages', async () => {
    const agent = scriptedAgent([assistant('m1', '  \n '), assistant('m2', '有话说'), IDLE]);
    const result = await promptOnce(agent, new PendingAsks(), { text: '在吗' }, PEER);
    expect(result.reply).toBe('有话说');
  });

  it('reports a cut-short turn as aborted', async () => {
    const agent = scriptedAgent([assistant('m1', '说到一半'), { type: 'turn_aborted' }, IDLE]);
    const result = await promptOnce(agent, new PendingAsks(), { text: '停' }, PEER);
    expect(result.aborted).toBe(true);
  });

  it('throws the kernel failure so the caller can answer honestly', async () => {
    const agent = scriptedAgent([{ type: 'run_failed', message: '上游挂了' }, IDLE]);
    await expect(promptOnce(agent, new PendingAsks(), { text: '在吗' }, PEER)).rejects.toThrow('上游挂了');
  });

  it('survives an observer that throws, because narration never fails the turn', async () => {
    const agent = scriptedAgent([assistant('m1', '结论'), { type: 'tool_call_start', call: { name: 'bash' } }, IDLE]);
    const observer: TurnObserver = {
      text: () => {
        throw new Error('narration blew up');
      },
      tool: () => {
        throw new Error('narration blew up');
      },
    };
    const result = await promptOnce(agent, new PendingAsks(), { text: '在吗' }, PEER, observer);
    expect(result.reply).toBe('结论');
  });

  it('unsubscribes at idle, so no listener outlives its turn', async () => {
    const agent = scriptedAgent([assistant('m1', '结论'), IDLE]);
    const spy = vi.spyOn(agent, 'subscribe');
    await promptOnce(agent, new PendingAsks(), { text: '在吗' }, PEER);
    const unsubscribe = spy.mock.results[0]?.value as () => void;
    // 轮结束后再发一条：没有监听者，也就不该有人收到它。
    expect(typeof unsubscribe).toBe('function');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
