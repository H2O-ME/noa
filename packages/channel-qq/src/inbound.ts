/**
 * 入站消息的处理：一条网关事件 →（去重、被动窗口记账）→ brain → 被动回复。
 *
 * 从 `runtime.ts` 拆出，因为它是另一个问题：`runtime.ts` 讲**通道怎么装配起来**
 * （凭据、网关、插件、启停生命周期），这里讲**收到一条消息之后做什么**（哪些算重复、
 * 回复窗口还在不在、串行执行、失败怎么回话）。后者全是纯逻辑 + 注入的发送函数，可以
 * 单独驱动一条假事件来测，而不必装配整个通道。
 */
import { errMessage } from '@noa/core';
import { parseInbound, type Peer, type QqBotChannelStats } from './types.js';
import { parseInteraction } from './interact.js';
import type { QqGatewayOptions } from './protocol.js';
import type { RemoteAnswer } from './peers.js';
import { sendReply, type ReplySink } from './reply.js';

/** 被动回复窗口（略短于官方上限，留出网络余量）：群 5 分钟、单聊 60 分钟。 */
const GROUP_WINDOW_MS = 4.5 * 60_000;
const C2C_WINDOW_MS = 55 * 60_000;
/** 事件去重缓存上限（同一 msg_id 可能重复推送）。 */
const DEDUPE_CAP = 512;


export interface InboundHandlerOptions {
  /** 回复文本的生产者（运行方的 agent 大脑）；富样式随回答一起走。 */
  brain: (text: string, peer: Peer) => Promise<RemoteAnswer>;
  /** 回复的落地方式。 */
  reply: ReplySink;
  log: (line: string) => void;
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
   * 打断这个对端正跑着的那一轮（有则返回 true）。
   *
   * 一条新消息是**新的意图**：排队让它等上一轮跑完，等于让人对着手机等一个自己
   * 已经改主意的问题。所以新消息先把在跑的轮次打断，再按顺序跑（中断的轮次在
   * 日志里留下 `<turn_aborted>` 标记，模型看得见自己被打断过）。
   */
  interrupt?: (peer: Peer) => boolean;
}

/** 入站事件的处理器：网关把每条 dispatch 交给它。 */
export class InboundHandler {
  /** 每个对端最近一条入站 msg_id 与落库时间（被动窗口）。 */
  private readonly passive = new Map<string, { msgId: string; at: number }>();
  private readonly dedupe = new Set<string>();
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

  /** 本次运行的收发计数（设置页的连接读数；重启归零，不是历史累计）。 */
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
    // 平台会重复推送同一 msg_id —— 去重后再入队。
    if (this.dedupe.has(message.id)) return;
    this.dedupe.add(message.id);
    if (this.dedupe.size > DEDUPE_CAP) {
      const oldest = this.dedupe.values().next().value;
      if (oldest !== undefined) this.dedupe.delete(oldest);
    }
    this.passive.set(peer.peerId, { msgId: message.id, at: Date.now() });
    // 计数放在这里：一条去重后的入站消息（无论后面走旁路还是队列）都是「收到」。
    this.received += 1;
    this.lastReceivedAt = Date.now();
    const text = message.content.trim();
    if (text.length === 0) return;
    // 遥控指令走队列**之外**的旁路：见 `InboundHandlerOptions.remote` —— 排队会让
    // 一条审批答复永远堵在它自己所等的那一轮后面。
    if (this.options.remote?.claim(text, peer) === true) {
      void this.runRemote(text, peer);
      return;
    }
    // 新消息 = 新意图：先把在跑的那一轮打断，再入队。旁路指令不在此列——它们
    // 本来就不排队（`/stop` 就是那条用来打断的路）。
    this.options.interrupt?.(peer);
    this.queue = this.queue.then(() => this.replyOnce(text, peer)).catch(() => undefined);
  };

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
    this.queue = this.queue.then(() => this.replyOnce(interaction.text, interaction.peer)).catch(() => undefined);
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

  private async replyOnce(text: string, peer: Peer): Promise<void> {
    // Queued behind an earlier turn — the channel may have been switched off in
    // the meantime, in which case this message must not reach the model at all.
    if (this.closed) return;
    const { brain, reply, log } = this.options;
    let answer: RemoteAnswer;
    try {
      answer = await brain(text, peer);
    } catch (err) {
      log(`brain failed for ${peer.peerId}: ${errMessage(err)}`);
      answer = { text: '（处理消息时出错，请稍后重试）' };
    }
    if (this.closed) return;
    if (await sendReply(reply, log, peer, answer, 'replied')) this.replied += 1;
  }
}


