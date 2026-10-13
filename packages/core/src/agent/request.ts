/**
 * 单轮请求装配（M9.6 阶段 G 拆分）：hook 链 → 请求级修剪 → ephemeral 尾。
 */
import { newId } from '../ids.js';
import { projectRequestImages } from '../image-projection.js';
import { formatJobNotices } from '../job-types.js';
import { trimRequestMessages } from '../request-trim.js';
import type { ChatRequest, UserMessage } from '../types.js';
import type { AgentOptions } from './options.js';
import { STALE_TODO_NAG, type NoticeState } from './notices.js';

/**
 * Request assembly for one turn. Finished-job notices are injected AFTER the
 * hook chain on purpose. The beforeLLMCall hooks (notably exec's in-place
 * auto-compact) assume request.messages aliases opts.messages — a shared
 * reference they splice to shrink the outer log. Injecting a clone before them
 * would swallow that splice (the outer array would never shrink and every
 * following turn would re-compact). Here the hook first sees the clean
 * append-only log; the notice then becomes an ephemeral tail on a fresh clone,
 * so it reaches the model but never the log (resume/compact unaffected) and
 * the drain-once registry queue still announces each job exactly once.
 * Delivery is at-least-once though: if this request dies before its assistant
 * reply commits (network exhausted, context-window 400…), the drained notices
 * go back on the queue — announce-zero would silently strand the task.
 *
 * Request-level trims (snip/micro, ch8 layers 2–3) sit BETWEEN the hook chain
 * and the tails: hooks price and splice the true log, then the wire snapshot
 * sheds whole middle groups (snip) and ages old tool bodies into placeholders
 * (micro) on a FRESH array — never an in-place splice of opts.messages, so
 * the auto-compact alias contract and the log projection stay intact. The
 * tails ride on top of the trimmed snapshot, still ephemeral.
 *
 * Stale-plan nudge (ch5 stale-nag): when the model built a todo list but then
 * works tool turn after tool turn without updating it, the plan silently
 * rots. The loop tracks staleness and hands the flag in here; the nudge
 * rides the SAME request-scoped channel as the job notices (ephemeral tail
 * message, never logged, re-armed when the request dies before the reply
 * commits) so it cannot pollute the canonical history or the compaction
 * projection.
 */
export async function assembleRequest(opts: AgentOptions, notices: NoticeState): Promise<ChatRequest> {
  let request: ChatRequest = {
    messages: opts.messages,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    signal: opts.signal,
  };
  if (opts.hooks?.beforeLLMCall) request = await opts.hooks.beforeLLMCall(request);
  // Images are projected after the hook chain (a hook may have rewritten the
  // history) and before the trims, which then price the final text.
  const projected = await projectRequestImages(request.messages, opts.inputModalities);
  if (projected.messages !== request.messages) {
    request = { ...request, messages: projected.messages as typeof request.messages };
  }
  notices.unaccounted = opts.jobs?.drainFinished(opts.scope?.sessionId) ?? [];
  notices.consumed = notices.unaccounted.length === 0;
  // Request-level middle compression on a fresh array: the hook chain above
  // saw (and possibly spliced) the true log; the wire snapshot trims from
  // there. Ephemeral tails below append on top of the trimmed snapshot.
  const trimmed = trimRequestMessages(request.messages);
  const tails: UserMessage[] = [];
  if (notices.unaccounted.length > 0) {
    tails.push({
      id: newId('msg'),
      ts: Date.now(),
      role: 'user',
      content: formatJobNotices(notices.unaccounted),
    });
  }
  if (notices.nag) {
    tails.push({ id: newId('msg'), ts: Date.now(), role: 'user', content: STALE_TODO_NAG });
    // Carried for this request only — the loop re-arms on dead requests, and
    // marks the announcement landed when the reply commits (see runAgent).
    notices.nag = false;
    notices.carriedNag = true;
  }
  if (tails.length > 0) {
    request = { ...request, messages: [...trimmed, ...tails] };
  } else if (trimmed !== request.messages) {
    request = { ...request, messages: trimmed };
  }
  return request;
}
