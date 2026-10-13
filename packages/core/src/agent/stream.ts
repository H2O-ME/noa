/**
 * 单轮流式补全与空补全重试（M9.6 阶段 G 拆分）：累加器、reset 回卷、
 * usage/浪费审计、中断收尾。返回的 StreamOutcome 交给 runAgent 主体提交。
 */
import { newId } from '../ids.js';
import type { AgentEvent, Usage, UsageStats, UserMessage } from '../types.js';
import {
  CACHE_MISS_NOISE_FLOOR_TOKENS,
  EMPTY_COMPLETION_MAX_RETRIES,
  TURN_ABORTED_GUIDANCE,
  type AgentOptions,
} from './options.js';
import { requeueUnaccounted, type NoticeState } from './notices.js';
import type { ChatRequest } from '../types.js';

/** Append the abort marker to the log and surface it for persistence. */
export function* finishAborted(opts: AgentOptions): Generator<AgentEvent> {
  const marker: UserMessage = {
    id: newId('msg'),
    ts: Date.now(),
    role: 'user',
    content: TURN_ABORTED_GUIDANCE,
  };
  opts.messages.push(marker);
  yield { type: 'turn_aborted', message: marker };
  yield { type: 'done', stopReason: 'aborted' };
}

/** Per-turn accumulators handed back once a completion streams in full. */
export type StreamOutcome =
  | { interrupted: true }
  | {
      interrupted: false;
      content: string;
      finishReason: string | undefined;
      usage: Usage | undefined;
      partialCalls: Map<number, { id?: string; name?: string; args: string }>;
    };

/**
 * Stream one assistant completion, with the empty-completion retry loop. A
 * completion with NO text, NO tool calls and a finish reason is a provider
 * pathology, not a valid turn: the old behavior logged a phantom EMPTY
 * assistant message and ended the run "complete" — the caller saw thinking
 * stop and then silence with no error. Re-issue the IDENTICAL request (built
 * once per turn: re-draining job notices here would return [] and silently
 * drop them from the retry; the stable prefix also keeps the retry cache-warm).
 * Retries exhausted → hard error so every runner surfaces it.
 */
export async function* streamCompletion(
  opts: AgentOptions,
  request: ChatRequest,
  messageId: string,
  stats: UsageStats,
  notices: NoticeState,
): AsyncGenerator<AgentEvent, StreamOutcome> {
  let content = '';
  let finishReason: string | undefined;
  let usage: Usage | undefined;
  const partialCalls = new Map<number, { id?: string; name?: string; args: string }>();
  let emptyRetries = 0;
  for (;;) {
    content = '';
    partialCalls.clear();
    finishReason = undefined;
    usage = undefined;
    // Cumulative stats as of the start of the in-flight attempt: a provider
    // reset rolls the running stats back to this snapshot, discarding usage
    // reported by the failed attempt.
    const attemptStats: UsageStats = { ...stats };

    // An abort surfaces either as the signal firing between events or as an
    // AbortError thrown by the provider; both end the run the same way.
    let interrupted = false;
    try {
      for await (const ev of opts.provider.stream(request)) {
        if (opts.signal?.aborted) {
          interrupted = true;
          break;
        }
        switch (ev.type) {
          case 'reset': {
            // The provider discarded this attempt's response and is
            // re-requesting: roll every accumulator back so the replay starts
            // from a clean slate (partial text, tool-call deltas, usage and
            // finish reason all belonged to the failed attempt).
            content = '';
            partialCalls.clear();
            finishReason = undefined;
            usage = undefined;
            Object.assign(stats, attemptStats);
            yield {
              type: 'llm_retry',
              attempt: ev.attempt,
              maxRetries: ev.maxRetries,
              error: ev.error,
              stats: { ...stats },
            };
            break;
          }
          case 'text_delta': {
            content += ev.text;
            yield { type: 'text_delta', messageId, text: ev.text };
            break;
          }
          case 'reasoning_delta': {
            // Observability only: reasoning is never accumulated into the
            // message log, so the persisted prefix stays byte-stable.
            yield { type: 'reasoning_delta', text: ev.text };
            break;
          }
          case 'tool_call_delta': {
            let partial = partialCalls.get(ev.index);
            if (!partial) {
              partial = { args: '' };
              partialCalls.set(ev.index, partial);
            }
            // Empty strings are treated as absent: some gateways repeat
            // id/name as "" on argument-delta chunks.
            if (ev.id !== undefined && ev.id.length > 0) partial.id = ev.id;
            if (ev.name !== undefined && ev.name.length > 0) partial.name = ev.name;
            if (ev.argsDelta !== undefined) partial.args += ev.argsDelta;
            break;
          }
          case 'usage': {
            usage = ev.usage;
            stats.promptTokens += ev.usage.promptTokens;
            stats.completionTokens += ev.usage.completionTokens;
            stats.cachedTokens += ev.usage.cachedTokens;
            // Cache-waste audit: once the provider has reported any cache
            // activity, a turn whose prompt exceeded its cache read by more
            // than the noise floor paid full price for the difference.
            const miss = ev.usage.promptTokens - ev.usage.cachedTokens;
            if (stats.cachedTokens > 0 && miss > CACHE_MISS_NOISE_FLOOR_TOKENS) {
              stats.missTokens += miss;
              stats.missTurns += 1;
            }
            yield { type: 'usage', usage: ev.usage, stats: { ...stats } };
            break;
          }
          case 'finish': {
            if (ev.finishReason !== undefined) finishReason = ev.finishReason;
            break;
          }
        }
      }
    } catch (err) {
      // The model never answered this request: hand the drained notices back
      // before the error escapes (the registry outlives the run in
      // interactive mode, so the next run re-announces them).
      requeueUnaccounted(opts, notices);
      // Once the user asked to stop, unwind as an interruption regardless of
      // which error the abort raced with.
      if (!opts.signal?.aborted) throw err;
      interrupted = true;
    }
    if (interrupted) {
      // The partial response is discarded, so from the log's point of view the
      // model never saw the notice either.
      requeueUnaccounted(opts, notices);
      yield* finishAborted(opts);
      return { interrupted: true };
    }
    const emptyCompletion =
      content.length === 0 && partialCalls.size === 0 && finishReason !== undefined;
    if (!emptyCompletion || opts.signal?.aborted) break;
    // Deliberately NOT rolled back: unlike a `reset` (the provider discarding
    // its own in-flight attempt), this attempt completed and was billed — the
    // provider charged for its prompt tokens whatever the caller does with the
    // reply. So `stats` keeps them and the retry adds its own. The two paths
    // therefore differ on purpose; the run's token totals read "what this run
    // cost", not "what the accepted reply cost".
    emptyRetries += 1;
    if (emptyRetries > EMPTY_COMPLETION_MAX_RETRIES) {
      // The job notices rode every failed request, but no assistant reply was
      // ever committed — hand them back so the next run re-announces them
      // (at-least-once delivery).
      requeueUnaccounted(opts, notices);
      throw new Error(
        `model returned an empty completion ${EMPTY_COMPLETION_MAX_RETRIES + 1} times in a row (finish_reason: ${finishReason}; output likely went entirely to reasoning_content)`,
      );
    }
    yield {
      type: 'empty_completion',
      attempt: emptyRetries,
      maxRetries: EMPTY_COMPLETION_MAX_RETRIES,
      finishReason: finishReason!,
    };
  }
  return { interrupted: false, content, finishReason, usage, partialCalls };
}
