import { describe, expect, it, vi } from 'vitest';
import { QqOutbox } from '../src/outbox.js';
import { createQqBotChannel } from '../src/runtime.js';
import type { GatewaySocket } from '../src/protocol.js';

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

class FakeSocket implements GatewaySocket {
  sent: string[] = [];
  private messageCb: ((data: string) => void) | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(_cb: (hadError: boolean) => void): void {}

  emit(data: unknown): void {
    this.messageCb?.(JSON.stringify(data));
  }
}

/**
 * 装配一个完整通道：假 socket + 注入 fetch（token/gateway/send 全记录）。
 *
 * The reply sink is a real OUTBOX over the same transport, because the window rule
 * and the per-`msg_id` allowance are what this rig exists to exercise: a hand-rolled
 * sink here would pass while the shipped one refused.
 */
function makeChannel(
  brain: (text: string, peer: { peerId: string }) => Promise<string>,
  sends: Array<{ url: string; body: Record<string, unknown> }>,
): { channel: ReturnType<typeof createQqBotChannel>; socket: FakeSocket } {
  const socket = new FakeSocket();
  let channel: ReturnType<typeof createQqBotChannel>;
  const outbox = new QqOutbox({
    send: (peerId, content, msgId) => channel.send(peerId, content, msgId),
    lastMsgIdOf: (peerId) => channel.lastMsgIdOf(peerId),
  });
  channel = createQqBotChannel({
    appId: 'app',
    clientSecret: 'secret',
    brain,
    reply: { reply: (peerId, content) => outbox.reply(peerId, content) },
    fetchFn: async (url, init) => {
      if (String(url).includes('/getAppAccessToken')) {
        return jsonResponse(200, { access_token: 't', expires_in: 7200 });
      }
      if (String(url).includes('/gateway/bot')) {
        return jsonResponse(200, { url: 'wss://gateway.test' });
      }
      if (String(url).includes('/users/@me')) {
        // 机器人自己的身份：设置页的「BOT 名称」就是这一条的 username。
        sends.push({ url: String(url), body: {} });
        return jsonResponse(200, { id: 'bot1', username: 'nova 助手' });
      }
      sends.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
      return jsonResponse(200, { id: `out-${sends.length}` });
    },
    socketFactory: async () => socket,
    log: () => undefined,
  });
  return { channel, socket };
}

const HELLO = { op: 10, d: { heartbeat_interval: 45_000 } };

describe('createQqBotChannel', () => {
  it('routes an inbound group message through the brain and replies passively', async () => {
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    const brain = vi.fn(async (text: string) => `echo:${text}`);
    const { channel, socket } = makeChannel(brain, sends);
    await channel.start();
    socket.emit(HELLO);
    socket.emit({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      s: 1,
      id: 'ROBOT1.0_1',
      d: { id: 'IN1', author: { member_openid: 'MEM' }, content: '帮我查天气', group_openid: 'G1' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(brain).toHaveBeenCalledWith('帮我查天气', { kind: 'group', openid: 'G1', peerId: 'group:G1', actorId: 'MEM' });
    expect(sends).toHaveLength(1);
    expect(sends[0]!.url).toContain('/v2/groups/G1/messages');
    expect(sends[0]!.body['msg_id']).toBe('IN1');
    expect(sends[0]!.body['content']).toBe('echo:帮我查天气');
    channel.stop();
  });

  it('deduplicates repeated msg_id pushes and ignores non-message events', async () => {
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    const brain = vi.fn(async () => 'ok');
    const { channel, socket } = makeChannel(brain, sends);
    await channel.start();
    socket.emit(HELLO);
    for (const _ of [1, 2]) {
      socket.emit({
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        s: 1,
        d: { id: 'SAME', author: {}, content: 'hello', group_openid: 'G1' },
      });
    }
    socket.emit({ op: 0, t: 'FRIEND_ADD', d: {} });
    await new Promise((r) => setTimeout(r, 10));

    expect(brain).toHaveBeenCalledTimes(1);
    expect(sends).toHaveLength(1);
    channel.stop();
  });

  it('reports who the bot is and what this run has carried, without inventing either', async () => {
    const sends: Array<{ url: string; body: Record<string, unknown> }> = [];
    const { channel, socket } = makeChannel(async () => 'reply', sends);

    // Not started: nobody asked the gateway who this bot is, so there is no name
    // to show — and no request was made with credentials nobody is using yet.
    expect(await channel.reading()).toEqual({ received: 0, replied: 0 });

    await channel.start();
    socket.emit(HELLO);
    socket.emit({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      s: 1,
      d: { id: 'IN1', author: {}, content: 'hi', group_openid: 'G1' },
    });
    await new Promise((r) => setTimeout(r, 10));

    // The basis is THIS RUN: the counters live in the process and a restart
    // starts over, which is why the page must say 本次运行 rather than 共.
    expect(await channel.reading()).toMatchObject({ received: 1, replied: 1, botName: 'nova 助手' });
    // The name comes from the gateway and is cached: the page asks on every open.
    await channel.reading();
    expect(sends.filter((entry) => entry.url.endsWith('/users/@me'))).toHaveLength(1);
    channel.stop();
  });
});


