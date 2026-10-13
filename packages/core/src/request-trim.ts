import type { AgentMessage, ToolResultMessage } from './types.js';

/**
 * Request-level middle compression (learn-agent ch8, layers 2–3): the two
 * cheap pure-memory trims that run BEFORE the expensive model summary, on
 * the request snapshot only — the canonical log and the compaction
 * projection never see them (explicit `surfaceDivergence` exemption, same
 * channel family as the ephemeral job-notice tails).
 *
 * Units are ATOMIC TOOL GROUPS, never message indices: one assistant message
 * carrying tool_calls plus its paired tool result messages succeed or fail
 * together, so a batch of two parallel calls can never be sliced into an
 * orphaned `tool` message without its assistant call.
 */

export const SNIP_MAX_GROUPS = 50;
export const SNIP_KEEP_HEAD_GROUPS = 3;
export const MICRO_KEEP_RECENT_TOOL_GROUPS = 3;

/** Placeholder that replaces an aged tool result's body (call shape kept). */
export const MICRO_RESULT_PLACEHOLDER = '[Earlier tool result compacted. Re-run if needed.]';

/** Marker inserted where snip omitted whole middle groups. */
export const SNIP_OMITTED_MARKER_PREFIX = '[Compacted: ';

/**
 * Slice a message list into atomic groups: a run of assistant(tool_calls) +
 * its tool results is ONE group; every other message (user text, plain
 * assistant, context fragment, compaction summary…) is its own group. Tool
 * results that cannot be paired to a preceding assistant call (corrupt log)
 * each stand alone rather than being glued to a stranger's group — pairing
 * must never be guessed.
 */
export function groupMessages(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
      const group: AgentMessage[] = [msg];
      const ids = new Set(msg.toolCalls.map((call) => call.id));
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j]!;
        if (next.role === 'tool' && ids.has(next.toolCallId)) {
          group.push(next);
          j += 1;
        } else {
          break;
        }
      }
      groups.push(group);
      i = j;
    } else {
      groups.push([msg]);
      i += 1;
    }
  }
  return groups;
}

export interface SnipOptions {
  maxGroups?: number;
  keepHeadGroups?: number;
}

function snipConfig(opts: SnipOptions): { maxGroups: number; keepHead: number } {
  const maxGroups = opts.maxGroups ?? SNIP_MAX_GROUPS;
  const keepHead = opts.keepHeadGroups ?? SNIP_KEEP_HEAD_GROUPS;
  if (!Number.isInteger(maxGroups) || maxGroups < 3) {
    throw new RangeError(`snip maxGroups must be an integer >= 3 (got ${String(maxGroups)})`);
  }
  if (!Number.isInteger(keepHead) || keepHead < 0 || keepHead > maxGroups - 2) {
    throw new RangeError(`snip keepHeadGroups must be an integer in [0, maxGroups - 2] (got ${String(keepHead)})`);
  }
  return { maxGroups, keepHead };
}

/**
 * Layer 2: drop whole middle groups when the group count exceeds the budget,
 * keeping head groups (original request, earliest constraints) and tail
 * groups (latest progress), with one marker message in between. Returns the
 * input array untouched when under budget. The marker is a fresh assistant
 * message (never a `tool` role, never paired) so it cannot disturb pairing.
 */
export function snipMessages(messages: AgentMessage[], opts: SnipOptions = {}): AgentMessage[] {
  const { maxGroups, keepHead } = snipConfig(opts);
  const groups = groupMessages(messages);
  if (groups.length <= maxGroups) return messages;
  // One slot is the marker itself: head + marker + tail === maxGroups.
  const keepTail = maxGroups - keepHead - 1;
  const omitted = groups.length - keepHead - keepTail;
  const marker: AgentMessage = {
    id: `msg_snip_${omitted}_${groups.length}`,
    ts: 0,
    role: 'assistant',
    content: `${SNIP_OMITTED_MARKER_PREFIX}${omitted} message groups omitted]`,
  };
  return [...groups.slice(0, keepHead).flat(), marker, ...groups.slice(groups.length - keepTail).flat()];
}

