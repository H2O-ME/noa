/**
 * Real-time reporting of a running turn back to the chat.
 *
 * The point of driving a machine from a phone is that you find out what is
 * happening WITHOUT opening a laptop. A turn that reports only its final answer is
 * indistinguishable from one that hung, and a long agent run can spend minutes in
 * tools before it has anything to say.
 *
 * So progress is forwarded — but it is BUDGETED, because every outbound message is
 * a scarce resource here:
 *
 *  - an outbound message is a PASSIVE REPLY, tied to one inbound `msg_id` and
 *    answered with an incrementing `msg_seq`. The platform bounds how many replies
 *    one inbound message may draw, so one message per tool call would spend the
 *    whole allowance early in the run and then fail — losing exactly the final
 *    answer the operator was waiting for.
 *  - therefore: a bounded number of COALESCED updates. The ANSWER does not travel
 *    through this relay at all — `peers.ts` returns it to the channel's reply
 *    seat, which spends the reserve this budget deliberately leaves untouched.
 *
 * Narration is driven by TOOL CALLS and by the model's MID-RUN text, and there
 * is no receipt. A turn that answers
 * quickly costs ONE message — the answer; "收到，开始处理。" on every message
 * doubled the cost of every quick answer while telling the reader nothing the
 * answer did not. What the peer hears in between is the work itself: the tools
 * that are running, coalesced into one line per interval.
 *
 * Tool names are the useful unit of progress (they say what the agent is doing),
 * and they are cheap to coalesce: several tools starting inside one interval become
 * one line rather than several messages.
 */

/** Minimum gap between two narration messages. */
export const PROGRESS_MIN_INTERVAL_MS = 4_000;
/**
 * Hard cap on narration messages per turn, the final answer excluded.
 *
 * Kept at or below the outbox's narration allowance, because this relay is the
 * only thing that narrates on its own schedule rather than on a real event: if
 * it may spend more than the allowance, it fills the budget before a receipt or
 * a card is even built. `NARRATION_ALLOWANCE` is 2, so this is 2.
 */
export const PROGRESS_MAX_UPDATES = 2;
/** How many tool names one coalesced line may list before it abbreviates. */
const TOOLS_PER_LINE = 6;
/**
 * 一轮跑完却没有一句要说的文本时，对端听到的那句兜底话。
 *
 * 单独导出：`peers.ts` 判到「无文本可回」时把它**当作这一轮的答案返回**（走答案的
 * 配额与「落地后才清扫」的顺序），兜底文案因此必须只有一份，不能在这里再写一遍。
 */
export const EMPTY_TURN_LINE = '（本轮没有要说的文本，工作已完成。）';

export interface ProgressRelayOptions {
  /** Where one line goes (the passive-window sender). Absent = nothing is sent. */
  send: (text: string) => void;
  minIntervalMs?: number;
  maxUpdates?: number;
  /** Injected clock, so the throttle is testable without waiting. */
  now?: () => number;
}

/**
 * One turn's outward narration.
 *
 * Every method is fire-and-forget: a chat that cannot be reached must never fail
 * the turn it is describing. Nothing here awaits, and nothing throws.
 */
export class ProgressRelay {
  private readonly send: (text: string) => void;
  private readonly minIntervalMs: number;
  private readonly maxUpdates: number;
  private readonly now: () => number;
  private updatesSent = 0;
  private lastSentAt: number;
  /** Tool names seen since the last flush. */
  private pendingTools: string[] = [];
  /** The newest mid-run assistant text since the last flush (newest wins). */
  private pendingText: string | undefined;
  /** The text the last emit carried, so the final answer is never doubled. */
  private lastEmitted: string | undefined;
  /** Whether anything worth saying is buffered. */
  private dirty = false;

  constructor(options: ProgressRelayOptions) {
    this.send = options.send;
    this.minIntervalMs = options.minIntervalMs ?? PROGRESS_MIN_INTERVAL_MS;
    this.maxUpdates = options.maxUpdates ?? PROGRESS_MAX_UPDATES;
    this.now = options.now ?? Date.now;
    // Baselines the gap, so the FIRST narration also waits a full interval: starting
    // it at 0 made the first flush immediate (any real clock is far past zero), so a
    // turn that called a tool right away spoke inside the very window the throttle
    // exists to keep to one message.
    this.lastSentAt = this.now();
  }

