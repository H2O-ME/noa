/**
 * Real-time reporting of a running turn back to the chat.
 *
 * The point of driving a machine from a phone is that you find out what is
 * happening WITHOUT opening a laptop. A turn that reports only its final answer is
 * indistinguishable from one that hung, and a long agent run can spend minutes in
 * tools before it has anything to say.
 *
 * So progress is forwarded — but it is BUDGETED, because the platform is not a
 * stream:
 *
 *  - an outbound message here is a PASSIVE REPLY, tied to one inbound `msg_id` and
 *    answered with an incrementing `msg_seq`. The platform bounds how many replies
 *    one inbound message may draw, so a per-token stream would spend the whole
 *    allowance in the first second and then fail — losing exactly the final answer
 *    the operator was waiting for.
 *  - therefore: a bounded number of COALESCED updates, and a guarantee that the
 *    last one is always the answer.
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
/** Hard cap on narration messages per turn, the final answer excluded. */
export const PROGRESS_MAX_UPDATES = 3;
/** How many tool names one coalesced line may list before it abbreviates. */
const TOOLS_PER_LINE = 6;
/**
 * 一轮跑完却没有一句要说的文本时，对端听到的那句兜底话。
 *
 * 单独导出：调用方（`peers.ts`）判到「无文本可回」时得自己把这句话送出去——那时
 * 叙述继电器已经随观察者活在别处，兜底文案仍必须只有一份。
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
   * interval, same per-turn cap, and the final answer is deduped against what
   * went out here (a text already narrated must not arrive again as the reply).
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
   * The turn is over. Always reported: the answer is what was asked for, so it is
   * never dropped for budget's sake — an update no longer fits, the answer still
   * goes, and what is dropped is the narration.
   */
  final(text: string): void {
    const body = text.trim();
    if (body.length === 0) {
      // Silence is a legitimate outcome (a turn that only ran tools), but the peer
      // must never be left with NO reply at all: this line is the floor, and it
      // fires whether or not narration went out first.
      this.emit(EMPTY_TURN_LINE);
      return;
    }
    // Already narrated mid-run: sending it again would read as the model
    // repeating itself. What was flushed IS the answer.
    if (body === this.lastEmitted) return;
    this.emit(body);
  }

  /** Flush buffered narration if the interval has passed and budget remains. */
  private flush(): void {
    if (!this.dirty) return;
    if (this.updatesSent >= this.maxUpdates) return;
    if (this.now() - this.lastSentAt < this.minIntervalMs) return;
    this.dirty = false;
    this.updatesSent += 1;
    this.lastSentAt = this.now();
    // Mid-run TEXT outranks tool names: it says what was CONCLUDED, which is
    // what the reader is waiting for. Names still buffered ride the next flush.
    if (this.pendingText !== undefined) {
      const text = this.pendingText;
      this.pendingText = undefined;
      this.emit(text);
      return;
    }
    const tools = this.pendingTools.splice(0, this.pendingTools.length);
    this.emit(describeTools(tools));
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
