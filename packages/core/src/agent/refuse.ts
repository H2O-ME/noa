/**
 * The results owed by calls that never ran.
 *
 * One invariant ties this file together: the message log keeps a result for every
 * assistant `tool_calls` entry, even when nothing executed. Two things can leave a
 * call without a result — the loop refusing to run it (truncated or unparseable
 * arguments), or the consumer abandoning the generator mid-turn — and both are
 * this module's business. `tools.ts` covers the third case: a call that went
 * through dispatch, including the ones denied or skipped before execution.
 *
 * Why the START event is part of refusing a call: a surface builds its tool row
 * from `tool_call_start`, so a bare `tool_call_result` is drawn nowhere. Emitting
 * only the result made the live stream and a replay disagree about the same run —
 * the browser showed nothing while a reload, which pairs results to calls off the
 * log, showed the failure row.
 */
import { newId } from '../ids.js';
import { missingToolResults } from '../session/session-repair.js';
import type { AgentEvent, AgentMessage, ToolCall, ToolResultMessage } from '../types.js';
import type { AgentOptions } from './options.js';

/**
 * Retire a call the loop refused to run (truncated arguments from a `length`
 * stop, or arguments that never parsed as JSON).
 * @param opts - the run's options, for the message log the result is appended to.
 * @param call - the call that will not be executed.
 * @param turn - the turn the call belongs to.
 * @param content - the model-facing reason it was not executed.
 * @returns the pair of events, in the order a surface expects them.
 */
export function* refuseCall(
  opts: AgentOptions,
  call: ToolCall,
  turn: number,
  content: string,
): Generator<AgentEvent> {
  const result: ToolResultMessage = {
    id: newId('msg'),
    ts: Date.now(),
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content,
  };
  opts.messages.push(result);
  yield { type: 'tool_call_start', turn, call };
  yield { type: 'tool_call_result', turn, call, result };
}

/**
 * Fill in a NOT_EXECUTED_GUIDANCE result for every callId missing one. The
 * abandonment path's half of the invariant above: the run died inside the
 * consumer, so no in-band handler ran and the log would otherwise hold an
 * assistant `tool_calls` entry with no answer.
 * @param messages - the run's message log, mutated in place.
 */
export function synthesizeMissingToolResults(messages: AgentMessage[]): void {
  messages.push(...missingToolResults(messages));
}
