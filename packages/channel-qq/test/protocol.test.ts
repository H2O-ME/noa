import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccessTokenManager,
  chunkText,
  INTENT_GROUP_AND_C2C,
  OP,
  QqApi,
  QqGateway,
  type GatewaySocket,
} from '../src/protocol.js';
import { parseInbound } from '../src/types.js';

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

describe('AccessTokenManager', () => {
  it('fetches once and caches until the refresh margin, single-flighting concurrent gets', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      return jsonResponse(200, { access_token: `tok-${calls}`, expires_in: '7200' });
    });
    let now = 1_000_000;
    const token = new AccessTokenManager('app', 'secret', fetchFn, () => now);

    const [a, b, c] = await Promise.all([token.get(), token.get(), token.get()]);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(c).toBe('tok-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Well inside the lifetime → cached.
    now += 60_000;
    await expect(token.get()).resolves.toBe('tok-1');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Within the 120s refresh margin → new token.
    now += 7200_000 - 119_000;
    await expect(token.get()).resolves.toBe('tok-2');
  });

  it('invalidate() forces the next get() to refetch', async () => {
    let calls = 0;
    const token = new AccessTokenManager('app', 'secret', async () => {
      calls += 1;
      return jsonResponse(200, { access_token: `t${calls}`, expires_in: 7200 });
    });
    await token.get();
    token.invalidate();
    await expect(token.get()).resolves.toBe('t2');
  });
});

describe('chunkText', () => {
  it('splits overlong text into limit-sized chunks and keeps short text whole', () => {
    expect(chunkText('short')).toEqual(['short']);
    const chunks = chunkText('x'.repeat(11_000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4500);
    expect(chunks.at(-1)).toHaveLength(2000);
    expect(chunks.join('')).toHaveLength(11_000);
  });
});

describe('QqApi', () => {
  it('sends passive replies with incrementing msg_seq and chunks long content', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const token = new AccessTokenManager('app', 'secret', async () => jsonResponse(200, { access_token: 't', expires_in: 7200 }));
    const api = new QqApi(token, async (_url, init) => {
      bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return jsonResponse(200, { id: `msg-${bodies.length}` });
    });

    const sent = await api.sendGroupMessage('GROUP1', { content: 'a'.repeat(5000), msgId: 'inbound-1' });
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.seq)).toEqual([1, 2]);
    expect(bodies[0]!['msg_id']).toBe('inbound-1');
    expect(bodies[0]!['msg_seq']).toBe(1);
    expect(bodies[1]!['msg_seq']).toBe(2);
    expect((bodies[0]!['content'] as string).length).toBe(4500);
  });

  it('invalidates the token on 401 and surfaces the error', async () => {
    let tokenCalls = 0;
    const token = new AccessTokenManager('app', 'secret', async () => {
      tokenCalls += 1;
      return jsonResponse(200, { access_token: `t${tokenCalls}`, expires_in: 7200 });
    });
    let sends = 0;
    const api = new QqApi(token, async () => {
      sends += 1;
      return jsonResponse(401, { code: 401 });
    });
    await expect(api.sendC2CMessage('U1', { content: 'hi', msgId: 'm1' })).rejects.toThrow('send failed (401)');
    // Retrying fetches a fresh token.
    await expect(api.sendC2CMessage('U1', { content: 'hi', msgId: 'm1' })).rejects.toThrow('send failed (401)');
    expect(tokenCalls).toBe(2);
    expect(sends).toBe(2);
  });

  it('reads the bot\'s own username from /users/@me, caches it, and never invents one', async () => {
    // The settings page shows this as 「BOT 名称」, so the only two answers allowed
    // are the gateway's own username and an honest null — the page says 「取不到」
    // rather than printing something plausible.
    const urls: string[] = [];
    let username: unknown = 'nova 助手';
    const token = new AccessTokenManager('app', 'secret', async () => jsonResponse(200, { access_token: 't', expires_in: 7200 }));
    const api = new QqApi(token, async (url) => {
      urls.push(url);
      return jsonResponse(200, { id: '1024', username });
    });

    expect(await api.botName()).toBe('nova 助手');
    expect(urls).toEqual(['https://api.sgroup.qq.com/users/@me']);
    // Cached per appId: the page asks on every open, the gateway is asked once.
    expect(await api.botName()).toBe('nova 助手');
    expect(urls).toHaveLength(1);

    // An answer without a username is not a name.
    username = undefined;
    const other = new QqApi(token, async () => jsonResponse(200, { id: '1024' }));
    expect(await other.botName()).toBeNull();
  });
});

