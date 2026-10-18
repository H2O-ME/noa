/**
 * 跑一次提示词，收敛到「这一轮结束」，返回要发回去的文本。
 *
 * 从对端编排（`peers.ts`）拆出，因为它是另一个问题：那边讲**谁跑哪一轮**（对端 →
 * 会话的编排：懒建、复用、激活、遥控旁路），这里讲**一轮内部怎么收尾**（订阅哪些事件、
 * 回复取哪条、失败怎么抛）。前者是路由，后者是单轮的执行语义。
 */
import type { AgentSession, KernelEvent } from '@noa/core';
import type { Peer, TurnInput } from './types.js';
import type { PendingAsks } from './ask-forward.js';

/**
 * What a turn reports WHILE it runs.
 *
 * Separate from the return value because the two answer different questions: the
 * return value is what the caller must deliver, this is what the peer should be
 * told in the meantime. A long run that says nothing is indistinguishable from a
 * hung one, and the person holding a phone has no other way to tell.
 *
 * Every method must be cheap and must not throw — it runs inside the run's event
 * loop, and a chat that cannot be reached must not fail the work it describes.
 */
export interface TurnObserver {
  /** A tool call began. The name is the useful unit: it says what is happening. */
  tool(name: string): void;
  /**
   * One MID-RUN assistant text. The model's interstitial narration ("已完成
   * 分析，开始抓正文") is what a phone reader actually wants between the prompt
   * and the answer; it rides the same budgeted narration line. The FINAL text is
   * the reply, and it is delivered by the caller through the reply seat — never
   * narrated, so the answer is not subject to the narration budget.
   */
  text(body: string): void;
}

/** What one turn produced: the last assistant text, plus how it was delivered. */
export interface TurnResult {
  /**
   * The LAST non-empty assistant message.
   *
   * The kernel logs every assistant message either way ("model-visible means
   * logged"), so this only fetches it for the wire, never for bookkeeping.
   */
  reply: string;
  /** 这一轮被打断（`turn_aborted`）：新消息到了，或有人 `/stop`——打断者已在路上。 */
  aborted?: boolean;
}

/**
 * Run one prompt on a peer's session, converging on "this turn is over".
 *
 * An approval raised mid-turn is forwarded to QQ (via `approvals`) rather
 * than auto-denied: the peer is right there in the chat window, they can
 * answer. `promptOnce` owns NOTHING else — the subscription is per turn and
 * released at idle, so no listener outlives its round.
 * @param agent - this peer's session.
 * @param asks - the pending-ask ledger (its fallback settles each on timeout).
 * @param turn - the inbound turn: text plus any images the operator attached.
 * @param peer - who asked.
 * @param observer - progress reporting for the duration of this turn, if any.
 * @returns the reply the caller must deliver.
 */
export async function promptOnce(
  agent: AgentSession,
  asks: PendingAsks,
  turn: TurnInput,
  peer: Peer,
  observer?: TurnObserver,
): Promise<TurnResult> {
  let reply = '';
  let aborted = false;
  let failure: string | undefined;
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = agent.subscribe((event: KernelEvent) => {
      if (event.type === 'message' && event.message.role === 'assistant' && event.message.content.trim().length > 0) {
        // Every assistant text is BOTH a narration candidate and the running
        // reply. The relay only narrates a text once something LATER flushes it
        // (a tool call, or another text), so the last text — the answer — stays
        // buffered and is delivered once, by the reply seat.
        const body = event.message.content.trim();
        reply = body;
        try {
          observer?.text(body);
        } catch {
          // Progress reporting is never allowed to break the run it describes.
        }
      } else if (event.type === 'tool_call_start') {
        // Reported so the phone hears what is happening, not just that something is.
        try {
          observer?.tool(event.call.name);
        } catch {
          // Progress reporting is never allowed to break the run it describes.
        }
      } else if (event.type === 'turn_aborted') { aborted = true; } else if (event.type === 'run_failed') {
        failure = event.message;
      } else if (event.type === 'approval_request') {
        asks.forwardApproval(agent, peer, event.request);
      } else if (event.type === 'approval_resolved') {
        asks.settled(event.id);
      } else if (event.type === 'question_request') {
        // A question parks the run exactly like an approval does, so it must reach
        // the peer the same way — and be settled by `/answer`, which `inbound`'s
        // bypass delivers without waiting behind this very run.
        asks.forwardQuestion(agent, peer, event.request);
      } else if (event.type === 'question_resolved') {
        asks.settled(event.id);
      }
      if (event.type === 'phase' && event.phase === 'idle') {
        unsubscribe();
        resolve();
      }
    });
  });
  await agent.prompt(turn.text, turn.images);
  await finished;
  if (failure !== undefined) throw new Error(failure);
  return { reply, ...(aborted ? { aborted: true } : {}) };
}
