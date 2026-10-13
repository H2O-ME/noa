import { AccessTokenManager, QqApi, QqGateway, type CredentialSource, type FetchLike, type QqGatewayState, type RichSend, type SocketFactory } from './protocol.js';
import { InboundHandler, type InboundHandlerOptions } from './inbound.js';
import type { RemoteAnswer } from './peers.js';
import type { ReplySink } from './reply.js';
import { defaultSocketFactory } from './socket.js';
import { withDeadline } from './deadline.js';
import type { Peer, QqBotChannelStats } from './types.js';

/**
 * 把协议层装配成一个完整通道：WebSocket 事件 →（去重、被动窗口缓存）→
 * brain（agent 侧回调，运行方提供）→ REST 被动回复。
 *
 * 通道**不认识宿主**：它不是插件、也不注册任何工具。谁把它装起来、回复怎么落地，
 * 都是插件那一半的事（`plugin.ts`）；这里只管一条 WebSocket 通道的
 * 装配与启停，另外把「被动窗口里的最近一条 msg_id」与「BOT 是谁」这两件读数交出去。
 */

export interface QqBotChannelOptions {
  /**
   * Credentials, as a literal or a getter.
   *
   * The getter form is what makes this channel usable from a surface that lets
   * the operator EDIT the credentials while the process runs (`nova --web`'s
   * settings page). The plugin object has to stay stable — it already sits in
   * the roster's candidate list, and rebuilding it would change roster identity —
   * so the credentials are read at request time instead of captured here.
   */
  appId: CredentialSource;
  clientSecret: CredentialSource;
  /** 收到一条群/单聊消息，返回回复文本（运行方的 agent 大脑）。 */
  brain: (text: string, peer: Peer) => Promise<RemoteAnswer>;
  fetchFn?: FetchLike;
  socketFactory?: SocketFactory;
  /** 默认 GET https://api.sgroup.qq.com/gateway/bot 取 wss 地址。 */
  gatewayUrl?: () => Promise<string>;
  log?: (line: string) => void;
  /**
   * Where replies go. The caller owns this because the passive-window rule and the
   * per-`msg_id` allowance must be shared with every other outbound path (see
   * `outbox.ts`); a transport that built its own sink here would be a second copy
   * of that ledger.
   */
  reply: ReplySink;
  /**
   * 入站旁路：见 `InboundHandlerOptions.remote`。
   *
   * 存在的理由是**死锁**：一轮对话是串行的，而一轮可能停在审批上等人回答；如果那句
   * 答复也要排队，它会永远排在自己所等的那一轮后面。所以遥控指令不进队列。
   */
  remote?: InboundHandlerOptions['remote'];
  /** 新消息打断在跑的那一轮：见 `InboundHandlerOptions.interrupt`。 */
  interrupt?: InboundHandlerOptions['interrupt'];
}

