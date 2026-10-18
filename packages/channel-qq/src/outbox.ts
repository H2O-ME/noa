/**
 * The one way anything goes OUT to QQ.
 *
 * Every outbound message in this package used to pick its own path — the inbound
 * reply, the approval notice, the progress relay — and each independently asked for
 * the passive window and sent. That is three copies of the same three rules, and
 * the rules are exactly the ones that bite:
 *
 *  - **which `msg_id`** the send belongs to. The platform only allows replying to
 *    the most recent inbound message, so a send without a live window must fail
 *    rather than become an unauthorized proactive message that the platform
 *    throttles or rejects.
 *  - **how many times** one inbound message may be answered. This is the scarce
 *    resource: the platform bounds replies per `msg_id`, and one message per tool
 *    call would spend the whole allowance before the agent had anything to say.
 *  - **who wins** when the allowance runs out. The conclusion is what was asked
 *    for; narration is what may be dropped — so narration is capped BELOW the
 *    allowance, keeping a reply's worth in reserve. An approval or question card
 *    is neither: the turn is stopped on it, so it outranks narration (see
 *    `NoticeKind`) while still respecting the same reserve.
 *
 * The ledger is therefore keyed by `msg_id` and shared by every caller, which is
 * the only way those three answers can be consistent with each other.
 *
 * **Nothing here is ever recalled.** The platform offers a two-minute recall and
 * this outbox used to spend it: narration went out during a turn and was taken back
 * once the answer landed, so the transcript kept the conclusion and not the
 * scaffolding. That reads as messages vanishing on their own — the hardest thing to
 * explain to someone holding a phone — and it deletes the only record the peer has
 * when the answer's own send then fails. Hermes Agent's QQ adapter never recalls
 * anything; what it does for "still working" is the platform's typing indicator,
 * which is not a message at all. So here: a sent message is final.
 *
 * The per-window allowance is a deliberate guess: the platform documents a limit
 * but the exact number is not verifiable from here (no credentials, no live
 * account). It is therefore a named constant, comfortably conservative, and the
 * failure mode when it is wrong is a dropped narration line rather than a lost
 * answer.
 */
import { bareImageUrl, type RichSend } from './protocol.js';

/** How many messages one inbound `msg_id` may draw in total. */
export const WINDOW_ALLOWANCE = 5;
/**
 * How many of those narration may spend. The rest is RESERVED for the reply:
 * `WINDOW_ALLOWANCE - NARRATION_ALLOWANCE` is the reply's guarantee, and it is
 * why the split exists rather than one shared counter.
 */
export const NARRATION_ALLOWANCE = 3;

/**
 * What one outbound notice IS — and therefore who wins when the budget is short.
 *
 *  - `narration`: progress lines and receipts. Droppable by design; a peer who
 *    loses one has lost a "still working" line and nothing else.
 *  - `interaction`: a card the turn is BLOCKED on (an approval, a question). It
 *    must not compete with narration for the narration cap, because progress can
 *    spend that whole cap before the card is even built — `PROGRESS_MAX_UPDATES`
 *    and `NARRATION_ALLOWANCE` are both 3, so every turn that touches three tools
 *    starved its own approval card. Observed live: the card was refused, nothing
 *    was logged, no button ever appeared in the chat, and the approval died on its
 *    three-minute timer reporting "the peer did not answer" — a peer who was never
 *    asked. An interaction still spends from the WINDOW ledger, because the
 *    platform's own bound is the one that cannot be exceeded.
 */
export type NoticeKind = 'narration' | 'interaction';


/** What one send attempt ended as. */
export interface OutboxResult {
  ok: boolean;
  /** Why it did not go, in terms an operator can act on. */
  reason?: string;
}

export interface QqOutboxOptions {
  /** The transport: `msgId` is the passive window the send answers. */
  send: (peerId: string, content: string, msgId?: string, rich?: RichSend) => Promise<string[]>;
  /** The live passive window for one peer, if any. */
  lastMsgIdOf: (peerId: string) => string | undefined;
  /**
   * 本地媒体识别：内容里出现真实存在的本地图片/视频/语音路径时给出候选。
   * 由持有 fs 的一侧注入（本模块不做 IO）。
   */
  localMedia?: (content: string) => { fileType: 1 | 2 | 3 | 4; path: string } | undefined;
  log?: (line: string) => void;
  windowAllowance?: number;
  narrationAllowance?: number;
}

/** One inbound message's spending so far. */
interface WindowLedger {
  used: number;
  /** The peer this window belongs to, so a mismatch is caught rather than sent. */
  peerId: string;
}

export class QqOutbox {
  private readonly send: QqOutboxOptions['send'];
  private readonly lastMsgIdOf: QqOutboxOptions['lastMsgIdOf'];
  private readonly localMedia: QqOutboxOptions['localMedia'];
  private readonly log: (line: string) => void;
  private readonly windowAllowance: number;
  private readonly narrationAllowance: number;
  private readonly ledgers = new Map<string, WindowLedger>();

  constructor(options: QqOutboxOptions) {
    this.send = options.send;
    this.lastMsgIdOf = options.lastMsgIdOf;
    this.localMedia = options.localMedia;
    this.log = options.log ?? (() => undefined);
    this.windowAllowance = options.windowAllowance ?? WINDOW_ALLOWANCE;
    this.narrationAllowance = options.narrationAllowance ?? NARRATION_ALLOWANCE;
  }

