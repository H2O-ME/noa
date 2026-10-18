/**
 * 入站消息的处理：一条网关事件 →（去重、被动窗口记账）→ brain → 被动回复。
 *
 * 从 `runtime.ts` 拆出，因为它是另一个问题：`runtime.ts` 讲**通道怎么装配起来**
 * （凭据、网关、插件、启停生命周期），这里讲**收到一条消息之后做什么**（哪些算重复、
 * 回复窗口还在不在、串行执行、失败怎么回话）。后者全是纯逻辑 + 注入的发送函数，可以
 * 单独驱动一条假事件来测，而不必装配整个通道。
 */
import { errMessage, type ImageAttachmentRef } from '@noa/core';
import { parseInbound, type Peer, type QqAttachment, type QqBotChannelStats, type TurnInput } from './types.js';
import { parseInteraction } from './interact.js';
import { resolveInboundImages, resolveInboundVoice } from './media-inbound.js';
import type { QqGatewayOptions } from './protocol.js';
import type { RemoteAnswer } from './peers.js';
import { sendReply, type ReplySink } from './reply.js';

/** 被动回复窗口（略短于官方上限，留出网络余量）：群 5 分钟、单聊 60 分钟。 */
const GROUP_WINDOW_MS = 4.5 * 60_000;
const C2C_WINDOW_MS = 55 * 60_000;
/**
 * 事件去重的 TTL 与容量上限。
 *
 * The TTL is the correction: a plain capacity-bounded Set never expired, so a
 * `msg_id` reused hours later (or after a reconnect replay) was still treated as a
 * duplicate and the message was silently dropped. A window bounds memory AND
 * forgets, which is what "already seen" should mean.
 */
const DEDUPE_TTL_MS = 5 * 60_000;
const DEDUPE_CAP = 1_000;

/** 一条有附件但没有可读内容（图片下载全失败等）的消息的答复。 */
const NOTHING_READABLE_LINE = '（收到了消息，但里面没有我能读到的东西）';

/**
 * 一次要跑的入站轮次：文本 + 原始附件。
 *
 * Attachments stay RAW here on purpose: resolving an image is a network round trip,
 * and this type is built on the synchronous gateway callback path. `deliver`
 * resolves them once the message is off that path.
 */
interface PendingTurn {
  readonly text: string;
  readonly attachments?: readonly QqAttachment[];
}


export interface InboundHandlerOptions {
  /** 回复文本的生产者（运行方的 agent 大脑）；富样式随回答一起走。 */
  brain: (turn: TurnInput, peer: Peer) => Promise<RemoteAnswer>;
  /** 回复的落地方式。 */
  reply: ReplySink;
  log: (line: string) => void;
  /**
   * 取一件入站媒体的字节（QQ CDN 需要 `QQBot <token>` 鉴权头，所以由通道注入）。
   * 缺省 = 本通道不处理入站图片：有附件时只当纯文本消息走。
   */
  fetchMedia?: (url: string) => Promise<Uint8Array>;
  /**
   * 入站图片落盘所在的 home（默认进程 home）。存在的理由是测试要把它指到临时目录，
   * 免得往操作者真实的 `~/.noa/cache/images` 里写东西。
   */
  mediaHomedir?: string;
  /**
   * 语音转写：把一段音频字节变成文字。缺省 = 未配置转写，语音消息降级为
   * 「收到一条语音，未配置转写」。平台自带的 `asr_refer_text` 不需要它。
   */
  transcribe?: (bytes: Uint8Array, hints: { mediaType?: string; filename?: string }) => Promise<string>;
  /**
   * 抢先一步的入站旁路：`claim` 同步判定「这行是遥控指令」，`handle` 异步执行并
   * 返回要发回去的文本。
   *
   * **必须在串行队列之外**，这是它存在的全部理由：一轮 QQ 对话是串行的，而一轮可能
   * 停在审批上等人回答——如果「答复」也要排队，它会永远排在自己等的那一轮后面，
   * 形成死锁。所以遥控指令走旁路，不进队列。
   *
   * `claim` 刻意**同步**：判定「是不是指令」是纯解析，若让它变成异步，两条紧挨着的
   * 普通消息会因为 IO 抖动而改变先后顺序。
   */
  remote?: {
    claim: (text: string, peer: Peer) => boolean;
    handle: (text: string, peer: Peer) => Promise<RemoteAnswer | string | undefined>;
  };
  /**
   * 回应一次按钮互动（`PUT /interactions/{id}`）。缺省不回应：按钮一直在转圈的
   * 体验比报错更糟，所以通道装配时必须给上（`api.respondInteraction`）。
   */
  interact?: (interactionId: string) => Promise<void>;
  /**
   * 把这条消息**插进正在跑的那一轮**（有则返回 true）。
   *
   * 一条新消息是**新的意图**，而它不该等上一轮跑完：排队等于让人对着手机等一个自己
   * 已经改主意的问题。但它也不该把上一轮**打断**——一轮里可能已经跑过 bash、写过
   * 文件，打断等于把已经发生的副作用留在原地却不再解释它们。插话是第三条路，也是唯一
   * 一个既不失礼也不丢工作的：话进得去，活儿接着干。真要立刻停下，`/stop` 是点名的
   * 那条路。
   *
   * **必须是同步的**：判定「有没有在跑」和把消息放进模型下一次一定读到的地方，中间
   * 不能有挂起点（理由见 `AgentSession.interject`）。所以这个座位只做一件事，附件
   * 解析在它之前就做完了。
   */
  interject?: (turn: TurnInput, peer: Peer) => boolean;
}