export interface QqBotChannel {
  api: QqApi;
  start(): Promise<void>;
  /**
   * Shut the channel down. TERMINAL: this instance will not dial again, because a
   * re-enabled row builds a NEW channel (see `start`).
   */
  stop(): void;
  /**
   * Whether the platform has actually accepted this connection — i.e. `READY` or
   * `RESUMED` was seen. NOT "a socket opened": a dial that returned a socket and
   * never got a HELLO cannot deliver anything, and reporting it as running is how
   * a channel looked healthy while being deaf.
   */
  readonly running: boolean;
  /** The full state, for a settings page that wants to distinguish connecting from failed. */
  readonly state: QqGatewayState;
  /**
   * 设置页的连接读数：BOT 名称 + 本次运行的计数。异步是因为名称要真的去问一次网关
   * （`GET /users/@me`）；通道没拨过号时**不问**——那会拿一份没人用的凭据去换 token。
   */
  reading(): Promise<QqBotChannelReading>;
  /**
   * 主动往一个对端发一条。
   *
   * `msgId` 是**被动回复窗口**的凭据：平台的主动外发受严格限流，所以真正的落点是
   * 「回复最近一条入站消息」，而窗口的判定只有通道知道（`lastMsgIdOf`）。缺省即不等
   * 窗口的裸发——那多半会被平台拒，工具因此总是先取窗口再传进来。
   * @param peerId - `group:<id>` / `c2c:<id>`。
   * @param content - 文本。
   * @param msgId - 被动回复的 msg_id（缺省 = 不带窗口）。
   * @returns 每片消息的平台 id（撤回要用；媒体/分片各占一位）。
   */
  send(peerId: string, content: string, msgId?: string, rich?: RichSend): Promise<string[]>;
  /** 该对端被动回复窗口里的最近 msg_id（过期、或通道已停即 undefined）。 */
  lastMsgIdOf(peerId: string): string | undefined;
  /** 回应一次按钮互动（`PUT /interactions/{id}`）：3 秒内，一次性。 */
  interact(interactionId: string): Promise<void>;
  /**
   * 单聊流式消息的一片（`POST /v2/users/{openid}/stream_messages`）：nova 只服务
   * 私聊，群聊没有对应接口。首片 `streamMsgId` 缺省，由服务端在响应 `id` 里发回；
   * 调用方（`ReplyStreamer`）负责节流与收口。
   * @returns 服务端回的 `stream_msg_id`（首片才有意义）。
   */
  stream(peerId: string, text: string, state: 1 | 10, index: number, streamMsgId?: string): Promise<string | undefined>;
  /**
   * 撤回一条自己发的单聊消息（平台时限 2 分钟）：尽力而为，失败静默——撤回
   * 永远只是清扫，绝不能反过来打扰投递。
   */
  recall(peerId: string, messageId: string): Promise<void>;
}

/** 设置页要的那一份连接读数（`QqBotChannel.reading`）：计数口径是**本次运行**。 */
export interface QqBotChannelReading extends QqBotChannelStats {
  /** 网关报出的 BOT 用户名；undefined = 通道没跑（没问过），null = 问过但取不到。 */
  botName?: string | null;
}