  /** One tool call started; coalesced into the next flush. */
  tool(name: string): void {
    if (name.length === 0) return;
    this.pendingTools.push(name);
    this.dirty = true;
    this.flush();
  }

  /**
   * One mid-run assistant text; coalesced into the next flush, newest wins.
   *
   * The model's interstitial narration ("已完成分析，开始抓正文") is the part a
   * phone reader actually wants — tool NAMES alone say that something runs, not
   * what was concluded. It rides the SAME budget as the tool lines: same
   * interval, same per-turn cap.
   *
   * 答案不走这里，所以「同一句话既当叙述又当答案」不是靠去重躲开的：模型若把最后
   * 那句原话提前说过一遍，两处都会发出，而且**两条都留着**——没有撤回机制（见
   * `outbox.ts`），读者看过的消息就一直在那里。
   */
  text(body: string): void {
    const trimmed = body.trim();
    if (trimmed.length === 0 || trimmed === this.pendingText || trimmed === this.lastEmitted) return;
    this.pendingText = trimmed;
    this.dirty = true;
    // Deliberately NO immediate flush. The last assistant text of a turn becomes
    // the REPLY, which the caller sends (as a markdown card); flushing it here
    // first would deliver the same words twice — once plain, once rendered.
    // Buffered text still goes out: the next tool call (or the next text) flushes
    // it, so genuine mid-run narration is unaffected and only the FINAL text,
    // which nothing follows, stays buffered for the reply to carry.
  }

  /**
   * The turn is over. Nothing to do: the ANSWER does not travel through here.
   *
   * 这里曾经有一个 `final(text)`，它想保证「最后一条一定是答案」，还带一份与已叙述
   * 文本去重的逻辑。它从来没有被接线过（`git log -S 'relay.final'` 在本仓库里没有
   * 任何一条命中），而它想保证的那件事现在由答案那条路自己保证：正文由 `peers.ts`
   * **返回**给通道的回复座位（花的是为答案留的配额），落地之后才清扫过程碎片。
   * 留着一个没人调的 `final` 只会让「答案怎么送达」有两种说法。
   */

  /** Flush buffered narration if the interval has passed and budget remains. */
  private flush(): void {
    if (!this.dirty) return;
    if (this.updatesSent >= this.maxUpdates) return;
    if (this.now() - this.lastSentAt < this.minIntervalMs) return;
    // Mid-run TEXT outranks tool names: it says what was CONCLUDED, which is
    // what the reader is waiting for. Names still buffered ride the next flush.
    if (this.pendingText !== undefined) {
      const text = this.pendingText;
      this.pendingText = undefined;
      this.spend(text);
      return;
    }
    const tools = this.pendingTools.splice(0, this.pendingTools.length);
    if (tools.length === 0) {
      this.dirty = false;
      return;
    }
    const line = describeTools(tools);
    if (line === this.lastEmitted) {
      // 同一句话不连发第二遍。实测：一次「你对我有什么记忆」连调两次 recall，聊天里
      // 出现两条一模一样的「正在：recall」—— 读者学不到任何东西，却要多收一条消息、
      // 多花一格叙述额度。工具名相同就是同一句话（`describeTools` 是纯函数），所以
      // 这层去重是精确的，不是「看起来像就丢」。额度与时间戳都不动，那一格留给真正
      // 有话说的时候。
      this.dirty = false;
      return;
    }
    this.spend(line);
  }

  /**
   * One update out, paying for it: the budget and the interval both move.
   *
   * 只有真正说出**新东西**才走到这里（见 `flush` 的重复判定）。
   */
  private spend(text: string): void {
    this.updatesSent += 1;
    this.lastSentAt = this.now();
    this.dirty = false;
    this.emit(text);
  }

  /** One line out, with any transport failure absorbed (see the class comment). */
  private emit(text: string): void {
    this.lastEmitted = text;
    try {
      this.send(text);
    } catch {
      // A chat that cannot be reached must never fail the turn it describes.
    }
  }
}

/** `正在：a、b、c（还有 2 个）` — one line, never a wall of names. */
function describeTools(tools: string[]): string {
  const shown = tools.slice(0, TOOLS_PER_LINE);
  const rest = tools.length - shown.length;
  return `正在：${shown.join('、')}${rest > 0 ? `（还有 ${rest} 个）` : ''}`;
}