/** 入站事件的处理器：网关把每条 dispatch 交给它。 */
export class InboundHandler {
  /** 每个对端最近一条入站 msg_id 与落库时间（被动窗口）。 */
  private readonly passive = new Map<string, { msgId: string; at: number }>();
  /** msg_id → 首次见到的时间戳（TTL 去重；见 `DEDUPE_TTL_MS`）。 */
  private readonly dedupe = new Map<string, number>();
  /** 本次运行的收发计数（口径见 `QqBotChannelStats`）：进程内存，重启归零。 */
  private received = 0;
  private replied = 0;
  private lastReceivedAt: number | undefined;
  /** 全局串行：低流量场景下避免并发 brain 调用竞争共享 client 会话亲和。 */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Terminal shutdown latch.
   *
   * A channel that has been switched off must stop doing things: no new message
   * may start a turn, and nothing already queued may go on to reach the model or
   * the platform. Without this the serial queue kept draining after `stop()` — a
   * released turn still answered, and the message behind it ran a whole fresh
   * turn — so the row that was switched off kept operating the machine.
   *
   * Work already INSIDE `brain` is not killed here: cancelling that belongs to
   * whoever owns the session (`PeerTurns.dispose` aborts its peers), and the
   * channel must not pretend to a cancellation it cannot perform.
   */
  private closed = false;

  constructor(private readonly options: InboundHandlerOptions) {}

