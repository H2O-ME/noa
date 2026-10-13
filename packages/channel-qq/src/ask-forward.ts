/**
 * A pending ask's **push + fallback**: send it to QQ and arm a must-settle timer.
 *
 * Approvals and questions are different conversations with the human but the SAME
 * lifecycle, and that is why they share this file rather than each carrying a copy:
 *
 *  - the peer answers by sending a LATER message, so nothing here is awaited —
 *    this half only asks, and the answer arrives through `inbound`'s bypass;
 *  - a peer who never answers must still converge, so a timer settles it on their
 *    behalf. What "settle" means differs (an approval is DENIED, a question is
 *    CANCELLED), so the action is passed in rather than hard-coded — but the
 *    timing, the bookkeeping and the teardown are one implementation.
 *
 * A copy per ask kind is how one of them ends up without a fallback, which is
 * exactly the defect this shape prevents: an ask that waits forever parks the whole
 * run, and a QQ peer can always walk away mid-task.
 */
import { oneLineText, type AgentSession } from '@noa/core';
import type { Peer } from './types.js';
import type { RichSend } from './protocol.js';
import { questionKeyboard, renderQuestions } from './question-reply.js';
import { REMOTE_APPROVAL_TIMEOUT_MS } from './remote.js';
import type { PeerNotifier } from './peers.js';

/** How long a remote question waits for prose before it is cancelled. */
export const REMOTE_QUESTION_TIMEOUT_MS = 10 * 60_000;

/**
 * One outstanding ask, from "sent to QQ" to "answered, cancelled or timed out".
 *
 * Keyed by the kernel's request id, which is what the answer comes back with.
 */
export class PendingAsks {
  /** Each peer's UNANSWERED ask timer (the kernel serializes asks per session). */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The ask behind each id, so `/approve` and `/answer` can name what they settle. */
  private readonly pending = new Map<string, { peer: Peer; settle: () => void }>();

  constructor(private readonly notify: PeerNotifier = () => undefined) {}

  /**
   * Push one approval request to QQ and arm its must-deny timer.
   * @param agent - the session waiting on this approval.
   * @param peer - who to ask.
   * @param request - the kernel's approval request.
   */
  forwardApproval(agent: AgentSession, peer: Peer, request: { id: string; call: { name: string; args?: Record<string, unknown> }; preview?: readonly string[] }): void {
    const lines = [`**需要审批：${request.call.name}**`];
    // WHAT is being approved, not just WHICH tool: a chat peer cannot see the
    // desktop, so "bash" alone asks them to authorize blind. The kernel's
    // preview lines (edit diffs, a bash command) when the tool declares them;
    // otherwise the call's own arguments, capped — a rough but honest fallback.
    const preview = request.preview !== undefined && request.preview.length > 0
      ? request.preview.slice(0, 20)
      : [oneLineText(JSON.stringify(request.call.args ?? {})).slice(0, 300)];
    // 块引用整块承载预览：每行单独包反引号会各成一个段落，卡片里就多出空行。
    lines.push(...preview.map((line) => `> ${line}`));
    lines.push('回复 /approve 允许，或 /deny 拒绝（超时将自动拒绝）；也可以点下面的按钮。');
    // 按钮 = 指令按钮：点击即以点击者身份发出 `/approve` / `/deny`，与文本殊途同归。
    // `allowIds` 只放行收卡的对端本人——一张群里所有人可见的卡，不该谁都能批。
    const rich: RichSend = {
      markdown: lines.join('\n'),
      keyboard: {
        rows: [[
          { label: '允许', kind: 'command', data: '/approve' },
          { label: '拒绝', kind: 'command', data: '/deny' },
        ]],
      },
      ...(peer.actorId.length > 0 ? { allowIds: [peer.actorId] } : {}),
    };
    this.ask(request.id, peer, lines.join('\n'), REMOTE_APPROVAL_TIMEOUT_MS, () => {
      // `resolveApproval` returns false for a settled id, so the fallback is a
      // harmless duplicate attempt rather than a second decision.
      agent.resolveApproval(request.id, { answer: 'deny', reason: 'QQ 对端超时未答复，按拒绝处理' });
      this.notify(peer, `审批超时（${Math.round(REMOTE_APPROVAL_TIMEOUT_MS / 1000)} 秒未回复），已按拒绝处理：${request.call.name}`);
    }, rich);
  }

  /**
   * Push one `ask_user_question` batch to QQ and arm its must-cancel timer.
   *
   * The batch goes out as a card: the numbered text, and the options as one-tap
   * buttons when a single question can carry them (`questionKeyboard`). A peer who
   * types instead is served by the prose lane — see `answerPendingQuestion`, and
   * `PeerTurns.awaitingQuestion` for why such a message must skip the queue.
   *
   * Cancelling (rather than inventing an answer) is the fail-closed direction: an
   * invented answer would be attributed to the peer and could send the run down a
   * path they never chose, while a cancellation tells the model plainly that
   * nobody answered.
   * @param agent - the session waiting on this question.
   * @param peer - who to ask.
   * @param request - the kernel's question request.
   */
  forwardQuestion(agent: AgentSession, peer: Peer, request: { id: string; questions: readonly import('@noa/core').AskUserQuestionItem[] }): void {
    const body = renderQuestions(request.questions);
    const keyboard = questionKeyboard(request.questions);
    // 按钮 = 指令按钮：点击即以点击者身份发出 `/answer <n>`，与手打编号殊途同归。
    // `allowIds` 只放行收卡的对端本人——群里一张所有人都看得见的卡，不该谁都能答。
    const rich: RichSend = {
      markdown: body,
      ...(keyboard !== undefined ? { keyboard } : {}),
      ...(peer.actorId.length > 0 ? { allowIds: [peer.actorId] } : {}),
    };
    this.ask(request.id, peer, body, REMOTE_QUESTION_TIMEOUT_MS, () => {
      agent.cancelQuestion(request.id);
      this.notify(peer, `提问超时（${Math.round(REMOTE_QUESTION_TIMEOUT_MS / 60_000)} 分钟未回复），已取消。`);
    }, rich);
  }

  /** The ask behind one id, when it is still outstanding (used for the reply text). */
  outstanding(id: string): { peer: Peer } | undefined {
    return this.pending.get(id);
  }

  /** The ask has a verdict: stand the fallback down. */
  settled(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    this.pending.delete(id);
  }

  /**
   * Drop every outstanding timer.
   *
   * The channel is a plugin now, so switching its row off must leave nothing
   * running: a must-settle timer surviving its fiber would fire into a session
   * nobody is serving, and would be exactly the "remembered teardown" this
   * refactor removes. The peer's own ask is left to the session's teardown.
   */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  /** Send one ask and arm its timer. The one place the lifecycle is expressed. */
  private ask(id: string, peer: Peer, text: string, timeoutMs: number, onTimeout: () => void, rich?: RichSend): void {
    this.notify(peer, text, rich);
    this.pending.set(id, { peer, settle: onTimeout });
    this.timers.set(id, setTimeout(() => {
      this.settled(id);
      onTimeout();
    }, timeoutMs));
  }
}
