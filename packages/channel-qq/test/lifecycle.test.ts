/**
 * Channel and gateway LIFECYCLE, against fake sockets and a fake clock.
 *
 * These pin the failure modes that sharing one socket between "who is dialing"
 * and "who is still alive" produces. Every one of them is silent in production:
 * a switched-off channel keeps a live connection (or a live queue), an abandoned
 * dial adopts a socket nobody will close, a token error kills the process through
 * an unhandled rejection, or a stopped channel answers one more message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InboundHandler } from '../src/inbound.js';
import type { ReplySink } from '../src/reply.js';
import { AccessTokenManager } from '../src/token.js';
import { QqGateway, type GatewaySocket } from '../src/gateway.js';
import { createQqBotChannel } from '../src/runtime.js';

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

/** A socket whose callbacks are driven by hand, so a race can be staged. */
class FakeSocket implements GatewaySocket {
  sent: string[] = [];
  closed = 0;
  private messageCb: ((data: string) => void) | undefined;
  private closeCb: ((hadError: boolean) => void) | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed += 1;
    this.closeCb?.(false);
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.closeCb = cb;
  }

  emit(data: unknown): void {
    this.messageCb?.(JSON.stringify(data));
  }

  /** A raw frame, for the "valid JSON but not an object" cases. */
  emitRaw(raw: string): void {
    this.messageCb?.(raw);
  }

  /** The server dropped us, without `close()` having been called. */
  drop(): void {
    this.closeCb?.(false);
  }
}

const HELLO = { op: 10, d: { heartbeat_interval: 45_000 } };
const READY = { op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1' } };

function token(): AccessTokenManager {
  return new AccessTokenManager('app', 'secret', async () => jsonResponse(200, { access_token: 't', expires_in: 7200 }));
}

describe('QqGateway lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(1);

  it('does not adopt a socket whose dial finished after close()', async () => {
    // The worst shape of the bug: switching the plugin row off during a slow dial
    // left the connection alive, so the channel was "off" and still receiving.
    const socket = new FakeSocket();
    let releaseSocket: (() => void) | undefined;
    const gateway = new QqGateway({
      appId: 'app',
      token: token(),
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => {
        await new Promise<void>((resolve) => { releaseSocket = resolve; });
        return socket;
      },
      onDispatch: () => undefined,
      onLog: () => undefined,
    });

    const dial = gateway.connect();
    await flush();
    gateway.close();
    releaseSocket?.();
    await dial;

    // The late socket must be handed BACK, not registered: it is the difference
    // between a closed channel and a leaked connection.
    expect(socket.closed).toBeGreaterThan(0);
    socket.emit(HELLO);
    expect(socket.sent).toEqual([]);
    expect(gateway.currentState).toBe('closed');
  });

  it('ignores frames and closes arriving from a superseded connection', async () => {
    // Only one connection may hold the gateway's state. An older socket's late
    // close used to stop the CURRENT connection's heartbeat and dial again.
    const first = new FakeSocket();
    const second = new FakeSocket();
    const queues: FakeSocket[][] = [[first], [second]];
    const gateway = new QqGateway({
      appId: 'app',
      token: token(),
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => queues.shift()?.shift() as FakeSocket,
      onDispatch: () => undefined,
      onLog: () => undefined,
    });

    await gateway.connect();
    await flush();
    first.emit(HELLO);
    await flush();
    expect(JSON.parse(first.sent[0]!)).toMatchObject({ op: 2 });

    // Dial again: the first connection is superseded.
    await gateway.connect();
    await flush();
    second.emit(HELLO);
    await flush();
    const secondSends = second.sent.length;

    // The abandoned connection now wakes up and misbehaves. Neither its frames nor
    // its close may reach the live connection.
    first.emit(HELLO);
    first.drop();
    await flush();
    expect(second.sent).toHaveLength(secondSends);
    expect(gateway.currentState).not.toBe('reconnecting');

    gateway.close();
  });

  it('closes a connection only once, so op9 followed by a drop dials once', async () => {
    // `op9` (invalidate) closes the socket and the platform commonly drops it in
    // the same breath. Two close events used to mean two reconnect chains.
    const first = new FakeSocket();
    const second = new FakeSocket();
    let dials = 0;
    const gateway = new QqGateway({
      appId: 'app',
      token: token(),
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => {
        dials += 1;
        if (dials === 1) return first;
        if (dials === 2) return second;
        throw new Error('no more sockets');
      },
      onDispatch: () => undefined,
      onLog: () => undefined,
    });

    await gateway.connect();
    await flush();
    first.emit(HELLO);
    await flush();
    first.emit({ op: 0, t: 'READY', s: 1, d: { session_id: 's' } });
    first.emit({ op: 9 });
    first.drop();
    await vi.advanceTimersByTimeAsync(1_100);
    await flush();
    expect(dials).toBe(2);
    gateway.close();
  });

  it('survives a token failure during identify instead of rejecting unhandled', async () => {
    // `void this.resumeOrIdentify(...)` with no catch meant a token error became an
    // unhandled rejection — Node's default for that is process exit — and left the
    // socket open with no heartbeat. The dial itself needs no token here (both the
    // URL and the socket are injected), so the identify is the first caller.
    const socket = new FakeSocket();
    const failing = new AccessTokenManager('app', 'secret', async () => {
      throw new Error('token endpoint down');
    });
    const gateway = new QqGateway({
      appId: 'app',
      token: failing,
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => socket,
      onDispatch: () => undefined,
      onLog: () => undefined,
    });

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      await gateway.connect();
      await flush();
      socket.emit(HELLO);
      await flush();
      // The failure drops the socket, which is the reconnect path's job.
      expect(socket.closed).toBeGreaterThan(0);
      expect(rejections).toEqual([]);
      // Not claimed as identified: no heartbeat was started for a dead handshake.
      expect(socket.sent).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      gateway.close();
    }
  });

  it('drops an unusable frame instead of throwing out of the socket listener', async () => {
    const socket = new FakeSocket();
    const dispatched: string[] = [];
    const gateway = new QqGateway({
      appId: 'app',
      token: token(),
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => socket,
      onDispatch: (event) => dispatched.push(event.t),
      onLog: () => undefined,
    });
    await gateway.connect();
    await flush();
    // All of these are VALID JSON; the first three are not objects at all.
    for (const raw of ['null', '[]', '"text"', '42', '{}', 'not json at all']) {
      expect(() => socket.emitRaw(raw)).not.toThrow();
    }
    socket.emitRaw(JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {} }));
    expect(dispatched).toEqual(['GROUP_AT_MESSAGE_CREATE']);
    gateway.close();
  });

  it('refuses to dial again after close()', async () => {
    const gateway = new QqGateway({
      appId: 'app',
      token: token(),
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => new FakeSocket(),
      onDispatch: () => undefined,
      onLog: () => undefined,
    });
    gateway.close();
    await gateway.connect();
    // Terminal: `idle` would mean "never dialed", which is how a restart looked
    // like a successful reconnect that had no connection behind it.
    expect(gateway.currentState).toBe('closed');
  });
});

