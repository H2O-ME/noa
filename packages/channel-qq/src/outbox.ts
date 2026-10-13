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
 *    resource: the platform bounds replies per `msg_id`, and a per-token stream
 *    would spend the whole allowance before the agent had anything to say.
 *  - **who wins** when the allowance runs out. The conclusion is what was asked
 *    for; narration is what may be dropped — so narration is capped BELOW the
 *    allowance, keeping a reply's worth in reserve.
 *
 * The ledger is therefore keyed by `msg_id` and shared by every caller, which is
 * the only way those three answers can be consistent with each other.
 *
 * The per-window allowance is a deliberate guess: the platform documents a limit
 * but the exact number is not verifiable from here (no credentials, no live
 * account). It is therefore a named constant, comfortably conservative, and the
 * failure mode when it is wrong is a dropped narration line rather than a lost
 * answer.
 */
import { isRecallExpired } from './api-error.js';
import { bareImageUrl, type RichSend } from './protocol.js';

/** How many messages one inbound `msg_id` may draw in total. */
export const WINDOW_ALLOWANCE = 5;
/**
 * How many of those narration may spend. The rest is RESERVED for the reply:
 * `WINDOW_ALLOWANCE - NARRATION_ALLOWANCE` is the reply's guarantee, and it is
 * why the split exists rather than one shared counter.
 */
export const NARRATION_ALLOWANCE = 3;

/** 平台的撤回时限（2 分钟）再收紧一点：边界上送出去的消息不值得赌。 */
const RECALL_WINDOW_MS = 100_000;


/** What one send attempt ended as. */
export interface OutboxResult {
  ok: boolean;
  /** Why it did not go, in terms an operator can act on. */
  reason?: string;
}

export interface QqOutboxOptions {
  /** The transport: `msgId` is the passive window the send answers. Returns the sent message ids (for recall). */
  send: (peerId: string, content: string, msgId?: string, rich?: RichSend) => Promise<string[]>;
  /** The live passive window for one peer, if any. */
  lastMsgIdOf: (peerId: string) => string | undefined;
  /** The recall transport (c2c `DELETE`); absent = narration is never swept. */
  recall?: (peerId: string, messageId: string) => Promise<void>;
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
  private readonly recall: QqOutboxOptions['recall'];
  private readonly localMedia: QqOutboxOptions['localMedia'];
  private readonly log: (line: string) => void;
  private readonly windowAllowance: number;
  private readonly narrationAllowance: number;
  private readonly ledgers = new Map<string, WindowLedger>();
  /**
   * Narration messages that may still be swept: once the ANSWER lands, the
   * progress fragments that led to it are noise. Keyed by peer, dropped after
   * the platform's recall window (~2 min) has certainly passed.
   */
  private readonly recallable = new Map<string, { id: string; at: number }[]>();

  constructor(options: QqOutboxOptions) {
    this.send = options.send;
    this.lastMsgIdOf = options.lastMsgIdOf;
    this.recall = options.recall;
    this.localMedia = options.localMedia;
    this.log = options.log ?? (() => undefined);
    this.windowAllowance = options.windowAllowance ?? WINDOW_ALLOWANCE;
    this.narrationAllowance = options.narrationAllowance ?? NARRATION_ALLOWANCE;
  }

  /**
   * Narration: a receipt, a progress line, an approval notice.
   *
   * Refused (and logged) once the narration allowance is spent, so the reply's
   * reserve survives. Never throws, never awaits: this runs inside a turn's event
   * loop, and a chat that cannot be reached must not fail the work it describes.
   * @param peerId - `group:<id>` / `c2c:<id>`.
   * @param content - the text.
   * @returns whether it went out.
   */
  narrate(peerId: string, content: string, rich?: RichSend): OutboxResult {
    const window = this.lastMsgIdOf(peerId);
    if (window === undefined) return { ok: false, reason: 'no live passive-reply window for this peer' };
    const ledger = this.ledgerFor(window, peerId);
    if (ledger.used >= this.narrationAllowance) {
      return { ok: false, reason: `narration allowance spent for this message (${this.narrationAllowance})` };
    }
    ledger.used += 1;
    const sentAt = Date.now();
    void this.dispatch(peerId, content, window, rich)
      .then((ids) => {
        const list = this.recallable.get(peerId) ?? [];
        for (const id of ids) {
          if (id.length > 0) list.push({ id, at: sentAt });
        }
        // Bounded: each entry lives at most one recall window past its send.
        this.recallable.set(peerId, list.filter((entry) => sentAt - entry.at < RECALL_WINDOW_MS));
      })
      .catch((err: unknown) => {
        this.log(`qqbot: narration send failed for ${peerId}: ${String(err)}`);
      });
    return { ok: true };
  }

  /**
   * 撤回这个对端**所有还没过平台时限的叙述消息**（进度碎片、已完结的审批卡）。
   * 正式回复落地后调用：过程线说完该消失，转录里留下答案而不是脚手架。
   * 尽力而为：单条失败只丢日志，绝不打扰其余的清扫。
   */
  drainRecallable(peerId: string): void {
    const list = this.recallable.get(peerId);
    this.recallable.delete(peerId);
    if (list === undefined || this.recall === undefined) return;
    const now = Date.now();
    for (const entry of list) {
      // 时限按**发出时刻**算，而一轮可以跑好几分钟：不在这里按年龄过一遍，就会拿
      // 几分钟前的消息去撤，换回一条必然的「已经超出消息撤回时限」。插入时筛过一次
      // 不顶用——那次是以**新条目**的时刻算的，挡不住「这之后就再没发过消息」。
      if (now - entry.at >= RECALL_WINDOW_MS) continue;
      void this.recall(peerId, entry.id).catch((err: unknown) => {
        // 时限已过是预期结果（本地时钟与平台时钟不可能完全对齐），不是要人处理的
        // 故障：它不该在日志里冒充告警。
        if (isRecallExpired(err)) return;
        this.log(`qqbot: recall failed for ${peerId}: ${String(err)}`);
      });
    }
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
