/**
 * 入站处理与遥控旁路（`packages/qqbot/src/inbound.ts`）。
 *
 * 这个文件钉的是一条**死锁**：一轮对话是全局串行的（`queue`），而一轮可能停在审批上
 * 等对端回答。如果那句答复也要排队，它会永远排在自己所等的那一轮后面——整轮运行就此
 * 停死。所以遥控指令必须走队列**之外**的旁路。
 */
import { describe, expect, it } from 'vitest';
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
    brain: (text) => {
      brainCalls.push(text);
      return text === 'park' ? gate.then(() => 'parked-done') : Promise.resolve(`echo:${text}`);
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
    const counting = new InboundHandler({ brain: (text) => Promise.resolve(`echo:${text}`), reply, log: () => undefined });

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



