/**
 * The QQ gateway/API public face: protocol vocabulary, the gateway state
 * machine and the REST client.
 *
 * Split because they answer different questions and grew apart: the gateway
 * (`gateway.ts`) owns a long-lived, reconnecting connection with its own
 * lifecycle, while this file owns stateless request/response traffic. Both are
 * re-exported from here so the package's public face is unchanged and every
 * existing importer keeps reading `protocol.js`.
 */
export * from './gateway.js';
// The token/fetch vocabulary is shared by the gateway and the REST client, and
// every existing importer reads it from here (`runtime.ts`, `probe.ts`, the
// protocol tests). Re-exported so the split above shrinks nothing.
export { AccessTokenManager, TOKEN_ENDPOINT, type CredentialSource, type FetchLike, type HttpClientResponse } from './token.js';
// Rich-message vocabulary and body building (markdown + keyboard + media) live in
// their own module; re-exported so the public face stays `protocol.js`.
export { bareImageUrl, localMediaInText } from './media.js';
export {
  buildMessagePlan,
  cardText,
  chunkText,
  type MessagePlan,
  type QqButton,
  type QqKeyboard,
  type RichSend,
} from './rich-send.js';
import { buildMessagePlan, type RichSend } from './rich-send.js';
import { isDuplicateSend, isRateLimited, isRetryable, QqApiError } from './api-error.js';
import { withDeadline } from './deadline.js';
import type { AccessTokenManager, FetchLike } from './token.js';
import { uploadLocalFile } from './upload.js';

// ---------------------------------------------------------------------- api

export interface SentMessage {
  id: string;
  seq: number;
}

export interface SendOptions {
  /** 纯文本正文；`rich.markdown` 存在时被 markdown 取代（也作为回落正文）。 */
  content: string;
  /** 被动回复：入站事件的 msg_id（外层事件体的 d.id）。 */
  msgId?: string;
  /** 富形态（markdown + 按钮 / 媒体）；缺省纯文本。 */
  rich?: RichSend;
  baseUrl?: string;
}

/** BOT 身份读取的墙钟上限：一次**显示用**的读取，绝不能把设置页挂在「正在读取」上。 */
const IDENTITY_TIMEOUT_MS = 3_000;

/**
 * 一条被平台判为「已经投递过」的消息在 `SentMessage.id` 上的占位。
 *
 * 平台不给这种回执发消息 id（它没有新消息），但这一次发送**是成功的**，所以不能走
 * 「没有 id 就是没送达」那条路。这个占位只是让调用方拿到一个非空字符串；它不会被读
 * ——本包没有任何一处依赖回复的 id。
 */
export const DUPLICATE_SEND_RECEIPT = 'qqbot:duplicate-send';

/**
 * msg_seq 账本的保留窗口与容量上限。
 *
 * 一个 `msg_id` 的 seq 只需要活到它自己的被动窗口结束：窗口一过，对它再发消息本来就会
 * 被平台拒（`msg_id` 已失效）。但**过早忘掉**是有代价的——seq 会从 1 重新开始，同一个
 * `msg_id` 上第二次 seq=1 会被平台判成重复推送（40054005「消息被去重」）。所以 TTL 取
 * 最长的那档窗口（单聊 55 分钟，见 `inbound.ts`）再留余量，而不是随手取几分钟。
 *
 * 没有这道闸门时，这个 Map 每个入站消息长一条、永不清理——常驻进程里就是一条只会
 * 往上走的曲线，和入站去重那个 Set 是同一类问题。
 */
const SEQ_TTL_MS = 60 * 60_000;
const SEQ_CAP = 4_096;

/**
 * 一次 REST 调用的重试预算。
 *
 * 存在的理由和 `api-error.ts` 是同一件事：这个平台的失败判据是**业务码**，而它把
 * 「系统繁忙，请稍后重试」以 HTTP 500 返回、把「分片发送过快」以 404 返回。既然
 * `isRetryable` / `isRateLimited` 已经把「该不该重试、该等多久」判出来了，就必须有人
 * 真的去重试——这两个函数曾经导出后**没有任何调用点**，于是平台抖一下，一条回复就没了。
 *
 * 重发同一条消息是安全的：平台按 `(msg_id, msg_seq)` 去重，所以第一次其实已经投递的
 * 那种情况，第二次会拿到 40054005，而那个码被读成**成功**（`isDuplicateSend`），不是
 * 失败。这条幂等性正是敢在这里重试消息的原因。
 */
