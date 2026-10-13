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
import { QqApiError } from './api-error.js';
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
 * REST 发消息客户端：群聊 `POST /v2/groups/{group_openid}/messages`、
 * 单聊 `POST /v2/users/{user_openid}/messages`。msg_seq 按 msg_id 自增
 * （同 msg_id 多次回复去重需要递增 seq）；鉴权头 `Authorization: QQBot x`，
 * 401 时失效 token 让下次请求重取。
 */
export class QqApi {
  private readonly seqByMsgId = new Map<string, number>();

  constructor(
    private readonly token: AccessTokenManager,
    private readonly fetchFn: FetchLike,
    private readonly baseUrl = 'https://api.sgroup.qq.com',
    private readonly log: (line: string) => void = () => undefined,
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
    const next = (this.seqByMsgId.get(msgId) ?? 0) + 1;
    this.seqByMsgId.set(msgId, next);
    return next;
  }

  /** 公开给流式发送用：同一被动窗口里，流式分片与普通发送共用一个 seq 账本。 */
  drawSeq(msgId: string): number {
    return this.nextSeq(msgId);
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
    // 失败时补上 msg_type：媒体（7）被拒与纯文本（0）被拒是两回事，而两者的错误
    // 前缀完全一样（都出自 `request`），850019「富媒体文件格式不支持」正是只在
    // msg_type 7 上出现的那种——不带上它就分不清是消息被拒还是上传被拒。
    const parsed = await this.request(path, body).catch((err: unknown) => {
      throw new Error(`${String(err)} [msg_type ${String(body['msg_type'])}]`);
    });
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
   * 撤回一条单聊消息（`DELETE /v2/users/{openid}/messages/{message_id}`）。
   * 平台时限 2 分钟，过期由服务端拒绝（如实上抛，调用方尽力而为即可）。
   */
  async deleteC2CMessage(userOpenid: string, messageId: string): Promise<void> {
    const token = await this.token.get();
    const [status, payload] = await withDeadline(async (signal) => {
      const res = await this.fetchFn(
        `${this.baseUrl}/v2/users/${userOpenid}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE', headers: { Authorization: `QQBot ${token}` }, signal },
      );
      if (res.status === 401) this.token.invalidate();
      const parsed = await res.json().catch(() => undefined);
      return [res.status, parsed] as const;
    }, 'delete message');
    if (status < 200 || status >= 300) {
      throw new QqApiError('delete failed', status, payload);
    }
  }

  /**
   * 单聊流式消息（`POST /v2/users/{openid}/stream_messages`）。
   *
   * 同一张卡片边生成边长：首片不带 `stream_msg_id`（服务端在响应 `id` 里发回一个），
   * 后续片携带它并递增 `index`。`input_state` 1 = 生成中，10 = 生成结束。
   * 仅单聊开放；群聊没有对应接口，调用方须按对端类型分流。
   */
  async sendStreamC2C(
    userOpenid: string,
    p: {
      text: string;
      mode: 'append' | 'replace';
      state: 1 | 10;
      index: number;
      contentType: 'text' | 'markdown';
      streamMsgId?: string;
      msgId?: string;
      /** 与普通发送共账本的被动去重序号（`drawSeq`）。 */
      msgSeq?: number;
    },
  ): Promise<{ id: string; streamMsgId: string | undefined }> {
    const body: Record<string, unknown> = {
      input_mode: p.mode,
      input_state: p.state,
      index: p.index,
      content_type: p.contentType,
      content_raw: p.text,
    };
    if (p.streamMsgId !== undefined) body['stream_msg_id'] = p.streamMsgId;
    else if (p.msgId !== undefined) body['msg_id'] = p.msgId;
    if (p.msgSeq !== undefined) body['msg_seq'] = p.msgSeq;
    const accessToken = await this.token.get();
    const [status, payload] = await withDeadline(async (signal) => {
      const res = await this.fetchFn(`${this.baseUrl}/v2/users/${userOpenid}/stream_messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${accessToken}` },
        body: JSON.stringify(body),
        signal,
      });
      if (res.status === 401) this.token.invalidate();
      const parsed = await res.json().catch(() => undefined);
      return [res.status, parsed] as const;
    }, 'send stream message');
    if (status < 200 || status >= 300) {
      throw new QqApiError('stream send failed', status, payload);
    }
    const id = typeof payload === 'object' && payload !== null ? (payload as { id?: unknown }).id : undefined;
    // 官方响应的 `id` 字段首片即 stream_msg_id（同一字段两用）。
    return { id: typeof id === 'string' ? id : '', streamMsgId: typeof id === 'string' ? id : undefined };
  }

  private async request(path: string, body: unknown): Promise<unknown> {
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
