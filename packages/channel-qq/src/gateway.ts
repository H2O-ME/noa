/**
 * The QQ gateway: the long-lived WebSocket connection and its state machine.
 *
 * Split from `protocol.ts` because it answers a different question. That file
 * owns stateless request/response traffic (a token, one message); this one owns a
 * connection that lives for hours, reconnects on its own, and must be able to die
 * on command. Re-exported from `protocol.ts` so the package's public face is
 * unchanged.
 */
import { errMessage } from '@noa/core';
import type { AccessTokenManager, CredentialSource } from './token.js';

/** op codes（官方 event-emit 协议）。 */
export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** 群聊 + 单聊（C2C）事件 intent（1<<25 = 33554432）。 */
export const INTENT_GROUP_AND_C2C = 1 << 25;

export interface GatewayDispatch {
  /** 事件类型（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE / READY …）。 */
  t: string;
  d: unknown;
  /** 事件外层 id（可作发消息 event_id）。 */
  id?: string;
  /** 序列号（心跳与 resume 用）。 */
  s?: number;
}

export interface GatewaySocket {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (hadError: boolean) => void): void;
}

export type SocketFactory = (url: string) => Promise<GatewaySocket>;

/**
 * What the gateway is doing, as one closed set.
 *
 * `ready` is the ONLY state that means "events are arriving": it is entered when
 * the platform's own `READY`/`RESUMED` dispatch lands, not when a TCP socket
 * opened. Conflating the two is how a channel reported itself running while
 * nothing could be delivered — a dial that returned a socket but never got a
 * HELLO is `connecting`, not `ready`.
 */
export type QqGatewayState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface QqGatewayOptions {
  /** 与 `AccessTokenManager` 同源；网关本身只用 token，保留供调用方标注。 */
  appId: CredentialSource;
  token: AccessTokenManager;
  /** GET /gateway/bot 的替代（测试注入）。 */
  resolveGatewayUrl: () => Promise<string>;
  socketFactory: SocketFactory;
  onDispatch: (event: GatewayDispatch) => void;
  onReady?: (info: { sessionId: string; resumed: boolean }) => void;
  onLog?: (line: string) => void;
  /** State transitions, so a surface can report the truth instead of guessing. */
  onState?: (state: QqGatewayState) => void;
  /** 重连退避上限（默认 30s）。 */
  maxBackoffMs?: number;
}

/**
 * WebSocket 网关状态机。生命周期：connect() 后自动 Hello→Identify→心跳→
 * 分发；断线（close/心跳超时/op7/op9）自动重连——先尝试 Resume（op6 携带
 * session_id + 最后序列号），失效（op9）后退回重新 Identify。
 *
 * EVERY asynchronous step is guarded by a CONNECTION GENERATION. A dial is two
 * awaited steps (resolve the gateway URL, then open the socket) plus a third
 * (fetch a token before identifying), and `close()` can land in any of those
 * gaps. Without a generation, a dial that was abandoned still installed its
 * socket — so switching the plugin row off could leave a live connection, and an
 * older socket's late `close`/HELLO could tear down or reconfigure the CURRENT
 * connection. `close()` therefore bumps the generation, and every continuation
 * compares itself against it before touching state: a stale one does nothing but
 * close what it was holding.
 */
export class QqGateway {
  private socket: GatewaySocket | undefined;
  private sessionId: string | undefined;
  private lastSeq: number | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private ackDeadline: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wakes the reconnect wait on `close()`, so no dial chain outlives the gateway. */
  private reconnectWake: (() => void) | undefined;
  private backoffMs = 1_000;
  private disposed = false;
  /** Bumped by every connect and by close; see the class comment. */
  private generation = 0;
  private state: QqGatewayState = 'idle';

  constructor(private readonly opts: QqGatewayOptions) {}

  /** The state in force: `ready` means READY/RESUMED was seen, not that a socket opened. */
  get currentState(): QqGatewayState {
    return this.state;
  }

  /** True once `close()` ran: the gateway is terminal and will not dial again. */
  get closed(): boolean {
    return this.disposed;
  }

