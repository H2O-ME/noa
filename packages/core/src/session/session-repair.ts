/**
 * Repairing a turn that ended with tool calls nobody answered.
 *
 * "One result per call" is a surface contract the model depends on: a request
 * built from an assistant message whose calls have no results is malformed, so
 * an aborted or crashed run has to be made whole before the next request. The
 * rule is one rule — which call ids are missing a result, and what a
 * synthesized result looks like — and both callers need it: the run loop for
 * the in-memory surface, the kernel handle for the durable log (whose repair
 * also has to reach the surface). `missingToolResults` is that rule; the two
 * callers are the two scopes it runs over.
 */
import { newId } from '../ids.js';
import { NOT_EXECUTED_GUIDANCE } from '../agent/options.js';
import type { Session } from '../session.js';
import type { AgentMessage, ToolResultMessage } from '../types.js';

/** A NOT_EXECUTED result for every assistant call id that has none. */
export function missingToolResults(messages: readonly AgentMessage[]): ToolResultMessage[] {
  // Pair results with calls IN ORDER rather than with one global id set: a
  // provider that reuses a call id in a later turn would otherwise let the
  // earlier turn's result mark the later call answered, and the repair would
  // leave that call bare — exactly the unbalanced surface a strict provider
  // rejects on the next request. The Map's insertion order keeps the output in
  // call order, and the `has` guard keeps two calls sharing an id within ONE
  // assistant message from producing two results.
  const pending = new Map<string, { name: string }>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (msg.toolCalls === undefined) continue;
      for (const call of msg.toolCalls) {
        if (!pending.has(call.id)) pending.set(call.id, { name: call.name });
      }
      continue;
    }
    if (msg.role === 'tool') pending.delete(msg.toolCallId);
  }
  return [...pending].map(([toolCallId, call]) => ({
    id: newId('msg'),
    ts: Date.now(),
    role: 'tool' as const,
    toolCallId,
    name: call.name,
    content: NOT_EXECUTED_GUIDANCE,
  }));
}

/**
 * Repair an abandoned turn's LOG (assistant tool_calls without results):
 * synthesize the missing results into the log and fill any hole left in the
 * live surface. Idempotent (it scans the log), so it is safe to run even when
 * the run loop's own surface cleanup already fired.
 */
export async function persistMissingToolResults(
  session: Session,
  messages: AgentMessage[],
): Promise<number> {
  // `missingToolResults` computes the logged set itself; a second copy here
  // would be one more thing to keep in step with it (and was never read).
  const missing = missingToolResults(session.allMessages());
  if (missing.length === 0) return 0;
  const surfaceResults = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool') surfaceResults.add(msg.toolCallId);
  }
  for (const result of missing) {
    await session.append(result);
    if (!surfaceResults.has(result.toolCallId)) {
      surfaceResults.add(result.toolCallId);
      messages.push(result);
    }
  }
  return missing.length;
}