describe('InboundHandler shutdown', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  function rig(): {
    handler: InboundHandler;
    replies: string[];
    brainCalls: string[];
    release: () => void;
  } {
    const replies: string[] = [];
    const brainCalls: string[] = [];
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const reply: ReplySink = {
      reply: (_peerId, content) => { replies.push(content); return Promise.resolve({ ok: true }); },
    };
    const handler = new InboundHandler({
      brain: (text) => {
        brainCalls.push(text);
        return text === 'park' ? gate.then(() => 'parked-done') : Promise.resolve(`echo:${text}`);
      },
      reply,
      log: () => undefined,
    });
    return { handler, replies, brainCalls, release: open };
  }

  const groupMessage = (id: string, content: string): unknown => ({
    id,
    group_openid: 'g1',
    author: { member_openid: 'u1' },
    content,
  });

  it('does not start a queued turn or send after close()', async () => {
    // The real defect: switching the row off left the serial queue draining, so a
    // message that arrived before the switch still started a WHOLE turn — and the
    // channel that was supposed to be gone answered it.
    const { handler, replies, brainCalls, release } = rig();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'park') });
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', 'second') });
    await settle();
    expect(brainCalls).toEqual(['park']);

    handler.close();
    release();
    await settle();

    expect(brainCalls).toEqual(['park']);
    expect(replies).toEqual([]);
  });

  it('refuses new dispatches and hands back no passive window once closed', async () => {
    const { handler, replies, brainCalls } = rig();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', 'hi') });
    await settle();
    expect(handler.msgIdOf('group:g1')).toBe('m1');

    handler.close();
    // The window is the credential to send on this channel's behalf; a stopped
    // channel must not hand one out.
    expect(handler.msgIdOf('group:g1')).toBeUndefined();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m2', 'more') });
    await settle();
    expect(brainCalls).toEqual(['hi']);
    expect(replies).toEqual(['echo:hi']);
    expect(handler.stats().received).toBe(1);
  });

  it('drops a remote command answer that arrives after close()', async () => {
    // The bypass deliberately runs OUTSIDE the serial queue, so it is the one path
    // that can still be in flight when the row is switched off.
    const replies: string[] = [];
    let releaseRemote: (() => void) | undefined;
    const reply: ReplySink = {
      reply: (_peerId, content) => { replies.push(content); return Promise.resolve({ ok: true }); },
    };
    const handler = new InboundHandler({
      brain: () => Promise.resolve('never'),
      reply,
      log: () => undefined,
      remote: {
        claim: (text) => text.startsWith('/'),
        handle: async () => {
          await new Promise<void>((resolve) => { releaseRemote = resolve; });
          return 'late answer';
        },
      },
    });

    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: groupMessage('m1', '/status') });
    await settle();
    handler.close();
    releaseRemote?.();
    await settle();
    expect(replies).toEqual([]);
  });
});