export interface MicroOptions {
  keepRecentToolGroups?: number;
}

/**
 * Layer 3 core: placeholder the bodies of older tool results. `fallback` is
 * returned unchanged when fewer than `keep` tool groups are present (the
 * no-op short-circuit callers rely on for cache-stable identity).
 */
function applyMicro(groups: AgentMessage[][], keep: number, fallback: AgentMessage[]): AgentMessage[] {
  const toolGroupIdx: number[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const head = groups[gi]![0]!;
    if (head.role === 'assistant' && head.toolCalls !== undefined && head.toolCalls.length > 0) {
      toolGroupIdx.push(gi);
    }
  }
  const compactCount = Math.max(0, toolGroupIdx.length - keep);
  if (compactCount === 0) return fallback;
  const compacted = new Set(toolGroupIdx.slice(0, compactCount));
  return groups.map((group, gi) => {
    if (!compacted.has(gi)) return group;
    return group.map((msg): AgentMessage => {
      if (msg.role !== 'tool') return msg;
      const replaced: ToolResultMessage = { ...msg, content: MICRO_RESULT_PLACEHOLDER };
      // A spilled result's pointer stays honest: the on-disk full output is
      // untouched, only this request's inline body is downgraded.
      return replaced;
    });
  }).flat();
}

/**
 * Layer 3: replace the BODIES of older tool results with a placeholder,
 * keeping every call (assistant tool_calls, ids, pairing) and the message
 * count intact. Only groups whose assistant carries tool_calls count toward
 * the "recent N" budget; a result shorter than the placeholder still gets
 * replaced — the rule stays one sentence ("older than N tool groups") and
 * deterministic, which the cache check downstream depends on.
 */
export function microMessages(messages: AgentMessage[], opts: MicroOptions = {}): AgentMessage[] {
  const keep = opts.keepRecentToolGroups ?? MICRO_KEEP_RECENT_TOOL_GROUPS;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new RangeError(`micro keepRecentToolGroups must be an integer >= 0 (got ${String(keep)})`);
  }
  return applyMicro(groupMessages(messages), keep, messages);
}

/**
 * Layer order is fixed: snip first (whole groups gone need no micro pass),
 * then micro. The input is never mutated.
 *
 * Hot path: group the input ONCE and run both layers over the shared grouping.
 * snip's cold path (group count over the 50-budget) is rare; when it fires the
 * post-snip structure is deterministic — [head_groups, [marker], tail_groups],
 * every element already atomic (marker is a plain assistant, no tool_calls) —
 * so we reuse the synthesized groups instead of re-grouping the flat output.
 * When snip is a no-op the same groups flow straight into micro, halving the
 * grouping cost on the common path. Identity is preserved: `messages` is
 * returned when neither layer fires (matches `snipMessages === messages` and
 * `microMessages === messages` standalone guarantees).
 */
export function trimRequestMessages(messages: AgentMessage[]): AgentMessage[] {
  const groups = groupMessages(messages);
  let afterSnip: AgentMessage[];
  let groupsForMicro: AgentMessage[][];
  if (groups.length > SNIP_MAX_GROUPS) {
    const keepTail = SNIP_MAX_GROUPS - SNIP_KEEP_HEAD_GROUPS - 1;
    const omitted = groups.length - SNIP_KEEP_HEAD_GROUPS - keepTail;
    const marker: AgentMessage = {
      id: `msg_snip_${omitted}_${groups.length}`,
      ts: 0,
      role: 'assistant',
      content: `${SNIP_OMITTED_MARKER_PREFIX}${omitted} message groups omitted]`,
    };
    groupsForMicro = [
      ...groups.slice(0, SNIP_KEEP_HEAD_GROUPS),
      [marker],
      ...groups.slice(groups.length - keepTail),
    ];
    afterSnip = groupsForMicro.flat();
  } else {
    afterSnip = messages;
    groupsForMicro = groups;
  }
  return applyMicro(groupsForMicro, MICRO_KEEP_RECENT_TOOL_GROUPS, afterSnip);
}
