/**
 * What a NESTED ephemeral run (a subagent) may see and inherit.
 *
 * Split from `subagent.ts` because it answers a different question: that file
 * owns the delegation tool, this owns the scoping RULES — which tools a nested
 * toolset carries and which session facts the nested run inherits. Both halves
 * exist because a nested run used to be threaded like a second process: empty
 * scope, full toolset, and the silent outcomes that follow.
 */
import type { ToolDefinition } from '../types.js';
import type { SessionEvent } from '../session.js';
type JobRegistry = import('../jobs.js').JobRegistry;

/**
 * The toolset a NESTED run may see: the subagent itself (no recursion) and
 * every tool that owns per-session state (`ownsSessionState`) are removed.
 * The state tools' writes belong to the conversation whose board they mutate —
 * a subagent has no board of its own, so letting one run there either writes
 * into the parent's state (pollution through the inherited `emit`) or, without
 * an emit sink, silently pretends success. Declared by the tools themselves,
 * so the filter stays name-agnostic: a third-party state tool is excluded by
 * the same flag, not by a hard-coded list.
 */
export function nestedToolset(tools: ToolDefinition[], selfName: string): ToolDefinition[] {
  return tools.filter((tool) => tool.name !== selfName && tool.ownsSessionState !== true);
}

/**
 * The parent session facts a nested run inherits. The sessionId is the load
 * bearing one: without it the nested loop's tool calls carry an EMPTY
 * `ToolCallScope`, and the approval gate falls back to the kernel engine —
 * an escalation path when the parent conversation is more restricted than the
 * kernel default, and mis-attributed asks when it is not. The cacheDir keeps
 * oversized tool results in the parent conversation's spill dir rather than
 * the global fallback.
 */
export interface NestedRunSession {
  sessionId?: string;
  jobs?: JobRegistry;
  emit?: (evt: SessionEvent) => void | Promise<void>;
  cacheDir?: string;
}
