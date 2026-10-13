/**
 * Hook composition, on top of the container's typed events.
 *
 * The three lifecycle points are ordinary container events now
 * (`beforeLlmCall` / `beforeToolCall` / `afterToolResult`), so a plugin hooks
 * in with the same `ctx.on(...)` it uses for anything else, and unloading takes
 * the hook back automatically. What remains here is the *composition*: turning
 * the event chains into the single `AgentHooks` object the loop consumes, plus
 * the tool-set guard that must survive any chain.
 *
 *  - `beforeLLMCall` is a waterfall: a hook that wraps the request calls
 *    `next()`, one that merely transforms it calls `next(rewritten)`.
 *  - `beforeToolCall` is serial and first-decisive-wins, with the approval
 *    gate registered at high priority (see `permission-gate.ts`) so
 *    permission is settled before any other hook sees the call. The call's
 *    `ToolCallScope` is forwarded verbatim, because the gate decides with the
 *    engine of the session that issued the call.
 *  - `afterToolResult` is a waterfall over the result text.
 */
import {
  afterToolResult as afterToolResultEvent,
  beforeLlmCall as beforeLlmCallEvent,
  beforeToolCall as beforeToolCallEvent,
  beforeTurnEnd as beforeTurnEndEvent,
  errMessage,
  type AgentHooks,
  type BeforeTurnEndContext,
  type BeforeTurnEndVerdict,
  type ChatRequest,
  type Context,
  type ToolCall,
  type ToolCallScope,
  type ToolCallVerdict,
  validateToolCallVerdict,
} from '@noa/core';

/**
 * One composed chain object per container root, cached.
 *
 * The identity matters: a wrapper (the headless auto-compact gate) replaces one
 * of these methods to gate every request, and the loop re-reads its hooks every
 * run. Handing back a fresh object each call would silently drop such a
 * wrapper — exactly the bug that made exec's auto-compact stop firing. The
 * methods still read the LIVE event chains, so caching the object costs nothing
 * in freshness.
 */
const composed = new WeakMap<Context, AgentHooks>();

export function composeHooks(ctx: Context): AgentHooks {
  const cached = composed.get(ctx);
  if (cached !== undefined) return cached;
  const hooks = buildHooks(ctx);
  composed.set(ctx, hooks);
  return hooks;
}

function buildHooks(ctx: Context): AgentHooks {
  return {
    beforeLLMCall: async (req: ChatRequest): Promise<ChatRequest> => {
      const before = req.tools === undefined ? undefined : new Set(req.tools.map((tool) => tool.name));
      const out = (await ctx.waterfall(beforeLlmCallEvent, req)) ?? req;
      assertToolSetUnchanged(before, out);
      return out;
    },
    beforeToolCall: async (call: ToolCall, scope?: ToolCallScope): Promise<ToolCallVerdict> => {
      let verdict: ToolCallVerdict | undefined;
      try {
        verdict = await ctx.serial(beforeToolCallEvent, call, scope ?? {});
      } catch (err) {
        // A throwing/rejecting hook has proven itself untrustworthy; fail
        // closed with an actionable reason instead of aborting the whole run.
        return { action: 'deny', reason: `hook failed: ${errMessage(err)}` };
      }
      if (verdict === undefined) return { action: 'allow' };
      const malformed = validateToolCallVerdict(verdict);
      if (malformed !== undefined) {
        return { action: 'deny', reason: `malformed hook verdict (${malformed})` };
      }
      return verdict;
    },
    afterToolResult: async (call: ToolCall, result: string): Promise<string> => {
      return (await ctx.waterfall(afterToolResultEvent, call, result)) ?? result;
    },
    beforeTurnEnd: async (turnCtx: BeforeTurnEndContext): Promise<BeforeTurnEndVerdict | void> => {
      // Serial / first-decisive-wins, mirroring beforeToolCall. The first
      // plugin that returns `{ action: 'steer' }` (or `{ action: 'stop' }`)
      // wins; `undefined` passes to the next listener.
      const verdict = await ctx.serial(beforeTurnEndEvent, turnCtx);
      if (verdict === undefined || verdict === null) return;
      return verdict;
    },
  };
}

/**
 * The approval gate lives in its own module (`permission-gate.ts`): it is a
 * DECISION about one call, not part of how the chains are composed. Re-exported
 * here because this module is the package's hook seam and every existing
 * importer reads the gate from it.
 */
export { permissionGatePlugin } from './permission-gate.js';

/**
 * Prefix-cache and reach guard: the tool array's wire order is dictionary
 * sorted and part of the cached prefix, and the set itself is what the model
 * may call. A hook may narrow it (the PTC projection does) or hand back a
 * clone, never add — an addition has no approval record and silently widens
 * the model's reach. Compared by NAME SET, not array identity, because
 * legitimate plumbing clones the array.
 */
function assertToolSetUnchanged(before: Set<string> | undefined, req: ChatRequest): void {
  if (before === undefined || req.tools === undefined) return;
  const added = req.tools.filter((tool) => !before.has(tool.name));
  if (added.length > 0) {
    throw new Error(
      `beforeLLMCall hook added tools without approval: ${added.map((tool) => tool.name).join(', ')}`,
    );
  }
}
