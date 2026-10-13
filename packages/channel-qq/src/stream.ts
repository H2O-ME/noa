/**
 * 把一轮回复里**每条助手消息**长成 QQ 的流式消息（`POST /stream_messages`）。
 *
 * 内核的事件流给 `text_delta`（按 messageId 分组）和完成时的 `message` 事件；QQ 的
 * 流式消息要的是「同一条消息越写越长」：首片（index 0，state 1）取回 `stream_msg_id`，
 * 续片携带它增量前进，结束片（state 10）携带全文收口。`ReplyStreamer` 就是这两者之间
 * 的节流阀——delta 来得比平台愿意收的密，按最小间隔整句重发（replace 语义：每次都带
 * 全量前缀，服务端只接受延长，不允许改写已下发内容）。
 *
 * 全程**不许抛**：流式失败只把这个流标坏，一轮的投递责任退回普通发送路径——样式可以
 * 输，内容不能丢。但「失败」不是一种东西，这里有两条各自独立的教训：
 *
 *  - **抖动 ≠ 永久失败**：平台把限频和过载以两种看起来毫不相干的状态码发回来，两者
 *    都是「过一会儿再发同一片」（判据 `api-error.ts`，策略 `stream-send.ts`）。把任何
 *    一次这样的噪声当永久失败，就会用一次平台抖动废掉整轮的流式。
 *  - **片与片必须串行**：原先每片都 fire-and-forget，而 `index` 在 await 之后才自增
 *    ——平台一慢（正是它同时返回 500 的时候），两片就会同时在飞并读到同一个序号，换
 *    回「消息分片发送过快」。所以整条链是一个 promise 队列，序号在发送时才算，且收口
 *    （state 10）也要等够与上一片的间隔。
 */
import { sendShard, sleepMs } from './stream-send.js';

/** 最小重发间隔：QQ 流式接口 50 QPS 是接口级限额，真正的约束是读侧体验。 */
export const STREAM_MIN_INTERVAL_MS = 1_500;

/**
 * 一片往哪送。
 *
 * 返回值不在这里读：`stream_msg_id` 是「一条消息」的属性，由持有这一轮闭包的那一侧
 * （`observer.ts`）接住并交给下一片——本类只负责「什么时候发第几片」，再存一份就成了
 * 同一事实的第二份。
 */
export interface StreamSink {
  (p: { text: string; state: 1 | 10; index: number }): Promise<{ streamMsgId?: string } | void>;
}

/** 一条正在长的流式消息的本地状态。 */
interface LiveStream {
  messageId: string;
  /** 全量累积文本（replace 语义：每次发送都带全量）。 */
  text: string;
  /** 下一个分片序号（从 0 起；**发送成功**才 +1）。 */
  index: number;
  lastSentAt: number;
  /** 已经排了一片还没落定：`feed` 据此不再往队列里堆。 */
  queued: boolean;
}

export class ReplyStreamer {
  private readonly sink: StreamSink;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 坏了就整轮停用：不可重试的失败不该把后续每片都撞一遍墙。 */
  private broken = false;
  private live: LiveStream | undefined;
  /** 串行链：一片没发完，下一片不出发（见模块头「片与片必须串行」）。 */
  private chain: Promise<void> = Promise.resolve();

  /** 流坏掉时的留痕（可选）：没有它，「这条回复为什么不是流式的」无从诊断。 */
  private readonly onBroken: (err: unknown) => void;

