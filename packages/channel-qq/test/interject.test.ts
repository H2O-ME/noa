/**
 * 入站侧的**插话**：一条在轮次跑着的时候到达的消息，应当交给插话座位，而不是排在队列
 * 后面等那一轮跑完。
 *
 * 这里钉的是 `inbound.ts` 那一层的顺序——先解析这一轮（附件是网络往返），**再**做插话
 * 判定（必须同步）。判定为真就不再入队：那一轮的收尾会带上这句话，这里再排一次就会
 * 让同一句话被答两遍。判定为假（没有在跑的轮次、或没有插话座位）则照旧排队，由它自己
 * 开一轮。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentSession, ApprovalMode, KernelEvent, SessionService } from '@noa/core';
import { BindingsStore } from '../src/bindings.js';
import { PeerTurns } from '../src/peers.js';
import { INTERJECT_ACK } from '../src/progress.js';
import { InboundHandler } from '../src/inbound.js';
import type { ReplySink } from '../src/reply.js';
import type { Peer, TurnInput } from '../src/types.js';

function groupMessage(id: string, content: string): unknown {
  return {
    id,
    group_openid: 'g1',
    author: { member_openid: 'u1' },
    content,
    timestamp: new Date().toISOString(),
  };
}

interface Rig {
  replies: string[];
  brainCalls: string[];
  interjectCalls: TurnInput[];
  release: () => void;
}

/**
 * A handler whose `busy` prompt parks until released — "a turn is running".
 *
 * The seat mirrors the real one's SHAPE: it is asked for every ordinary message and
 * answers from whether a run is actually in flight. A fixture that always said yes
 * would let the FIRST message interject into nothing, which is not a state the real
 * seat can be in (`PeerTurns.interject` checks the live handle).
 */
function makeHandler(options: { accept?: boolean } = {}): { handler: InboundHandler; rig: Rig } {
  const replies: string[] = [];
  const brainCalls: string[] = [];
  const interjectCalls: TurnInput[] = [];
  let running = false;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const reply: ReplySink = {
    reply: (_peerId, content) => {
      replies.push(content);
      return Promise.resolve({ ok: true });
    },
  };
  const handler = new InboundHandler({
    brain: (turn) => {
      brainCalls.push(turn.text);
      if (turn.text !== 'busy') return Promise.resolve(`echo:${turn.text}`);
      running = true;
      return gate.then(() => {
        running = false;
        return 'busy-done';
      });
    },
    reply,
    log: () => undefined,
    // 插话座位是**同步**的（见 `AgentSession.interject`），所以夹具也同步。
    interject: (turn) => {
      interjectCalls.push(turn);
      return options.accept ?? running;
    },
  });
  return { handler, rig: { replies, brainCalls, interjectCalls, release: open } };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('a message that arrives while a turn is running', () => {
  it('is handed to the interject seat and not queued behind the running turn', async () => {
    const { handler, rig } = makeHandler();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'busy') });
    await settle();
    expect(rig.brainCalls).toEqual(['busy']);

    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '顺便看看 8080') });
    await settle();

    // 座位拿到了这条消息（同步，且已经解析成一轮）。第一条消息也问过它——通道不知道
    // 「有没有在跑」，那是座位的知识；所以每条普通消息都问一次，由座位回答成立与否。
    expect(rig.interjectCalls).toEqual([{ text: 'busy' }, { text: '顺便看看 8080' }]);
    // 关键：没有第二次 brain 调用——它没被排成新的一轮。正在跑的那一轮的收尾会带上它。
    expect(rig.brainCalls).toEqual(['busy']);
    // 入站侧不发回执：回执属于插话座位（`peers.ts`），因为只有那里同时握着会话与通知
    // 座位，也只有那里知道插话是不是真的成立。
    expect(rig.replies).toEqual([]);

    // 让那一轮跑完：只有它的答复，没有第二句。
    rig.release();
    await settle();
    expect(rig.replies).toEqual(['busy-done']);
  });

  it('queues it normally when the seat declines (nothing is running)', async () => {
    const { handler, rig } = makeHandler({ accept: false });
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'busy') });
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '第二句') });
    await settle();

    // 座位被问过，但说了不成立。
    expect(rig.interjectCalls).toEqual([{ text: 'busy' }, { text: '第二句' }]);
    // 于是它排在队列里，等第一轮跑完才开自己那一轮。
    expect(rig.brainCalls).toEqual(['busy']);
    rig.release();
    await settle();
    expect(rig.brainCalls).toEqual(['busy', '第二句']);
    expect(rig.replies).toEqual(['busy-done', 'echo:第二句']);
  });

  it('interjects with the trimmed text', async () => {
    const { handler, rig } = makeHandler();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'busy') });
    await settle();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '  前后有空格  ') });
    await settle();

    expect(rig.interjectCalls.at(-1)).toEqual({ text: '前后有空格' });
    rig.release();
    await settle();
  });
});

