/**
 * 会话回退：**哪几轮丢掉**，以及**丢的那一轮是从哪句话开始的**。
 *
 * 一个纯函数，因为「一轮」这件事必须能被穷举驱动：`/undo` 与 `/retry` 都只是它的
 * 两种取用方式（前者要丢掉的结果，后者还要重发被丢掉那句提示词），而回退本身的正确性
 * 与网络、与会话文件、与模型都无关。
 *
 * ## 为什么按「轮」切，而不是按「几条消息」
 *
 * 模型面是一条**扁平**的消息序列，但它的形状是有约束的：一条带 `tool_calls` 的助手消息
 * 必须跟着它每一个调用的结果，严格一点的端点会直接拒收缺结果的面。所以切点只能落在
 * **一轮的开头**——即一条真实的用户提示词上。轮内的一切（助手文本、工具调用、工具结果）
 * 都是它的响应子树，跟着它一起走，于是「工具结果绝不比索要它的那条助手消息活得久」
 * 是这条切法**结构上**保证的，而不是靠事后再修。
 *
 * 与 `compact.ts` 的 `selectRecentMessages` 是同一条纪律的两面：那边按字符预算挑保留的
 * 消息，**纯文本助手消息**之外一律不单独保留（工具调用消息必须连结果一起）；这边按轮
 * 切，于是天然成对。两边都在同一个地方守卫「模型看得见的必须是日志里有的」。
 */
import { isAbortMarker } from '../agent/options.js';
import { isCompactSummary } from '../compact.js';
import { isContextFragment } from '../context-fragment.js';
import type { AgentMessage, UserMessage } from '../types.js';

/**
 * A cut already decided, but not yet applied: what survives, how much was
 * removed, and which prompt the removed part began with.
 */
export interface TurnRewind {
  /** Ids that stay on the surface — a prefix of it, in surface order. */
  readonly keepIds: string[];
  /** How many turns the cut removes (never more than the surface holds). */
  readonly dropped: number;
  /**
   * The user message that opened the LAST dropped turn.
   *
   * Carried because `/retry` is exactly "undo this turn, then say that again":
   * re-reading it from the log afterwards would have to search for a message the
   * surface no longer holds, which is the kind of second lookup that drifts.
   */
  readonly prompt: UserMessage;
}

/**
 * Plan dropping the last `turns` turns.
 *
 * A turn OPENS at a real user prompt. Three kinds of `user`-role message are NOT
 * one, and each for its own reason: a context fragment is injected scaffolding
 * (never a turn), a compaction summary is a synthesized stand-in for turns that
 * are already gone, and an abort marker records a cancelled turn rather than
 * opening a new one. Treating any of them as a boundary would cut in the middle
 * of the subtree that actually needs to move.
 * @param messages - the surface in force.
 * @param turns - how many turns to drop; clamped to what exists.
 * @returns the cut, or undefined when the surface holds no turn to drop.
 */
export function planTurnRewind(messages: readonly AgentMessage[], turns: number): TurnRewind | undefined {
  if (!Number.isInteger(turns) || turns < 1) return undefined;
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (opensTurn(msg)) starts.push(i);
  }
  const last = starts.at(-1);
  if (last === undefined) return undefined;
  // Clamped rather than refused: `/undo 99` on a two-turn conversation means
  // "drop what there is", and refusing would make the peer count turns to find
  // the largest accepted number. The reported `dropped` says what actually went.
  const from = Math.max(0, starts.length - turns);
  const cut = starts[from]!;
  return {
    keepIds: messages.slice(0, cut).map((msg) => msg.id),
    dropped: starts.length - from,
    prompt: messages[last] as UserMessage,
  };
}

/**
 * Whether one message OPENS a turn (see `planTurnRewind` for the three
 * exceptions and why each is one).
 * @param msg - the candidate.
 * @returns true when a cut may land here.
 */
function opensTurn(msg: AgentMessage): boolean {
  if (msg.role !== 'user') return false;
  return !isContextFragment(msg) && !isCompactSummary(msg) && !isAbortMarker(msg);
}