  /**
   * Dial once. A no-op after `close()` — the gateway is terminal, and a
   * re-enabled channel builds a NEW one (see `QqBotChannel`).
   * @throws when the gateway URL or the socket cannot be obtained.
   */
  async connect(): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;
    this.setState('connecting');
    const url = await this.opts.resolveGatewayUrl();
    // `close()` (or a newer connect) may have happened while the URL was in
    // flight. Nothing below may run for an abandoned dial.
    if (!this.isCurrent(gen)) return;
    const socket = await this.opts.socketFactory(url);
    if (!this.isCurrent(gen)) {
      // The dial lost the race: hand the socket back instead of adopting it, or a
      // switched-off channel keeps a live connection nobody will ever close.
      socket.close();
      return;
    }
    this.socket = socket;
    // Every callback is bound to THIS generation, so an older socket's late frame
    // or close cannot reach the current connection's state.
    socket.onMessage((data) => {
      if (this.isCurrent(gen)) this.onFrame(data, gen);
    });
    socket.onClose(() => {
      if (!this.isCurrent(gen)) return;
      // A connection closes ONCE for this gateway. `op7`/`op9` and a real socket
      // drop both surface as `close`, and a server that sends op9 and then drops
      // the socket fires this twice — which used to start two reconnect chains,
      // each dialing, so the loser's socket was adopted by nobody and the backoff
      // counter advanced twice. Detaching the socket here makes the second event a
      // no-op instead.
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.stopTimers();
      void this.scheduleReconnect('connection closed');
    });
  }

  /**
   * Close for good.
   *
   * Terminal on purpose: the generation is bumped so every in-flight dial and
   * every callback of the connection being abandoned becomes a no-op, the
   * reconnect wait is woken instead of left pending, and all timers are cleared.
   * Re-enabling the channel builds a new gateway rather than restarting this one
   * — a restarted gateway would have to tell "resumed after a transient drop"
   * apart from "reopened after an operator switched me off", and getting that
   * wrong is how a closed channel comes back to life.
   */
  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.stopTimers();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const wake = this.reconnectWake;
    this.reconnectWake = undefined;
    wake?.();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.setState('closed');
  }

  private isCurrent(gen: number): boolean {
    return !this.disposed && gen === this.generation;
  }

  private setState(state: QqGatewayState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state);
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  /**
   * One inbound frame.
   *
   * `raw` is untrusted: the platform (or anything between it and us) may send
   * anything, including valid JSON that is not an object. A parse or shape
   * failure logs and drops the frame — it must never throw out of a socket
   * listener, because an exception there kills the process rather than the
   * connection.
   * @param raw - the frame text.
   * @param gen - the connection this frame arrived on.
   */
  private onFrame(raw: string, gen: number): void {
    const frame = parseFrame(raw);
    if (frame === undefined) {
      this.log(`dropping unusable frame (${raw.length} bytes)`);
      return;
    }
    const op = frame.op;
    if (op === OP.DISPATCH) {
      if (typeof frame.s === 'number') this.lastSeq = frame.s;
      const t = frame.t ?? '';
      if (t === 'READY') {
        if (typeof frame.d?.['session_id'] === 'string') this.sessionId = frame.d['session_id'];
        this.backoffMs = 1_000;
        this.setState('ready');
        this.opts.onReady?.({ sessionId: this.sessionId ?? '', resumed: false });
      } else if (t === 'RESUMED') {
        this.backoffMs = 1_000;
        this.setState('ready');
        this.opts.onReady?.({ sessionId: this.sessionId ?? '', resumed: true });
      }
      this.opts.onDispatch({
        t,
        d: frame.d,
        ...(frame.id !== undefined ? { id: frame.id } : {}),
        ...(frame.s !== undefined ? { s: frame.s } : {}),
      });
      return;
    }
    if (op === OP.HELLO) {
      const interval = frame.d?.['heartbeat_interval'];
      const ms = typeof interval === 'number' && interval > 0 ? interval : 45_000;
      const resume = this.sessionId !== undefined && this.lastSeq !== undefined;
      // Caught: a token failure or a throwing `send` here used to become an
      // unhandled rejection (Node's default for that is process exit), and left
      // the socket open with no heartbeat — a channel that looks connected and is
      // deaf. Dropping the socket hands the problem to the reconnect path, which
      // is the machinery that exists for it.
      void this.resumeOrIdentify(resume, ms, gen).catch((err: unknown) => {
        if (!this.isCurrent(gen)) return;
        this.log(`identify failed: ${errMessage(err)}`);
        this.socket?.close();
      });
      return;
    }
    if (op === OP.HEARTBEAT_ACK) {
      if (this.ackDeadline !== undefined) clearTimeout(this.ackDeadline);
      this.ackDeadline = undefined;
      return;
    }
    if (op === OP.RECONNECT) {
      // 服务端要求重连：直接断开，onClose 里的重连逻辑接管。
      this.socket?.close();
      return;
    }
    if (op === OP.INVALID_SESSION) {
      // 会话失效：丢弃 resume 凭据，重连后重新 Identify。
      this.sessionId = undefined;
      this.lastSeq = undefined;
      this.socket?.close();
    }
  }

  private async resumeOrIdentify(resume: boolean, heartbeatMs: number, gen: number): Promise<void> {
    const token = await this.opts.token.get();
    // The token fetch is a network round trip; `close()` can land inside it, and
    // starting a heartbeat afterwards would resurrect a closed gateway's timers.
    if (!this.isCurrent(gen)) return;
    const payload = resume
      ? { op: OP.RESUME, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq } }
      : {
          op: OP.IDENTIFY,
          d: {
            token: `QQBot ${token}`,
            intents: INTENT_GROUP_AND_C2C,
            shard: [0, 1],
            properties: { $os: process.platform, $browser: 'noa', $device: 'noa' },
          },
        };
    this.socket?.send(JSON.stringify(payload));
    if (!this.isCurrent(gen)) return;
    this.startHeartbeat(heartbeatMs, gen);
    this.log(resume ? 'gateway resumed' : 'gateway identified');
  }

  private startHeartbeat(intervalMs: number, gen: number): void {
    this.stopTimers();
    const beat = (): void => {
      if (!this.isCurrent(gen)) return;
      this.socket?.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.lastSeq ?? null }));
      // 一个心跳周期内没收到 op11 就判定连接僵死，主动断开触发重连。
      this.ackDeadline = setTimeout(() => {
        if (!this.isCurrent(gen)) return;
        this.log('heartbeat ack timeout — reconnecting');
        this.socket?.close();
      }, intervalMs);
      this.heartbeatTimer = setTimeout(beat, intervalMs);
    };
    this.heartbeatTimer = setTimeout(beat, intervalMs);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer !== undefined) clearTimeout(this.heartbeatTimer);
    if (this.ackDeadline !== undefined) clearTimeout(this.ackDeadline);
    this.heartbeatTimer = undefined;
    this.ackDeadline = undefined;
  }

  private async scheduleReconnect(reason: string): Promise<void> {
    if (this.disposed) return;
    this.setState('reconnecting');
    this.log(`reconnecting in ${this.backoffMs}ms (${reason})`);
    await new Promise<void>((resolve) => {
      this.reconnectWake = resolve;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectWake = undefined;
        this.reconnectTimer = undefined;
        resolve();
      }, this.backoffMs);
    });
    // Woken by `close()`: the gateway is terminal, so the chain ends here rather
    // than redialing something the operator switched off.
    if (this.disposed) return;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
    await this.connect().catch((err: unknown) => {
      if (this.disposed) return;
      this.log(`reconnect failed: ${errMessage(err)}`);
      void this.scheduleReconnect('reconnect attempt failed');
    });
  }
}

interface ParsedFrame {
  op: number;
  d?: Record<string, unknown>;
  t?: string;
  s?: number;
  id?: string;
}

/**
 * Parse one gateway frame without trusting anything about it.
 *
 * `JSON.parse('null')` and `JSON.parse('[]')` both SUCCEED, so a parse-only check
 * let a scalar or array frame reach `frame.op` and throw a TypeError out of a
 * socket listener — which takes the process down, not the connection. The object
 * check is therefore part of the parse, not a separate caller concern.
 * @param raw - the frame text.
 * @returns the usable fields, or undefined when the frame is unusable.
 */
export function parseFrame(raw: string): ParsedFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  const op = frame['op'];
  if (typeof op !== 'number') return undefined;
  const d = frame['d'];
  const data = typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
  return {
    op,
    ...(data !== undefined ? { d: data } : {}),
    ...(typeof frame['t'] === 'string' ? { t: frame['t'] } : {}),
    ...(typeof frame['s'] === 'number' ? { s: frame['s'] } : {}),
    ...(typeof frame['id'] === 'string' ? { id: frame['id'] } : {}),
  };
}