export interface QqRetryPolicy {
  /** 首发算一次：3 表示最多 1 次首发 + 2 次重试。 */
  maxAttempts: number;
  /** 一般可重试失败的基础等待，按次数翻倍。 */
  baseDelayMs: number;
  /** 限频那档的等待：平台要的是「慢一点」，退避不够。 */
  rateLimitDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: QqRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  rateLimitDelayMs: 2_000,
};

/** 单次等待的上限：重试不该比它要救的那条被动回复窗口还长。 */
const RETRY_MAX_DELAY_MS = 8_000;

/** 把 1 起算的尝试号变成这一次该等多久。 */
function retryDelayMs(policy: QqRetryPolicy, attempt: number, rateLimited: boolean): number {
  if (rateLimited) return Math.min(policy.rateLimitDelayMs * attempt, RETRY_MAX_DELAY_MS);
  return Math.min(policy.baseDelayMs * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}

/**
 * REST 发消息客户端：群聊 `POST /v2/groups/{group_openid}/messages`、
 * 单聊 `POST /v2/users/{user_openid}/messages`。msg_seq 按 msg_id 自增
 * （同 msg_id 多次回复去重需要递增 seq）；鉴权头 `Authorization: QQBot x`，
 * 401 时失效 token 让下次请求重取。
 */
export class QqApi {
  private readonly seqByMsgId = new Map<string, { seq: number; at: number }>();

  constructor(
    private readonly token: AccessTokenManager,
    private readonly fetchFn: FetchLike,
    private readonly baseUrl = 'https://api.sgroup.qq.com',
    private readonly log: (line: string) => void = () => undefined,
    private readonly retry: QqRetryPolicy = DEFAULT_RETRY_POLICY,
  ) {}

  async sendGroupMessage(groupOpenid: string, opts: SendOptions): Promise<SentMessage[]> {
    return this.send(`/v2/groups/${groupOpenid}/messages`, opts);
  }

  async sendC2CMessage(userOpenid: string, opts: SendOptions): Promise<SentMessage[]> {
    return this.send(`/v2/users/${userOpenid}/messages`, opts);
  }

  /** BOT 名称缓存：键是换来 token 的那对凭据的 appId（凭据换了自然重取）。 */
  private identity: { appId: string; name: string | null } | undefined;

  /**
   * 机器人自己在 QQ 网关里的用户名（`GET /users/@me`）：取不到就给 null，调用方如实显示
   * 「取不到」，绝不编名字。按 appId 缓存（一次运行最多问一次），并带墙钟上限——显示用的
   * 读取不能把设置页挂住，而超时、网络失败、端点未开放都只是 null。
   */
  async botName(): Promise<string | null> {
    const appId = this.token.currentAppId();
    if (appId.length === 0) return null;
    if (this.identity?.appId === appId) return this.identity.name;
    const read = async (): Promise<string | null> => {
      const accessToken = await this.token.get();
      // Bounded with the shared helper rather than a hand-rolled race: the old
      // `Promise.race` left its timer armed after a fast answer (one stray timer
      // per call) and never cancelled the request it had abandoned.
      return await withDeadline(async (signal) => {
        const res = await this.fetchFn(`${this.baseUrl}/users/@me`, {
          headers: { Authorization: `QQBot ${accessToken}` },
          signal,
        });
        if (res.status === 401) this.token.invalidate();
        const body = (await res.json().catch(() => undefined)) as { username?: unknown } | undefined;
        return res.ok && typeof body?.username === 'string' && body.username.length > 0 ? body.username : null;
      }, 'bot identity', IDENTITY_TIMEOUT_MS);
    };
    const name = await read().catch(() => null);
    this.identity = { appId, name };
    return name;
  }

  private nextSeq(msgId: string): number {
    const now = Date.now();
    const prior = this.seqByMsgId.get(msgId);
    // 过期即视为一个全新的窗口：留着旧的计数只会让 seq 一直涨（无害，但也没必要）。
    if (prior !== undefined && now - prior.at >= SEQ_TTL_MS) this.seqByMsgId.delete(msgId);
    const next = (this.seqByMsgId.get(msgId)?.seq ?? 0) + 1;
    this.seqByMsgId.set(msgId, { seq: next, at: now });
    if (this.seqByMsgId.size > SEQ_CAP) this.evictSeq(now);
    return next;
  }

  /** 容量维护：先清过期项，仍超上限就按插入顺序丢最旧的。 */
  private evictSeq(now: number): void {
    const cutoff = now - SEQ_TTL_MS;
    for (const [id, entry] of this.seqByMsgId) {
      if (entry.at <= cutoff) this.seqByMsgId.delete(id);
    }
    while (this.seqByMsgId.size > SEQ_CAP) {
      const oldest = this.seqByMsgId.keys().next().value;
      if (oldest === undefined) break;
      this.seqByMsgId.delete(oldest);
    }
  }

  private async send(path: string, opts: SendOptions): Promise<SentMessage[]> {
    const plan = buildMessagePlan(opts, (id) => this.nextSeq(id));
    const sent: SentMessage[] = [];
    for (const body of plan.bodies) {
      try {
        const id = await this.requestMessage(path, body);
        sent.push({ id, seq: typeof body['msg_seq'] === 'number' ? body['msg_seq'] : 0 });
      } catch (err) {
        // 富形态被平台拒绝时整体回落纯文本：样式可以输，内容不能丢。媒体没有
        // 回落（file_info 就是正文），纯文本自身的失败也如实上抛。
        const fallback = plan.fallback;
        if (fallback === undefined) throw err;
        // 回落必须留痕：markdown/按钮被平台拒绝的真实原因（权限、字段形态）只
        // 存在于这次拒绝的响应里，吞掉它等于永远修不了富样式。
        this.log(`qqbot: rich send rejected, falling back to text: ${String(err)}`);
        const results: SentMessage[] = [];
        for (const plain of fallback) {
          const id = await this.requestMessage(path, plain);
          results.push({ id, seq: typeof plain['msg_seq'] === 'number' ? plain['msg_seq'] : 0 });
        }
        return results;
      }
    }
    return sent;
  }

  /**
   * 发出一条消息体并核对回执：2xx 且响应带消息 id 才算送达。
   *
   * 从 `send` 里拆出来只因为三种消息形态（纯文本 / markdown+键盘 / 媒体）构造
   * body 的方式不同，而「发出并核对」是同一个动作。
   */
  private async requestMessage(path: string, body: Record<string, unknown>): Promise<string> {
    let parsed: unknown;
    try {
      parsed = await this.request(path, body);
    } catch (err) {
      // 去重回执（40054005）不是失败：平台按 `(msg_id, msg_seq)` 去重，所以这个码
      // 意味着这一次发送**之前已经投递成功**——典型来路正是重试一条「响应在回程
      // 丢了」的消息。读成失败会给一条已经到达的消息记上「没发出去」，上层据此再补发
      // 一遍，读者就收到两份。
      if (isDuplicateSend(err)) {
        this.log(`qqbot: ${path} was already delivered (platform dedup); treating it as sent`);
        return DUPLICATE_SEND_RECEIPT;
      }
      // 失败时补上 msg_type：媒体（7）被拒与纯文本（0）被拒是两回事，而两者的错误
      // 前缀完全一样（都出自 `request`），850019「富媒体文件格式不支持」正是只在
      // msg_type 7 上出现的那种——不带上它就分不清是消息被拒还是上传被拒。
      throw new Error(`${String(err)} [msg_type ${String(body['msg_type'])}]`);
    }
    // A 2xx whose body carries no message id is NOT a delivered message. It was
    // previously counted as one (`id: ''`), so a platform rejection that still
    // answered 200 inflated the channel's reply tally and told the model the
    // send had landed.
    const id = typeof parsed === 'object' && parsed !== null ? (parsed as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('qqbot: send failed (ok): response carried no message id');
    }
    return id;
  }

  /**
   * 预上传一个富媒体文件，返回发消息用的 `file_info`。
   *
   * 群聊 `POST /v2/groups/{openid}/files`、单聊 `POST /v2/users/{openid}/files`
   * 两套接口**互相独立**，同一份 file_info 不能跨场景使用——`kind` 由对端类型决定。
   * URL 方式（平台代下载转存）是唯一支持的入口：本地文件分片上传是另一套协议，
   * 这条通道没有它的用武之地。
   * @param kind - 对端场景。
   * @param media - 文件类型（1 图 / 2 视频 / 3 语音 / 4 文件）与公网可访问地址。
   * @returns 限时有效的 `file_info`（过期重传）。
   */
  async uploadMedia(kind: 'group' | 'c2c', openid: string, media: { fileType: 1 | 2 | 3 | 4; url: string }): Promise<string> {
    const path = kind === 'group' ? `/v2/groups/${openid}/files` : `/v2/users/${openid}/files`;
    const parsed = await this.request(path, { file_type: media.fileType, url: media.url, srv_send_msg: false });
    const info = typeof parsed === 'object' && parsed !== null ? (parsed as { file_info?: unknown }).file_info : undefined;
    if (typeof info !== 'string' || info.length === 0) {
      throw new Error('qqbot: media upload failed: response carried no file_info');
    }
    return info;
  }

  /**
   * 上传一个**本地文件**并返回 `file_info`（四步分片上传，单聊专用）。
   *
   * 流程本身在 `upload.ts`：这里只把鉴权请求与 fetch 接缝交出去，本类仍是
   * 「REST 请求怎么发」的唯一实现。
   */
  async uploadLocalC2C(openid: string, media: { fileType: 1 | 2 | 3 | 4; path: string }): Promise<string> {
    return await uploadLocalFile(
      { request: (path, body) => this.request(path, body), fetchFn: this.fetchFn, log: this.log },
      openid,
      media,
    );
  }

  /**
   * 回应一次按钮互动（`PUT /interactions/{id}`，3 秒内）：code 0 = 成功。
   * 只回应一次；失败如实上抛，由调用方决定要不要把交互当没发生过。
   */
  async respondInteraction(interactionId: string): Promise<void> {
    await this.request(`/interactions/${interactionId}`, { code: 0 });
  }

  /**
   * One REST call, with the retry budget spent on failures that are worth retrying.
   *
   * The classification is `api-error.ts`'s (business code first, status only as a
   * fallback) and the delay is longer for a rate limit, because what the platform
   * asked for there is "slower", not "again". Retrying a MESSAGE send is safe:
   * the platform dedups on `(msg_id, msg_seq)`, so an attempt that actually
   * landed comes back as a duplicate-send receipt, which `requestMessage` reads
   * as delivered.
   * @param path - the endpoint path.
   * @param body - the request body, re-sent verbatim (same msg_seq → idempotent).
   * @returns the parsed response body.
   */
  private async request(path: string, body: unknown): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        return await this.requestOnce(path, body);
      } catch (err) {
        lastError = err;
        if (attempt >= this.retry.maxAttempts || !isRetryable(err)) throw err;
        const wait = retryDelayMs(this.retry, attempt, isRateLimited(err));
        this.log(`qqbot: ${path} failed (attempt ${attempt}/${this.retry.maxAttempts}), retrying in ${wait}ms: ${String(err)}`);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
    }
    // 循环只在每次尝试都失败时走到底；上面最后一次已经 throw，这行是给类型看的。
    throw lastError;
  }

  private async requestOnce(path: string, body: unknown): Promise<unknown> {
    const token = await this.token.get();
    const [status, payload] = await withDeadline(async (signal) => {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
        signal,
      });
      // Read the body INSIDE the deadline and WITHOUT assuming it is JSON: an
      // error page (HTML, an empty 204) used to make `res.json()` throw before the
      // status was ever examined — so a 401 whose body was not JSON never
      // invalidated the token, and every later send reused the dead credential.
      const parsed = await res.json().catch(() => undefined);
      return [res.status, parsed] as const;
    }, 'send message');
    if (status < 200 || status >= 300) {
      // 鉴权过期：作废 token，下次重取；错误仍如实上抛。
      if (status === 401) this.token.invalidate();
      throw new QqApiError('send failed', status, payload);
    }
    return payload;
  }
}