export function createQqBotChannel(options: QqBotChannelOptions): QqBotChannel {
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
  const log = options.log ?? (() => undefined);
  const token = new AccessTokenManager(options.appId, options.clientSecret, fetchFn);
  const api = new QqApi(token, fetchFn, 'https://api.sgroup.qq.com', log);

  const resolveGatewayUrl =
    options.gatewayUrl ??
    (async (): Promise<string> => {
      const accessToken = await token.get();
      const body = await withDeadline(async (signal) => {
        const res = await fetchFn('https://api.sgroup.qq.com/gateway/bot', {
          headers: { Authorization: `QQBot ${accessToken}` },
          signal,
        });
        // Inside the deadline, and without assuming JSON: a 200 with a non-JSON
        // body used to throw a parse error that read as a network failure.
        const parsed = (await res.json().catch(() => undefined)) as { url?: unknown } | undefined;
        return { status: res.status, ok: res.ok, parsed };
      }, 'gateway lookup');
      if (!body.ok || typeof body.parsed?.url !== 'string') {
        throw new Error(`qqbot: gateway lookup failed (${body.status})`);
      }
      return body.parsed.url;
    });

  const inbound = new InboundHandler({
    brain: options.brain,
    // The caller supplies the outbound seam, because the window rule and the
    // per-message allowance are shared with every other outbound path.
    reply: options.reply,
    log,
    ...(options.remote !== undefined ? { remote: options.remote } : {}),
    interact: (interactionId) => api.respondInteraction(interactionId),
    ...(options.interrupt !== undefined ? { interrupt: options.interrupt } : {}),
  });

  const send = async (peerId: string, content: string, msgId?: string, rich?: RichSend): Promise<string[]> => {
    const [kind, openid] = [peerId.slice(0, peerId.indexOf(':')), peerId.slice(peerId.indexOf(':') + 1)];
    // 媒体在上传后发送：`file_info` 与场景绑定（单/群两套接口），所以换算必须在
    // 知道对端类型的这一层做，而不是更上面。
    if (rich?.file !== undefined) {
      const fileInfo = await api.uploadMedia(kind === 'group' ? 'group' : 'c2c', openid, {
        fileType: rich.file.fileType,
        url: rich.file.url,
      });
      const richSent =
        kind === 'group'
          ? await api.sendGroupMessage(openid, { content, ...(msgId !== undefined ? { msgId } : {}), rich: { fileInfo } })
          : await api.sendC2CMessage(openid, { content, ...(msgId !== undefined ? { msgId } : {}), rich: { fileInfo } });
      return richSent.map((m) => m.id);
    }
    // 本地文件（agent 产出的截图等）：分片上传换 file_info 再发，单聊专用。
    if (rich?.localFile !== undefined) {
      const fileInfo = await api.uploadLocalC2C(openid, { fileType: rich.localFile.fileType, path: rich.localFile.path });
      const sent = await api.sendC2CMessage(openid, {
        content,
        ...(msgId !== undefined ? { msgId } : {}),
        rich: { fileInfo },
      });
      return sent.map((m) => m.id);
    }
    const sent =
      kind === 'group'
        ? await api.sendGroupMessage(openid, { content, ...(msgId !== undefined ? { msgId } : {}), ...(rich !== undefined ? { rich } : {}) })
        : await api.sendC2CMessage(openid, { content, ...(msgId !== undefined ? { msgId } : {}), ...(rich !== undefined ? { rich } : {}) });
    return sent.map((m) => m.id);
  };

  // 流式一片：nova 只服务私聊，群聊没有对应接口（群聊对话在装配层就不该出现）。
  const stream = async (peerId: string, text: string, state: 1 | 10, index: number, streamMsgId?: string): Promise<string | undefined> => {
    const [kind, openid] = [peerId.slice(0, peerId.indexOf(':')), peerId.slice(peerId.indexOf(':') + 1)];
    if (kind !== 'c2c') throw new Error(`qqbot: streaming is c2c-only (got peer "${kind}:…")`);
    const msgId = inbound.msgIdOf(peerId);
    const res = await api.sendStreamC2C(openid, {
      text,
      mode: 'replace',
      state,
      index,
      // markdown：流式卡片就是正式回复的那张脸，纯 text 会把富文本原样吐字。
      contentType: 'markdown',
      ...(streamMsgId !== undefined ? { streamMsgId } : {}),
      ...(msgId !== undefined ? { msgId } : {}),
      msgSeq: api.drawSeq(msgId ?? `stream-${peerId}`),
    });
    return res.streamMsgId;
  };

  const recall = async (peerId: string, messageId: string): Promise<void> => {
    const [kind, openid] = [peerId.slice(0, peerId.indexOf(':')), peerId.slice(peerId.indexOf(':') + 1)];
    if (kind !== 'c2c') return;
    await api.deleteC2CMessage(openid, messageId);
  };

  const interact = async (interactionId: string): Promise<void> => {
    await api.respondInteraction(interactionId);
  };

  const gateway = new QqGateway({
    appId: options.appId,
    token,
    resolveGatewayUrl,
    socketFactory: options.socketFactory ?? defaultSocketFactory,
    onDispatch: inbound.onDispatch,
    onLog: log,
  });

  // 幂等：设置页每保存一次凭据就会要求启动一次，而网关每次 `connect()` 都会新开一条
  // WebSocket。没有这道闸门，重复保存会叠出多条并行连接，同一条消息被投递多次。
  let started = false;
  /** Terminal latch: `stop()` ends this instance for good (see `start`). */
  let stopped = false;

  return {
    api,
    send,
    stream,
    recall,
    lastMsgIdOf: (peerId) => inbound.msgIdOf(peerId),
    interact,
    reading: async () => ({ ...inbound.stats(), ...(started ? { botName: await api.botName() } : {}) }),
    start: async () => {
      // The gateway is terminal by design, so a "restart" here would report a
      // running channel with no connection. Refusing is the honest answer; the
      // plugin builds a NEW channel when its row is switched back on.
      if (stopped) {
        throw new Error('qqbot: this channel was stopped and cannot be restarted (a re-enabled row builds a new one)');
      }
      if (started) return;
      started = true;
      try {
        await gateway.connect();
      } catch (err) {
        // 连不上就让下一次（比如改完凭据再保存）还能重试，而不是永久卡在「已启动」。
        started = false;
        throw err;
      }
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      started = false;
      // Cancel queued work BEFORE the socket goes: a message that already reached
      // the queue must not start a turn afterwards.
      inbound.close();
      gateway.close();
    },
    get running() {
      return gateway.currentState === 'ready';
    },
    get state() {
      return stopped ? 'closed' : gateway.currentState;
    },
  };
}