describe('parseInbound', () => {
  it('parses group and c2c messages into peers, ignoring other events', () => {
    const group = parseInbound('GROUP_AT_MESSAGE_CREATE', {
      id: 'ROBOT1.0_x',
      author: { member_openid: 'MEM', username: '小明' },
      content: ' 你好 ',
      group_openid: 'G1',
    });
    expect(group?.peer).toEqual({ kind: 'group', openid: 'G1', peerId: 'group:G1', actorId: 'MEM' });
    expect(group?.message.content).toBe(' 你好 ');

    const c2c = parseInbound('C2C_MESSAGE_CREATE', {
      id: 'ROBOT1.0_y',
      author: { user_openid: 'U1' },
      content: 'hi',
    });
    expect(c2c?.peer.peerId).toBe('c2c:U1');

    expect(parseInbound('FRIEND_ADD', {})).toBeUndefined();
    expect(parseInbound('GROUP_AT_MESSAGE_CREATE', { content: 'no id' })).toBeUndefined();
  });
});

// ------------------------------------------------------------- gateway FSM

/** 可编程假 socket：测试手动泵入帧、断开连接。 */
class FakeSocket implements GatewaySocket {
  sent: string[] = [];
  private messageCb: ((data: string) => void) | undefined;
  private closeCb: ((hadError: boolean) => void) | undefined;

  async open(): Promise<void> {
    /* factory resolves with the socket ready */
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCb?.(false);
  }

  emit(data: unknown): void {
    this.messageCb?.(JSON.stringify(data));
  }

  disconnect(): void {
    this.closeCb?.(false);
  }

  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.closeCb = cb;
  }
}

describe('QqGateway state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Flush connect()'s async chain (gateway URL + socket factory + registration). */
  const flush = (): Promise<void> => vi.advanceTimersByTimeAsync(1);

  function makeGateway(sockets: FakeSocket[], dispatches: { t: string; d: unknown }[]) {
    const token = new AccessTokenManager('app', 'secret', async () => jsonResponse(200, { access_token: 't', expires_in: 7200 }));
    return new QqGateway({
      appId: 'app',
      token,
      resolveGatewayUrl: async () => 'wss://gateway.test',
      socketFactory: async () => {
        const socket = sockets.shift();
        if (socket === undefined) throw new Error('no more fake sockets');
        return socket;
      },
      onDispatch: (event) => dispatches.push({ t: event.t, d: event.d }),
      onLog: () => undefined,
    });
  }

  it('identifies on hello (intents + token header format) and heartbeats with the latest seq', async () => {
    const socket = new FakeSocket();
    const dispatches: { t: string; d: unknown }[] = [];
    const gateway = makeGateway([socket], dispatches);
    void gateway.connect();
    await flush(); // socket registered

    socket.emit({ op: OP.HELLO, d: { heartbeat_interval: 45_000 } });
    await flush();

    const identify = JSON.parse(socket.sent[0]!) as { op: number; d: { token: string; intents: number } };
    expect(identify.op).toBe(OP.IDENTIFY);
    expect(identify.d.token).toBe('QQBot t');
    expect(identify.d.intents).toBe(INTENT_GROUP_AND_C2C);

    // Heartbeat carries the latest dispatch seq (null before any dispatch).
    await vi.advanceTimersByTimeAsync(45_000);
    expect(JSON.parse(socket.sent[1]!)).toEqual({ op: OP.HEARTBEAT, d: null });

    socket.emit({ op: OP.HEARTBEAT_ACK });
    socket.emit({ op: OP.DISPATCH, t: 'GROUP_AT_MESSAGE_CREATE', s: 42, d: { id: 'm1' } });
    expect(dispatches).toEqual([{ t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm1' } }]);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(JSON.parse(socket.sent[2]!)).toEqual({ op: OP.HEARTBEAT, d: 42 });
    gateway.close();
  });

  it('resumes with session_id + seq on reconnect, falls back to identify after op9', async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const third = new FakeSocket();
    const dispatches: { t: string; d: unknown }[] = [];
    const gateway = makeGateway([first, second, third], dispatches);
    void gateway.connect();
    await flush();

    first.emit({ op: OP.HELLO, d: { heartbeat_interval: 45_000 } });
    await flush();
    first.emit({ op: OP.DISPATCH, t: 'READY', s: 7, d: { session_id: 'sess-1' } });
    first.disconnect(); // drop the connection → auto reconnect with backoff
    await flush(); // close handler schedules the 1s backoff
    await vi.advanceTimersByTimeAsync(1_000);
    await flush(); // second socket registered

    // Second connection: hello arrives first, then the gateway resumes.
    second.emit({ op: OP.HELLO, d: { heartbeat_interval: 45_000 } });
    await flush();
    const resume = JSON.parse(second.sent[0]!) as { op: number; d: { session_id?: string; seq?: number } };
    expect(resume.op).toBe(OP.RESUME);
    expect(resume.d.session_id).toBe('sess-1');
    expect(resume.d.seq).toBe(7);

    // Server invalidates the session → next reconnect re-identifies.
    second.emit({ op: OP.INVALID_SESSION });
    second.disconnect();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    third.emit({ op: OP.HELLO, d: { heartbeat_interval: 45_000 } });
    await flush();
    const identify = JSON.parse(third.sent[0]!) as { op: number };
    expect(identify.op).toBe(OP.IDENTIFY);
    gateway.close();
  });
});

