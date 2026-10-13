/**
 * 请求级通知簿记（M9.6 阶段 G 拆分）：job 完成通知与 stale-todo 提醒共享
 * 同一条 at-least-once 送达通道——drain 后若回复未提交即回队/重 arm。
 */
import type { JobRegistry } from '../jobs.js';
import type { AgentOptions } from './options.js';

/**
 * Per-run bookkeeping for the job-notice at-least-once delivery contract
 * (drained per request; requeued on every path that ends without the
 * assistant reply committing).
 */
export interface NoticeState {
  unaccounted: ReturnType<JobRegistry['drainFinished']>;
  consumed: boolean;
  /** Armed by the loop when the plan went stale; consumed per request below. */
  nag: boolean;
  /** True while a carried nag is still unannounced (reply not committed). */
  carriedNag: boolean;
}

/** Requeue drained-but-unannounced notices exactly once (idempotent). */
export function requeueUnaccounted(opts: AgentOptions, notices: NoticeState): void {
  if (!notices.consumed) {
    opts.jobs?.requeue(notices.unaccounted);
    notices.consumed = true;
  }
  // At-least-once for the nag too: a request that died before its reply
  // committed never announced the carried nudge, so re-arm it. A request that
  // never carried one leaves the flag untouched.
  if (notices.carriedNag) {
    notices.nag = true;
    notices.carriedNag = false;
  }
}

/**
 * Request-level stale-plan nudge: when the model built a todo list but then
 * works tool turn after tool turn without updating it, the plan silently
 * rots. The loop tracks staleness and arms the flag; assembleRequest rides
 * the nudge on the SAME request-scoped channel as the job notices (see
 * request.ts).
 */
export const STALE_TODO_TURNS = 3;

/**
 * Ephemeral stale-plan reminder text (see assembleRequest for the delivery
 * channel). Names the todo_write tool concretely so the model can act without
 * guessing; tells it to stay silent when on track so the nudge costs one
 * line, not a digression.
 */
export const STALE_TODO_NAG =
  'Reminder: you have a todo list but have not updated it for several tool turns. If the plan changed, call todo_write with the current list; if you are still on track, keep going without mentioning this reminder.';
