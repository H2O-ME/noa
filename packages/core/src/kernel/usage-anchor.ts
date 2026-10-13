/**
 * The session's usage bookkeeping: what the last request cost, and what the
 * log says when memory does not know.
 *
 * Two facts live here and they are deliberately different sources:
 *  - the **in-memory anchor** (`lastUsage` / `lastPromptTokens`) is what the
 *    LIVE process observed, used to predict the next request's size before
 *    compaction;
 *  - the **logged usage** is what a resumed process must read, because the
 *    memory that observed it is gone.
 *
 * Kept out of `session.ts` (already at its line ceiling) because the rules have
 * their own history: the context meter once read `run/stats.promptTokens` — a
 * run-wide SUM — and so reported nearly double the real window occupancy on a
 * two-request run. The invariant that prevents it is "last request, not run
 * total", and it belongs somewhere a reader can find it.
 */
import type { AgentMessage, Usage } from '../types.js';

/** The anchor state a session holds: memory's view of the last billed request. */
export interface UsageAnchorState {
  lastUsage: Usage | undefined;
  lastPromptTokens: number;
  usageAnchor: Usage | undefined;
  anchorMsgCount: number;
}

/** A fresh anchor set (nothing observed yet). */
export function createAnchors(): UsageAnchorState {
  return { lastUsage: undefined, lastPromptTokens: 0, usageAnchor: undefined, anchorMsgCount: 0 };
}

/**
 * Forget the anchors. Called when the message array is spliced in place: the
 * anchor counted messages of the OLD array, so keeping it would let a preflight
 * gate decide against a shape that no longer exists.
 */
export function resetAnchors(a: UsageAnchorState): void {
  a.lastUsage = undefined;
  a.lastPromptTokens = 0;
  a.usageAnchor = undefined;
  a.anchorMsgCount = 0;
}

/**
 * The newest billed usage in the live message array, newest first. The array is
 * the projection the log rebuilds on open, so this asks the durable side for the
 * number the appending process held in memory.
 * @param messages - the live model surface, in log order.
 * @returns the last assistant usage, or undefined when none was recorded.
 */
export function lastLoggedUsage(messages: readonly AgentMessage[]): Usage | undefined {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at];
    if (message?.role === 'assistant' && message.usage !== undefined && message.usage.promptTokens > 0) {
      return message.usage;
    }
  }
  return undefined;
}
