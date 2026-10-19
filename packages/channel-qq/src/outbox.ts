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
 * How many of those narration may spend.
 *
 * Kept at or below `WINDOW_ALLOWANCE - 1 - INTERACTION_ALLOWANCE` so narration
 * can never be the reason a card is refused. The two caps are enforced against
 * separate counters (see `WindowLedger`) — a shared counter with a per-kind
 * threshold looks like a split but is not one, and that is exactly how this
 * allowance used to eat the interactions' share.
 */
export const NARRATION_ALLOWANCE = 2;
/**
 * How many of those an interaction (an approval card, a question card) may
 * spend — and, because it is the same number, how many slots narration must
 * leave free.
 *
 * Two is what one turn actually needs: an approval and the question that
 * follows it. A turn that wants more than that is a turn doing too much at
 * once, and the honest outcome is the second card being refused LOUDLY (see
 * `ask-forward.ts`) rather than silently.
 */
export const INTERACTION_ALLOWANCE = 2;

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
 *
 * That last paragraph described the fix but not the code: narration and
 * interaction incremented ONE counter and merely compared it against different
 * thresholds, so narration spending its cap still pushed the interaction's
 * threshold out of reach. Observed live again, one release later: `interaction
 * not sent … allowance spent for this message (4)` — a question card refused, and
 * the peer told (by the model, faithfully relaying the kernel) that they had
 * cancelled a question they were never shown. They are separate counters now, and
 * narration is additionally capped so it cannot reach the interaction reserve.
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
  interactionAllowance?: number;
}

/** One inbound message's spending so far. */
interface WindowLedger {
  /** Droppable lines sent. Capped so they cannot reach the interaction reserve. */
  narration: number;
  /** Cards the turn is blocked on. Capped by `INTERACTION_ALLOWANCE`. */
  interaction: number;
  /** Answers sent. Counted apart so a reply never consumes a card's allowance. */
  reply: number;
  /** The peer this window belongs to, so a mismatch is caught rather than sent. */
  peerId: string;
}

/** Everything this window has spent, which is what the platform's own bound counts. */
function spent(ledger: WindowLedger): number {
  return ledger.narration + ledger.interaction + ledger.reply;
}

export class QqOutbox {
  private readonly send: QqOutboxOptions['send'];
  private readonly lastMsgIdOf: QqOutboxOptions['lastMsgIdOf'];
  private readonly localMedia: QqOutboxOptions['localMedia'];
  private readonly log: (line: string) => void;
  private readonly windowAllowance: number;
  private readonly narrationAllowance: number;
  private readonly interactionAllowance: number;
  private readonly ledgers = new Map<string, WindowLedger>();

  constructor(options: QqOutboxOptions) {
    this.send = options.send;
    this.lastMsgIdOf = options.lastMsgIdOf;
    this.localMedia = options.localMedia;
    this.log = options.log ?? (() => undefined);
    this.windowAllowance = options.windowAllowance ?? WINDOW_ALLOWANCE;
    this.narrationAllowance = options.narrationAllowance ?? NARRATION_ALLOWANCE;
    this.interactionAllowance = options.interactionAllowance ?? INTERACTION_ALLOWANCE;
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
    const refusal = this.refuseReason(ledger, kind);
    if (refusal !== undefined) return { ok: false, reason: refusal };
    if (kind === 'interaction') ledger.interaction += 1;
    else ledger.narration += 1;
    // 即发即忘，而且**发出之后就不再碰它**：没有撤回，所以既不需要记住消息 id，也
    // 不需要世代来分辨「这条是答案之前还是之后落地的」。读者看过的消息就留在那里。
    void this.dispatch(peerId, content, window, rich).catch((err: unknown) => {
      this.log(`qqbot: ${kind} send failed for ${peerId}: ${String(err)}`);
    });
    return { ok: true };
  }

  /**
   * Whether this notice may go out, or why not.
   *
   * Three bounds, and the reason the two counters must stay separate:
   *
   *  - the class's own cap ({@link NARRATION_ALLOWANCE} / {@link
   *    INTERACTION_ALLOWANCE}) — what a class may spend at most;
   *  - the window's reserve for the reply, which nothing may touch;
   *  - for narration only, the interaction reserve. This is the bound that was
   *    missing: with one shared counter, narration spending its own cap still
   *    consumed the headroom a later card needed, so a turn that narrated three
   *    times refused its own question card.
   * @param ledger - the window's spending so far.
   * @param kind - which class this notice belongs to.
   * @returns the refusal reason, or undefined when it may go out.
   */
  private refuseReason(ledger: WindowLedger, kind: NoticeKind): string | undefined {
    const total = spent(ledger);
    const notices = this.windowAllowance - 1;
    if (kind === 'interaction') {
      if (ledger.interaction >= this.interactionAllowance) {
        return `interaction allowance spent for this message (${this.interactionAllowance})`;
      }
      if (total >= notices) return `reply reserve reached for this message (${this.windowAllowance})`;
      return undefined;
    }
    if (ledger.narration >= this.narrationAllowance) {
      return `narration allowance spent for this message (${this.narrationAllowance})`;
    }
    if (total >= notices - this.interactionAllowance) {
      return `narration would spend the interaction reserve for this message (${this.interactionAllowance} kept)`;
    }
    return undefined;
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
    if (spent(ledger) >= this.windowAllowance) {
      // The reserve is gone too: the platform's own bound is what is left, and
      // sending into it fails at the platform rather than here. Refusing is the
      // honest report, and the text is durable in the session log on the server.
      //
      // 拒绝不等于丢掉：**决定权在调用方**。入站处理器会把这一轮的结论寄存下来，等这个
      // 对端下一条消息把新的被动窗口带回来再补发（见 `inbound.ts` 的 `held`）。出站账本
      // 只管「这一条现在能不能发」，不管「这条消息还有没有别的去处」。
      return { ok: false, reason: `reply allowance spent for this message (${this.windowAllowance})` };
    }
    ledger.reply += 1;
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
    const created: WindowLedger = { narration: 0, interaction: 0, reply: 0, peerId };
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
