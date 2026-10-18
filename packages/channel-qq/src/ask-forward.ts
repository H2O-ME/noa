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
 * One ask's send-and-fallback inputs, so the lifecycle below reads as one story.
 *
 * The wording lives here (at the call site that knows what the ask is about) and
 * the timing, bookkeeping and teardown live in `ask` — that split is the point:
 * two asks that each own their own timer is how one of them ends up waiting
 * forever.
 */
interface PendingAskSpec {
  peer: Peer;
  /** 推出去的那条（审批/提问卡片）。 */
  text: string;
  rich?: RichSend;
  timeoutMs: number;
  /**
   * 没人答复时怎么收敛（审批=拒绝，提问=取消）。`why` 让理由如实：这个理由会进工具
   * 结果、被模型转述给读者，而「卡片没发出去」不是对端的错。
   */
  settle: (why: 'timeout' | 'undelivered', reason?: string) => void;
  /**
   * 等够了之后对读者说的那句话。**只有超时这一种**：卡片压根没发出去时，解释走不了
   * 这条路（见 `ask`），它改走工具结果 + 模型的回复。
   */
  timeoutNote: string;
}

/**
 * One outstanding ask, from "sent to QQ" to "answered, cancelled or timed out".
 *
 * Keyed by the kernel's request id, which is what the answer comes back with.
 */
export class PendingAsks {
  /** Each peer's UNANSWERED ask timer (the kernel serializes asks per session). */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

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
    const seconds = Math.round(REMOTE_APPROVAL_TIMEOUT_MS / 1000);
    this.ask(request.id, {
      peer,
      text: lines.join('\n'),
      rich,
      timeoutMs: REMOTE_APPROVAL_TIMEOUT_MS,
      settle: (why, reason) => {
        // `resolveApproval` returns false for a settled id, so the fallback is a
        // harmless duplicate attempt rather than a second decision. The REASON
        // matters as much as the verdict: it rides into the tool result the model
        // reads, and "the peer timed out" is a lie when the card never went out —
        // the model repeated exactly that back to the peer.
        agent.resolveApproval(request.id, {
          answer: 'deny',
          reason: why === 'timeout'
            ? 'QQ 对端超时未答复，按拒绝处理'
            : `审批卡没能发到聊天里（${reason ?? '未知原因'}），这一轮没有等到答复`,
        });
      },
      timeoutNote: `审批超时（${seconds} 秒未回复），已按拒绝处理：${request.call.name}`,
    });
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
    const minutes = Math.round(REMOTE_QUESTION_TIMEOUT_MS / 60_000);
    this.ask(request.id, {
      peer,
      text: body,
      rich,
      timeoutMs: REMOTE_QUESTION_TIMEOUT_MS,
      settle: (why, reason) => {
        // The approval path above has always passed its reason through; this one
        // dropped it, so a card that never reached the chat was reported to the
        // model as `ASK_CANCELLED` — "the user cancelled" — and the model relayed
        // exactly that to a peer who had never been shown a question. Observed
        // live. A reason here makes it `ASK_UNDELIVERED` instead: nobody was
        // asked, and that is what the model must say.
        agent.cancelQuestion(request.id, why === 'timeout' ? undefined : (reason ?? '未知原因'));
      },
      timeoutNote: `提问超时（${minutes} 分钟未回复），已取消。`,
    });
  }

  /** The ask has a verdict: stand the fallback down. */
  settled(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
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
  }

  /**
   * Send one ask and arm its timer. The one place the lifecycle is expressed.
   *
   * A card that did NOT go out settles immediately instead of arming the timer:
   * the timer exists to bound how long a peer may take to answer, and a peer who
   * was never asked has nothing to answer. Waiting anyway costs the run its whole
   * turn and then reports a timeout the peer cannot make sense of.
   *
   * **Nothing is sent to explain it.** Whatever refused the card — an exhausted
   * interaction allowance, no live passive window — refuses a narration for the
   * same reason, so the explanation would be dropped too; sending it anyway only
   * produced a log line claiming the peer had been told. It rides the TOOL RESULT
   * instead: `settle` hands the reason to the kernel, the model reads it, and the
   * model's reply has a reserved slot to explain in. That path also reaches a
   * reader who is holding a phone with no other way to find out.
   */
  private ask(id: string, spec: PendingAskSpec): void {
    const pushed = this.notify(spec.peer, spec.text, spec.rich, 'interaction');
    if (pushed !== undefined && !pushed.ok) {
      spec.settle('undelivered', pushed.reason);
      return;
    }
    this.timers.set(id, setTimeout(() => {
      this.settled(id);
      spec.settle('timeout');
      this.notify(spec.peer, spec.timeoutNote);
    }, spec.timeoutMs));
  }
}
