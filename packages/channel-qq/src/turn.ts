/**
 * 跑一次提示词，收敛到「这一轮结束」，返回要发回去的文本。
 *
 * 从对端编排（`peers.ts`）拆出，因为它是另一个问题：那边讲**谁跑哪一轮**（对端 →
 * 会话的编排：懒建、复用、激活、遥控旁路），这里讲**一轮内部怎么收尾**（订阅哪些事件、
 * 回复取哪条、失败怎么抛）。前者是路由，后者是单轮的执行语义。
 */
import type { AgentSession, KernelEvent } from '@noa/core';
import type { Peer } from './types.js';
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
   * and the answer; it rides the same budgeted narration line, and the final
   * reply is deduped against what was already sent (see `ProgressRelay.final`).
   */
  text(body: string): void;
  /**
   * One streamed chunk of an assistant message (`text_delta`). Only wired when
   * the channel can carry QQ streaming messages; the observer owns the
   * per-message accumulation and throttling.
   */
  delta?(messageId: string, text: string): void;
  /**
   * One assistant message COMPLETED. Returns true when the observer DELIVERED
   * the body itself (a streaming card was closed with the full text) — the
   * caller then skips the plain-text narration for it, which would duplicate
   * what the card already shows.
   *
   * The verdict may be a PROMISE: closing the card is a network call, and a
   * close that FAILS must not be reported as delivered — a body reported as
   * delivered is never sent again, so an optimistic true is exactly how the
   * answer would vanish. The caller awaits it before deciding.
   */
  assistantDone?(messageId: string, body: string): boolean | Promise<boolean>;
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
  /**
   * Whether the reply was ALREADY delivered by the observer's streaming card.
   * The caller must then return an empty answer: sending the text again would
   * read the answer twice.
   */
  streamed?: boolean;
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
 * @param text - the inbound prompt.
 * @param peer - who asked.
 * @param observer - progress reporting for the duration of this turn, if any.
 * @returns the reply the caller must deliver.
 */
export async function promptOnce(
  agent: AgentSession,
  asks: PendingAsks,
  text: string,
  peer: Peer,
  observer?: TurnObserver,
): Promise<TurnResult> {
  let reply = '';
  let streamed = false;
  let aborted = false;
  let failure: string | undefined;
  /** 最后一条助手消息的送达判定还没落定（卡片收口还在飞）时的挂起项。 */
  let delivery: Promise<boolean> | undefined;
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = agent.subscribe((event: KernelEvent) => {
      if (event.type === 'text_delta') {
        try {
          observer?.delta?.(event.messageId, event.text);
        } catch {
          // Progress reporting is never allowed to break the run it describes.
        }
      } else if (event.type === 'message' && event.message.role === 'assistant' && event.message.content.trim().length > 0) {
        // Every assistant text is BOTH a narration candidate and the running
        // reply: the relay dedupes the one that was already sent mid-run, so
        // the last text still lands exactly once — as the reply.
        const body = event.message.content.trim();
        reply = body;
        try {
          // A streaming observer may have delivered the whole body already
          // (its card closed with the full text); plain narration would
          // duplicate it, so it only fires when streaming did NOT.
          const verdict = observer?.assistantDone?.(event.message.id, body);
          if (verdict instanceof Promise) {
            // 卡片还在收口：此刻说「已送达」就是把答案押在一次还没落定的写上。
            // 判定推迟到轮结束后，正文暂时算未送达（写失败时回复路径会补送）。
            delivery = settleDelivery(verdict, body, observer);
            streamed = false;
          } else {
            const delivered = verdict === true;
            delivery = undefined;
            if (!delivered) observer?.text(body);
            streamed = delivered;
          }
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
  await agent.prompt(text);
  await finished;
  // 收口的成败决定正文由谁送，而它是异步的：先等它落定再报结论，否则「已由卡片
  // 送达」可能先于事实，那条正文就再也没人发了。
  if (delivery !== undefined) streamed = await delivery;
  if (failure !== undefined) throw new Error(failure);
  return { reply, ...(streamed ? { streamed: true } : {}), ...(aborted ? { aborted: true } : {}) };
}

/**
 * 等卡片的收口落定。
 *
 * 写失败时这条正文要退回叙述：中间那条消息的正文不会被当作回复发出去（只有最后一
 * 条才是），不在这里补一句，它就真的没了。报告失败绝不能反过来打断这一轮，所以两
 * 个分支都吞异常。
 * @param verdict - 观察者给出的送达判定。
 * @param body - 这条助手消息的正文。
 * @param observer - 同一条观察者（补叙述用）。
 * @returns 判定本身（异常按未送达算）。
 */
function settleDelivery(
  verdict: Promise<boolean>,
  body: string,
  observer: TurnObserver | undefined,
): Promise<boolean> {
  return verdict.then(
    (delivered) => {
      if (!delivered) {
        try {
          observer?.text(body);
        } catch {
          // Progress reporting is never allowed to break the run it describes.
        }
      }
      return delivered;
    },
    () => false,
  );
}