/**
 * 插话座位（`PeerTurns.interject`）：判定 + 回执都在这里。
 *
 * 钉两件事，都是设计上的取舍而不是实现细节：
 *  - **回执走叙述配额**（`notify`），不走回复座位。回复那一格留给答案，一条回执把它
 *    花掉就是用「收到了」换掉「做完了」。
 *  - 没有活句柄、或句柄不在跑，就如实说不成立（返回 false），让入站侧照常排队——
 *    而不是造一个「插进去了」的假象。
 */
const PEER: Peer = { kind: 'c2c', openid: 'U1', peerId: 'c2c:U1' };

interface SeatRig {
  turns: PeerTurns;
  notified: string[];
  interjected: { text: string; images: unknown }[];
  /** Flip to false to stand in for "no turn is running". */
  agent: { running: boolean };
}

/** A session stand-in: `prompt` emits one assistant line then goes idle. */
async function seatRig(): Promise<SeatRig> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-qqbot-interject-'));
  const notified: string[] = [];
  const interjected: { text: string; images: unknown }[] = [];
  const listeners = new Set<(event: KernelEvent) => void>();
  const agent = {
    session: { id: 'sess_i1', file: 'sess_i1.jsonl', events: [], allMessages: (): AgentMessage[] => [] },
    messages: [] as AgentMessage[],
    approvalMode: 'auto' as ApprovalMode,
    disposed: false,
    running: true,
    pendingApprovals: () => [],
    pendingQuestions: () => [],
    resolveApproval: () => true,
    resolveQuestion: () => true,
    abort: () => undefined,
    setApprovalMode: () => undefined,
    interject: (text: string, images: unknown) => {
      interjected.push({ text, images });
      return true;
    },
    subscribe: (listener: (event: KernelEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prompt: async () => {
      for (const listener of listeners) listener({ type: 'phase', phase: 'idle' } as KernelEvent);
    },
  };
  const sessions: SessionService = {
    current: () => undefined,
    get: () => undefined,
    list: () => [],
    open: () => Promise.resolve(agent as unknown as AgentSession),
    activate: () => undefined,
  };
  const turns = new PeerTurns({
    sessions,
    sessionDir: dir,
    catalogDir: dir,
    bindings: new BindingsStore(path.join(dir, 'bindings.json')),
    rootDir: () => 'D:/work',
    model: () => 'm1',
    notify: (_peer, text) => {
      notified.push(text);
      return { ok: true };
    },
  });
  // 先跑一轮，让这个对端的活句柄进 `peers` 表——插话座位只看那张表，因为判定必须同步。
  await turns.run({ text: '先干正事' }, PEER);
  return { turns, notified, interjected, agent };
}

describe('the interject seat', () => {
  it('folds the message in and acknowledges it on the narration budget', async () => {
    const rig = await seatRig();
    const accepted = rig.turns.interject({ text: '顺便看看 8080', images: [] }, PEER);

    expect(accepted).toBe(true);
    expect(rig.interjected).toEqual([{ text: '顺便看看 8080', images: [] }]);
    // 回执照走叙述（`notify`），没碰回复座位。
    expect(rig.notified).toEqual([INTERJECT_ACK]);
  });

  it('declines when no turn is running, so the caller queues it', async () => {
    const rig = await seatRig();
    rig.agent.running = false;

    expect(rig.turns.interject({ text: '没人在跑' }, PEER)).toBe(false);
    // 说不成立就不该发回执：回执说「已插进正在跑的那一轮」，而那一轮并不存在。
    expect(rig.notified).toEqual([]);
    expect(rig.interjected).toEqual([]);
  });

  it('declines for a peer it has never opened a session for', async () => {
    const rig = await seatRig();
    const stranger: Peer = { kind: 'c2c', openid: 'U9', peerId: 'c2c:U9' };
    expect(rig.turns.interject({ text: '陌生人' }, stranger)).toBe(false);
    expect(rig.notified).toEqual([]);
  });
});