describe('QqBotChannel lifecycle', () => {
  function makeChannel(socket: FakeSocket) {
    return createQqBotChannel({
      appId: 'app',
      clientSecret: 'secret',
      brain: () => Promise.resolve('reply'),
      fetchFn: async (url) => {
        if (String(url).includes('/getAppAccessToken')) return jsonResponse(200, { access_token: 't', expires_in: 7200 });
        if (String(url).includes('/gateway/bot')) return jsonResponse(200, { url: 'wss://gateway.test' });
        return jsonResponse(200, { id: 'out-1' });
      },
      socketFactory: async () => socket,
      log: () => undefined,
    });
  }

  it('reports running only once the platform said READY', async () => {
    const socket = new FakeSocket();
    const channel = makeChannel(socket);
    expect(channel.running).toBe(false);
    expect(channel.state).toBe('idle');

    await channel.start();
    // A socket exists but nothing has been accepted yet: reporting `running` here
    // is how a deaf channel looked healthy.
    expect(channel.running).toBe(false);
    expect(channel.state).toBe('connecting');

    socket.emit(HELLO);
    await new Promise((r) => setTimeout(r, 0));
    expect(channel.running).toBe(false);

    socket.emit(READY);
    expect(channel.running).toBe(true);
    expect(channel.state).toBe('ready');
    channel.stop();
  });

  it('makes stop() terminal instead of reporting a restart that has no socket', async () => {
    const socket = new FakeSocket();
    const channel = makeChannel(socket);
    await channel.start();
    socket.emit(HELLO);
    await new Promise((r) => setTimeout(r, 0));
    socket.emit(READY);
    expect(channel.running).toBe(true);

    channel.stop();
    expect(channel.running).toBe(false);
    expect(channel.state).toBe('closed');
    // The old `start()` set `started = true` and returned silently while the
    // gateway stayed disposed — a channel claiming to run with no connection.
    await expect(channel.start()).rejects.toThrow(/stopped and cannot be restarted/);
  });

  it('bounds a send whose response carries no message id', async () => {
    const socket = new FakeSocket();
    const channel = createQqBotChannel({
      appId: 'app',
      clientSecret: 'secret',
      brain: () => Promise.resolve('reply'),
      fetchFn: async (url) => {
        if (String(url).includes('/getAppAccessToken')) return jsonResponse(200, { access_token: 't', expires_in: 7200 });
        if (String(url).includes('/gateway/bot')) return jsonResponse(200, { url: 'wss://gateway.test' });
        // A 2xx with no id is not a delivered message.
        return jsonResponse(200, {});
      },
      socketFactory: async () => socket,
      log: () => undefined,
    });
    socket.emit(HELLO);
    await expect(channel.send('group:G1', 'hello', 'IN1')).rejects.toThrow(/no message id/);
    channel.stop();
  });

  it('refuses a chunk limit that would spin forever', async () => {
    const { chunkText } = await import('../src/protocol.js');
    expect(() => chunkText('x', 0)).toThrow(/positive integer/);
    expect(() => chunkText('x', -5)).toThrow(/positive integer/);
    expect(chunkText('abc', 2)).toEqual(['ab', 'c']);
  });
});