  constructor(options: {
    sink: StreamSink;
    now?: () => number;
    minIntervalMs?: number;
    onBroken?: (err: unknown) => void;
    /** 重试之间的等待；测试注入以便不必真的等。 */
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.sink = options.sink;
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? STREAM_MIN_INTERVAL_MS;
    this.onBroken = options.onBroken ?? (() => undefined);
    this.sleep = options.sleep ?? sleepMs;
  }

  /** 一段 delta 到了：换消息就收口旧的、开新的；到了间隔就整句重发。 */
  feed(messageId: string, delta: string): void {
    if (this.broken || delta.length === 0) return;
    const at = this.now();
    const live = this.live;
    if (live === undefined || live.messageId !== messageId) {
      // 上一条没等到 message 事件就换新了（被截断的中间叙述）：带着已有内容收口。
      if (live !== undefined) void this.enqueue(live, 10);
      const opened: LiveStream = { messageId, text: delta, index: 0, lastSentAt: at, queued: false };
      this.live = opened;
      void this.enqueue(opened, 1);
      return;
    }
    live.text += delta;
    // 一片还在飞就不再排队：`lastSentAt` 只在发送成功后才更新，所以平台一慢，
    // 这个间隔判定会一直为真——不挡住它就会堆出一串内容重复的片。
    if (!live.queued && at - live.lastSentAt >= this.minIntervalMs) void this.enqueue(live, 1);
  }

  /**
   * 一条助手消息完成了：以全文收口（state 10）。
   *
   * 返回值是**异步**的：「这条正文有没有由卡片送达」只能等收口真的写落定才知道。乐观
   * 地先答 true，一旦收口失败，调用方就不会再发这条正文——答案就此无声消失。
   * @param messageId - 完成的那条消息。
   * @param fullText - 全文（不是 delta）。
   * @returns 是否整条消息已经由流式投递（true = 调用方不必再发这条正文）。
   */
  done(messageId: string, fullText: string): boolean | Promise<boolean> {
    if (this.broken) return false;
    const live = this.live;
    if (live === undefined || live.messageId !== messageId) {
      // 没见过它的 delta（例如 delta 丢失、或消息快到没有 delta）：没法补开一条
      // 流——首片就该是全文，但此刻已经太晚，交回普通路径。
      return false;
    }
    live.text = fullText.trim();
    this.live = undefined;
    return this.enqueue(live, 10);
  }

  /** 流坏了没有（调用方据此决定要不要把叙述兜回普通通道）。 */
  get isBroken(): boolean {
    return this.broken;
  }

  /**
   * 排队发一片，返回「这一片到底送出去没有」。链本身永不 reject：一次失败必须只废掉
   * 这一片，不能连累后面每一片（否则一个 unhandled rejection 还能顺着链把整轮拖垮）。
   */
  private enqueue(stream: LiveStream, state: 1 | 10): Promise<boolean> {
    stream.queued = true;
    const run = this.chain.then(() => this.send(stream, state));
    const settled = (): void => { stream.queued = false; };
    this.chain = run.then(settled, settled);
    return run;
  }

  /** 真正发一片：先等够间隔，失败按可重试性决定重试还是收手。 */
  private async send(stream: LiveStream, state: 1 | 10): Promise<boolean> {
    if (this.broken) return false;
    // 首片之外都等够间隔。收口紧跟着上一片来，而「同一个 stream_msg_id 上两片挨太
    // 近」正是平台回「消息分片发送过快」的原因——节流只挡 delta 侧是不够的。
    if (stream.index > 0) await this.waitForGap(stream);
    const index = stream.index;
    const outcome = await sendShard({
      attempt: async () => { await this.sink({ text: stream.text, state, index }); },
      now: this.now,
      sleep: this.sleep,
    });
    if (!outcome.ok) {
      this.break(outcome.err);
      return false;
    }
    stream.index = index + 1;
    stream.lastSentAt = this.now();
    return true;
  }

  /** 距上一片还差多久才该发（毫秒）；已经够了就是 0。 */
  private async waitForGap(stream: LiveStream): Promise<void> {
    const wait = this.minIntervalMs - (this.now() - stream.lastSentAt);
    if (wait > 0) await this.sleep(wait);
  }

  /** 标坏这一轮：后续 delta 直接丢弃，正文交回普通发送路径。 */
  private break(err: unknown): void {
    this.broken = true;
    this.live = undefined;
    this.onBroken(err);
  }
}