  /** Whether this handler has been shut down (terminal). */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Shut down for good: refuse new work, drop the queues and the passive windows,
   * and make every in-flight continuation stop before its next side effect.
   *
   * The windows are cleared because they are the CREDENTIALS to send on this
   * channel's behalf: a stopped channel must not be able to hand anybody a
   * still-valid `msg_id`. Queued text is dropped rather than run — the turn it
   * would have started has no channel to answer on, and running it anyway would
   * execute tools on behalf of a channel that is supposed to be gone.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.passive.clear();
    this.dedupe.clear();
    this.queue = Promise.resolve();
  }

  /** 本次运行的收发计数（重启归零，不是历史累计）。 */
  stats(): QqBotChannelStats {
    const { received, replied, lastReceivedAt } = this;
    return { received, replied, ...(lastReceivedAt !== undefined ? { lastReceivedAt } : {}) };
  }

  /**
   * 该对端的被动回复窗口是否还开着，开着就给出可用的 msg_id。
   *
   * 平台只允许「回复最近一条入站消息」这种主动外发；窗口过期后发送只能
   * 老实失败，而不是发一条注定被拒的请求。
   * @param peerId - `group:<id>` / `c2c:<id>`。
   * @returns 可用的 msg_id，或 undefined。
   */
  msgIdOf(peerId: string): string | undefined {
    if (this.closed) return undefined;
    const hit = this.passive.get(peerId);
    if (hit === undefined) return undefined;
    const window = peerId.startsWith('group:') ? GROUP_WINDOW_MS : C2C_WINDOW_MS;
    if (Date.now() - hit.at > window) return undefined;
    return hit.msgId;
  }

  /** 网关 dispatch 的入口（与 `QqGatewayOptions.onDispatch` 同形）。 */
  readonly onDispatch: QqGatewayOptions['onDispatch'] = (event) => {
    if (this.closed) return;
    // 按钮互动先于消息事件：指令按钮平台会另发一条消息，回调按钮只在这里出现。
    const interaction = parseInteraction(event.t, event.d);
    if (interaction !== undefined) {
      void this.runInteraction(interaction);
      return;
    }
    const inbound = parseInbound(event.t, event.d);
    if (inbound === undefined) return;
    const { peer, message } = inbound;
    // 平台会重复推送同一 msg_id —— 去重后再入队（TTL 内算重复，过期算新消息）。
    if (this.isDuplicate(message.id)) return;
    this.passive.set(peer.peerId, { msgId: message.id, at: Date.now() });
    // 计数放在这里：一条去重后的入站消息（无论后面走旁路还是队列）都是「收到」。
    this.received += 1;
    this.lastReceivedAt = Date.now();
    const text = message.content.trim();
    const hasAttachments = (message.attachments?.length ?? 0) > 0;
    // 纯文本空且没有附件才是「空消息」；一张没配文字的图是有内容的。
    if (text.length === 0 && !hasAttachments) return;
    // 遥控指令走队列**之外**的旁路：见 `InboundHandlerOptions.remote` —— 排队会让
    // 一条审批答复永远堵在它自己所等的那一轮后面。带附件的消息不是指令。
    if (!hasAttachments && this.options.remote?.claim(text, peer) === true) {
      void this.runRemote(text, peer);
      return;
    }
    // 新消息 = 新的意图，三条去路见 `deliver`：插进正在跑的那一轮、排在队列后面，
    // 或自己开一轮。旁路指令不在此列——它们本来就不排队（`/stop` 是那条用来停下的路）。
    void this.deliver(
      { text: message.content, ...(message.attachments !== undefined ? { attachments: message.attachments } : {}) },
      peer,
    );
  };

  /**
   * 一条普通消息的去路：插话、排队，或自己开一轮。
   *
   * 顺序是有意的，而且是这里唯一微妙的地方。先把这一轮解析出来（下载附件，异步），
   * **再**做插话判定（同步）。反过来——先判定、再解析、再插话——会给出一个假答案：
   * 判定时说「正在跑」，而真正把消息放进数组时那一轮已经结束了，消息于是进了一个没有
   * 人会再读的轮次，一声不响地消失。先解析则没有这个窗口：判定与落地在同一个同步块
   * 里，要么整件事成立，要么整件事不成立。
   *
   * 代价是解析期间那一轮可能结束，插话于是落空。那不是错误，那正是「晚了一步」的正确
   * 读法——这条消息改走队列，自己开一轮。
   *
   * 解析也从队列里搬到了这里：队列是串行的，而插话必须在轮次还在跑的时候就完成判定，
   * 排队等它等于永远等不到。附件本身与顺序无关（内容寻址、不可变），并发解析不会互相
   * 干扰。
   * @param pending - the raw inbound turn (text plus attachments).
   * @param peer - who sent it.
   */
  private async deliver(pending: PendingTurn, peer: Peer): Promise<void> {
    if (this.closed) return;
    const turn = await this.turnOf(pending, peer);
    if (this.closed) return;
    if (turn !== undefined && this.options.interject?.(turn, peer) === true) return;
    // 没插成（没有在跑的轮次，或插话判定为假）：照旧排队，由它自己开一轮。
    this.queue = this.queue
      .then(() => (turn === undefined ? this.answerUnreadable(peer) : this.replyOnce(turn, peer)))
      .catch(() => undefined);
  }

  /**
   * 这个 msg_id 在 TTL 窗口内是不是已经见过；顺手把它记下并维护容量上限。
   *
   * 过期即视为新消息（先删再记），容量超限时先清过期项、仍超则丢最旧的——这样长时间
   * 运行也不会因为一条老 id 把新消息当重复丢掉。
   * @param msgId - the platform's message id.
   * @returns true when this id was seen within the window.
   */
  private isDuplicate(msgId: string): boolean {
    const now = Date.now();
    const seenAt = this.dedupe.get(msgId);
    if (seenAt !== undefined) {
      if (now - seenAt < DEDUPE_TTL_MS) return true;
      this.dedupe.delete(msgId);
    }
    this.dedupe.set(msgId, now);
    if (this.dedupe.size > DEDUPE_CAP) this.evictDedupe(now);
    return false;
  }

  /** 容量维护：先清过期项，仍超上限就按插入顺序丢最旧的。 */
  private evictDedupe(now: number): void {
    const cutoff = now - DEDUPE_TTL_MS;
    for (const [id, at] of this.dedupe) {
      if (at <= cutoff) this.dedupe.delete(id);
    }
    while (this.dedupe.size > DEDUPE_CAP) {
      const oldest = this.dedupe.keys().next().value;
      if (oldest === undefined) break;
      this.dedupe.delete(oldest);
    }
  }

  /**
   * 一次按钮点击：应答互动（3 秒内），然后按钮的数据按一条消息走同一条管线。
   *
   * 回调按钮的 `button_data` 约定为一条指令文本，所以它进与 `/status` 相同的旁路/
   * 队列判定——按钮和键盘输入殊途同归，不存在第二套执行语义。互动事件自带一个
   * 被动窗口（`msg_id`），先落账，回复才有得挂。
   */
  private async runInteraction(interaction: { interactionId: string; text: string; peer: Peer; msgId?: string }): Promise<void> {
    const { interact, log } = this.options;
    if (interaction.msgId !== undefined) {
      this.passive.set(interaction.peer.peerId, { msgId: interaction.msgId, at: Date.now() });
    }
    if (interact !== undefined) {
      // 应答是让 QQ 客户端停止转圈的一次握手，失败只记日志——按钮数据照常执行。
      await interact(interaction.interactionId).catch((err: unknown) => {
        log(`interaction ack failed for ${interaction.peer.peerId}: ${errMessage(err)}`);
      });
    }
    if (this.closed) return;
    if (this.options.remote?.claim(interaction.text, interaction.peer) === true) {
      await this.runRemote(interaction.text, interaction.peer);
      return;
    }
    this.queue = this.queue.then(() => this.replyOnce({ text: interaction.text }, interaction.peer)).catch(() => undefined);
  }

  /** 旁路执行一条遥控指令，并把它的答复按被动窗口发回去。 */
  private async runRemote(text: string, peer: Peer): Promise<void> {
    const { remote, reply, log } = this.options;
    if (remote === undefined) return;
    try {
      const raw = await remote.handle(text, peer);
      // A shutdown that landed while the command ran wins: its answer describes a
      // channel that is no longer there.
      if (this.closed) return;
      // `undefined` = 这条指令没有立即答复（例如它已经自己发过消息了）。
      if (raw === undefined) return;
      const answer: RemoteAnswer = typeof raw === 'string' ? { text: raw } : raw;
      if (await sendReply(reply, log, peer, answer, 'remote')) this.replied += 1;
    } catch (err) {
      log(`remote failed for ${peer.peerId}: ${errMessage(err)}`);
    }
  }

  private async replyOnce(turn: TurnInput, peer: Peer): Promise<void> {
    // Queued behind an earlier turn — the channel may have been switched off in
    // the meantime, in which case this message must not reach the model at all.
    if (this.closed) return;
    const { brain, reply, log } = this.options;
    let answer: RemoteAnswer;
    try {
      answer = await brain(turn, peer);
    } catch (err) {
      log(`brain failed for ${peer.peerId}: ${errMessage(err)}`);
      answer = { text: '（处理消息时出错，请稍后重试）' };
    }
    if (this.closed) return;
    if (await sendReply(reply, log, peer, answer, 'replied')) this.replied += 1;
  }

  /** 一条有附件但没有可读内容的消息：如实回一句，不开空轮次。 */
  private async answerUnreadable(peer: Peer): Promise<void> {
    if (this.closed) return;
    const { reply, log } = this.options;
    if (await sendReply(reply, log, peer, { text: NOTHING_READABLE_LINE }, 'replied')) this.replied += 1;
  }

  /**
   * 把一条待跑的入站消息变成 brain 的输入：文本 + 图片引用。
   *
   * 下载在这里（异步），不在 `onDispatch` 里——网关回调是同步的，而一次下载是一次
   * 网络往返。图片与语音逐件独立，失败的只记日志、不拖垮整条消息。
   * @param pending - the text and attachments.
   * @param peer - who sent it (for the log line).
   * @returns the turn, or undefined when there is nothing readable in it.
   */
  private async turnOf(pending: PendingTurn, peer: Peer): Promise<TurnInput | undefined> {
    const text = pending.text.trim();
    const attachments = pending.attachments ?? [];
    const fetchMedia = this.options.fetchMedia;
    let images: readonly ImageAttachmentRef[] | undefined;
    const parts: string[] = text.length > 0 ? [text] : [];
    if (attachments.length > 0) {
      // 语音可以先靠平台自带的 `asr_refer_text` 满足，不需要下载能力；图片必须下载。
      const fetch = fetchMedia ?? (async (): Promise<Uint8Array> => {
        throw new Error('本通道没有媒体下载能力');
      });
      if (fetchMedia !== undefined) {
        const resolved = await resolveInboundImages(attachments, fetch, this.options.mediaHomedir);
        for (const failure of resolved.failures) this.options.log(`image refused for ${peer.peerId}: ${failure}`);
        if (resolved.images.length > 0) images = resolved.images;
      }
      const voice = await resolveInboundVoice(attachments, fetch, this.options.transcribe);
      parts.push(...voice.blocks);
    }
    const composed = parts.join('\n');
    if (composed.length === 0 && images === undefined) return undefined;
    return { text: composed, ...(images !== undefined ? { images } : {}) };
  }
}


