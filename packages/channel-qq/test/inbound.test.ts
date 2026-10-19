/**
 * 入站处理与遥控旁路（`packages/qqbot/src/inbound.ts`）。
 *
 * 这个文件钉的是一条**死锁**：一轮对话是全局串行的（`queue`），而一轮可能停在审批上
 * 等对端回答。如果那句答复也要排队，它会永远排在自己所等的那一轮后面——整轮运行就此
 * 停死。所以遥控指令必须走队列**之外**的旁路。
 */
import { describe, expect, it, vi } from 'vitest';
import { InboundHandler } from '../src/inbound.js';
import type { ReplySink } from '../src/reply.js';
import type { Peer } from '../src/types.js';

/** 一条 group 入站消息的 dispatch 负载。 */
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
  replies: { peer: Peer; text: string }[];
  /** 让 brain 停在这一步，直到调用 release。 */
  release: () => void;
  brainCalls: string[];
}

function makeHandler(): { handler: InboundHandler; rig: Rig } {
  const replies: Rig['replies'] = [];
  const brainCalls: string[] = [];
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  // The sink is what the OUTBOX implements: it owns the window and the allowance,
  // so a fake here only has to record what it was asked to send.
  const reply: ReplySink = {
    reply: (peerId, content) => {
      replies.push({ peer: { peerId, kind: peerId.startsWith('group:') ? 'group' : 'c2c', openid: peerId }, text: content });
      return Promise.resolve({ ok: true });
    },
  };
  const handler = new InboundHandler({
    // The first prompt parks until `release()`, standing in for a turn stopped on
    // an approval; a normal prompt would wait for it in the serial queue.
    brain: (turn) => {
      brainCalls.push(turn.text);
      return turn.text === 'park' ? gate.then(() => 'parked-done') : Promise.resolve(`echo:${turn.text}`);
    },
    reply,
    log: () => undefined,
    remote: {
      claim: (text) => text.startsWith('/'),
      handle: (text) => Promise.resolve(`remote:${text}`),
    },
  });
  return { handler, rig: { replies, release: open, brainCalls } };
}

/** Let the microtask queue drain so queued work can run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('inbound remote bypass', () => {
  it('answers a remote command while a turn is parked on approval', async () => {
    const { handler, rig } = makeHandler();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'park') });
    await settle();
    // The turn is now parked. A reply that had to queue behind it could never run.
    expect(rig.replies).toEqual([]);

    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '/approve') });
    await settle();

    // The bypass answered, even though the earlier turn still holds the queue.
    expect(rig.replies.map((entry) => entry.text)).toEqual(['remote:/approve']);
    // And the parked turn is untouched — proof the two did not serialize.
    rig.release();
    await settle();
    expect(rig.replies.map((entry) => entry.text)).toEqual(['remote:/approve', 'parked-done']);
  });

  it('keeps ordinary prompts serial, so two in a row do not interleave', async () => {
    const { handler, rig } = makeHandler();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'park') });
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', 'second') });
    await settle();
    // The second prompt has NOT started: the serial queue is doing its job.
    expect(rig.brainCalls).toEqual(['park']);
    rig.release();
    await settle();
    expect(rig.brainCalls).toEqual(['park', 'second']);
  });
});

/**
 * 去重窗口与被动回复窗口的关系。
 *
 * 平台会在重连后重放 dispatch，重放的是它自己窗口内的那条消息。去重 TTL 比窗口短，
 * 重放就会被当成新消息**再跑一整轮**——重复的 token，以及重复的副作用。所以 TTL 由
 * 最长的窗口推导（见 `DEDUPE_TTL_MS`），这里钉住那个推导的结果。
 */