  /**
   * Narration: a receipt, a progress line, a timeout notice. Or, with
   * `kind: 'interaction'`, a card the turn is waiting on (see `NoticeKind`).
   *
   * Refused (and logged) once that class's allowance is spent, so the reply's
   * reserve survives. Never throws, never awaits: this runs inside a turn's event
   * loop, and a chat that cannot be reached must not fail the work it describes.
   * @param peerId - `group:<id>` / `c2c:<id>`.
   * @param content - the text.
   * @param rich - markdown/keyboard payload, when the message has one.
   * @param kind - narration (droppable) or interaction (the turn is blocked on it).
   * @returns whether it went out. Callers that are BLOCKED on the message must
   * read this — a card nobody received is a run parked on a question never asked.
   */
  narrate(peerId: string, content: string, rich?: RichSend, kind: NoticeKind = 'narration'): OutboxResult {
    const window = this.lastMsgIdOf(peerId);
    if (window === undefined) return { ok: false, reason: 'no live passive-reply window for this peer' };
    const ledger = this.ledgerFor(window, peerId);
    const allowance = this.allowanceFor(kind);
    if (ledger.used >= allowance) {
      return { ok: false, reason: `${kind} allowance spent for this message (${allowance})` };
    }
    ledger.used += 1;
    // 即发即忘，而且**发出之后就不再碰它**：没有撤回，所以既不需要记住消息 id，也
    // 不需要世代来分辨「这条是答案之前还是之后落地的」。读者看过的消息就留在那里。
    void this.dispatch(peerId, content, window, rich).catch((err: unknown) => {
      this.log(`qqbot: ${kind} send failed for ${peerId}: ${String(err)}`);
    });
    return { ok: true };
  }

  /**
   * How much one class may spend in this window.
   *
   * Both leave the reply its slot — that is the invariant, not the numbers. They
   * differ in how much slack they take: narration is droppable and is kept to the
   * lower cap, while an interaction may spend everything but the reply's slot,
   * because refusing a card costs the run its whole turn.
   */
  private allowanceFor(kind: NoticeKind): number {
    return kind === 'interaction' ? this.windowAllowance - 1 : this.narrationAllowance;
  }

  /**
   * The reply to an inbound message: it may spend the reserve narration left.
   *
   * Awaited by the caller because the inbound handler reports whether a reply
   * actually went out, and because the platform's answer is the only proof it did.
   * @param peerId - `group:<id>` / `c2c:<id>`.
   * @param content - the text.
   * @returns whether it went out, or why not.
   */
  async reply(peerId: string, content: string, rich?: RichSend): Promise<OutboxResult> {
    // 纯文本回复不能是空的；但**带媒体**的回复可以是（正文就是那张图/那个文件）。
    if (content.trim().length === 0 && rich === undefined) return { ok: false, reason: 'nothing to say' };
    const window = this.lastMsgIdOf(peerId);
    if (window === undefined) return { ok: false, reason: 'no live passive-reply window for this peer' };
    const ledger = this.ledgerFor(window, peerId);
    if (ledger.used >= this.windowAllowance) {
      // The reserve is gone too: the platform's own bound is what is left, and
      // sending into it fails at the platform rather than here. Refusing is the
      // honest report; the text is already durable in the session log, so nothing
      // is lost that `/history` cannot reach.
      return { ok: false, reason: `reply allowance spent for this message (${this.windowAllowance})` };
    }
    ledger.used += 1;
    try {
      await this.dispatch(peerId, content, window, rich);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `send failed: ${String(err)}` };
    }
  }

  /**
   * One send, with the rich/媒体 fallback folded in.
   *
   * 媒体（裸图片 URL）发送失败时回落纯文本：URL 不会因为平台拒收就消失，它还在
   * 文本里，读者最多多点一下。这正是 `rich` 存在的底线——样式可以输，内容不能丢。
   */
  private async dispatch(peerId: string, content: string, window: string, rich?: RichSend): Promise<string[]> {
    const image = rich === undefined ? bareImageUrl(content) : undefined;
    if (image !== undefined) {
      try {
        return await this.send(peerId, '', window, { file: image });
      } catch (err) {
        this.log(`qqbot: media send failed for ${peerId}, falling back to text: ${String(err)}`);
      }
    }
    // 本地文件走另一条上传路径（分片上传），但同一条底线：发不出去时文本还在。
    // 文本随文件一起发：读者要的是那张图，也需要那句「这是什么」。
    const local = rich === undefined && this.localMedia !== undefined ? this.localMedia(content) : undefined;
    if (local !== undefined) {
      try {
        return await this.send(peerId, content, window, { localFile: local });
      } catch (err) {
        this.log(`qqbot: local media send failed for ${peerId}, falling back to text: ${String(err)}`);
      }
    }
    return await this.send(peerId, content, window, rich);
  }

  /** The window's ledger, created on first use and dropped when the window moves on. */
  private ledgerFor(window: string, peerId: string): WindowLedger {
    const existing = this.ledgers.get(window);
    if (existing !== undefined && existing.peerId === peerId) return existing;
    const created: WindowLedger = { used: 0, peerId };
    this.ledgers.set(window, created);
    // Bounded: a window only matters while it is the live one, and old keys are
    // unreachable. Pruning on insert keeps a long-running channel from growing one
    // entry per inbound message forever.
    if (this.ledgers.size > 512) {
      const oldest = this.ledgers.keys().next().value;
      if (oldest !== undefined) this.ledgers.delete(oldest);
    }
    return created;
  }
}