describe('inbound dedupe window', () => {
  /** 只冻结 Date：`settle()` 用的真 setTimeout 必须还能跑。 */
  async function atFixedClock<T>(run: (advance: (ms: number) => void) => Promise<T>): Promise<T> {
    const base = Date.parse('2026-01-01T00:00:00Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(base);
    try {
      return await run((ms) => vi.setSystemTime(base + ms));
    } finally {
      vi.useRealTimers();
    }
  }

  it('treats a replay inside the longest passive window as a duplicate', async () => {
    await atFixedClock(async (advance) => {
      const { handler } = makeHandler();
      handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
      await settle();
      // 6 分钟：已过群窗口（4.5 分钟），但远在最长窗口（单聊 55 分钟）之内。
      // 旧的 5 分钟 TTL 会在这里把重放当成新消息，于是第二轮白跑。
      advance(6 * 60_000);
      handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
      await settle();
      expect(handler.stats().received).toBe(1);
    });
  });

  it('forgets a msg_id once every window it could belong to has closed', async () => {
    await atFixedClock(async (advance) => {
      const { handler } = makeHandler();
      handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
      await settle();
      // 一小时：任何被动窗口都已关闭，平台不可能再重放它，此时忘记才是对的
      // ——否则一个被复用的 id 会让真实消息被静默丢弃。
      advance(60 * 60_000);
      handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
      await settle();
      expect(handler.stats().received).toBe(2);
    });
  });
});

describe('inbound counters', () => {
  it('counts a message once, and a reply only when it went out', async () => {
    // The settings page now shows 「收到 N 条 / 已回复 M 条」, so the two tallies
    // have to mean what they say: the gateway pushes the same msg_id twice
    // (dedupe), and a reply that FAILED is not a reply.
    const { handler } = makeHandler();
    let failure = false;
    const reply: ReplySink = {
      reply: () => (failure ? Promise.resolve({ ok: false, reason: 'rate limited' }) : Promise.resolve({ ok: true })),
    };
    const counting = new InboundHandler({ brain: (turn) => Promise.resolve(`echo:${turn.text}`), reply, log: () => undefined });

    counting.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
    await settle();
    // Same msg_id again: the platform repeats events, and a repeat is not a message.
    counting.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
    await settle();
    expect(counting.stats()).toMatchObject({ received: 1, replied: 1 });
    expect(counting.stats().lastReceivedAt).toBeTypeOf('number');

    failure = true;
    counting.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', 'hi') });
    await settle();
    expect(counting.stats()).toMatchObject({ received: 2, replied: 1 });
    // Untouched by the other cases: this handler never saw a message.
    expect(handler.stats()).toEqual({ received: 0, replied: 0 });
  });
});

/**
 * 发不出去的**结论**：寄存，等这个对端下一条消息把被动窗口带回来再补发。
 *
 * 这里钉的是「长任务在群里答不出来」的正面解法，以及它的边界：只有跑完一轮的成果走这
 * 条路（遥控指令的答复可以重新问一次），空答复是「无话可说」而不是丢失，补发再次失败
 * 时必须原样放回而不是悄悄吃掉。
 */
describe('held answers', () => {
  interface HeldRig {
    handler: InboundHandler;
    replies: string[];
    /**
     * 会被拒发的答复：按**子串**匹配，因为补发时会加一行前缀，而拒发判定要看的是
     * 内容而不是那一行的有无。
     */
    refuse: Set<string>;
  }

  function makeHeldRig(brain: (text: string) => string): HeldRig {
    const replies: string[] = [];
    const refuse = new Set<string>();
    const reply: ReplySink = {
      reply: (_peerId, content) => {
        for (const needle of refuse) {
          if (content.includes(needle)) return Promise.resolve({ ok: false, reason: 'no passive window' });
        }
        replies.push(content);
        return Promise.resolve({ ok: true });
      },
    };
    const handler = new InboundHandler({ brain: (turn) => Promise.resolve({ text: brain(turn.text) }), reply, log: () => undefined });
    return { handler, replies, refuse };
  }

  it('re-delivers a held answer when the next message brings a window back', async () => {
    const rig = makeHeldRig((text) => (text === 'long' ? '跑完了，结论是 42' : `echo:${text}`));
    rig.refuse.add('跑完了，结论是 42');

    rig.handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'long') });
    await settle();
    // 窗口关着：没发出去，也不该被当成发送成功。
    expect(rig.replies).toEqual([]);
    expect(rig.handler.stats()).toMatchObject({ received: 1, replied: 0 });

    rig.refuse.clear();
    rig.handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '还在吗') });
    await settle();
    // 迟到的那条先走（它本来就是先发生的），并且带着说明自己是迟到的。
    expect(rig.replies).toHaveLength(2);
    expect(rig.replies[0]).toContain('上一轮的结论，当时没发出去');
    expect(rig.replies[0]).toContain('跑完了，结论是 42');
    expect(rig.replies[1]).toBe('echo:还在吗');
  });

  it('puts a held answer back when re-delivery fails too', async () => {
    const rig = makeHeldRig((text) => (text === 'long' ? '结论 42' : `echo:${text}`));
    rig.refuse.add('结论 42');

    rig.handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'long') });
    await settle();
    rig.handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', 'hi') });
    await settle();
    // 补发也失败：只剩新消息自己的答复，寄存的那条还在队列里。
    expect(rig.replies).toEqual(['echo:hi']);

    rig.refuse.clear();
    rig.handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m3', 'hi2') });
    await settle();
    expect(rig.replies).toHaveLength(3);
    expect(rig.replies[1]).toContain('结论 42');
    expect(rig.replies[2]).toBe('echo:hi2');
  });

  it('stops flushing the moment the channel is switched off', async () => {
    // 一个被关掉的通道不能再发任何东西。`flushHeld` 是一条会跨越多个 await 的循环，
    // 所以 `close()` 落在某一次发送中间时，剩下的必须停下——否则「已经关掉」只是对
    // 新消息成立，对正在补发的那批不成立。
    const delivered: string[] = [];
    let handler!: InboundHandler;
    let refusing = true;
    const reply: ReplySink = {
      reply: (_peerId, content) => {
        if (refusing) return Promise.resolve({ ok: false, reason: 'no passive window' });
        delivered.push(content);
        // 第一条补发成功的同时通道被关掉：第二条不能跟着出去。
        handler.close();
        return Promise.resolve({ ok: true });
      },
    };
    handler = new InboundHandler({ brain: (turn) => Promise.resolve({ text: `答案${turn.text}` }), reply, log: () => undefined });

    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', '一') });
    await settle();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '二') });
    await settle();
    expect(delivered).toEqual([]);

    // 窗口回来了：两条寄存的结论都能发了，但第一条发完通道就被关掉。
    refusing = false;
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m3', '三') });
    await settle();
    expect(handler.isClosed).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain('答案一');
  });

  it('does not hold an empty answer, and does not hold a command answer', async () => {
    const attempts: string[] = [];
    let failing = true;
    const reply: ReplySink = {
      reply: (_peerId, content) => {
        attempts.push(content);
        return failing ? Promise.resolve({ ok: false, reason: 'no passive window' }) : Promise.resolve({ ok: true });
      },
    };
    const handler = new InboundHandler({
      brain: (turn) => Promise.resolve({ text: turn.text === 'silent' ? '   ' : `echo:${turn.text}` }),
      reply,
      log: () => undefined,
      remote: { claim: (text) => text.startsWith('/'), handle: (text) => Promise.resolve(`remote:${text}`) },
    });

    // 空答复：`sendReply` 直接判为「无话可说」，连发送都不尝试，自然也不寄存。
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'silent') });
    await settle();
    expect(attempts).toEqual([]);

    // 遥控指令的答复同样不寄存：一条命令就能重新问一次，而寄存会让它在下一条消息时
    // 诈尸般地冒出来。
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', '/status') });
    await settle();
    expect(attempts).toEqual(['remote:/status']);

    // 窗口回来了，也没有任何东西等着补发——队列里是空的，下一条消息只会得到它自己的答复。
    failing = false;
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m3', 'hi') });
    await settle();
    expect(attempts).toEqual(['remote:/status', 'echo:hi']);
  });
});




