/**
 * The approval gate: the highest-priority `tool/before` listener that turns a
 * permission tier into an allow / deny / ask for one tool call.
 *
 * Its own module because it answers a different question from hook composition
 * (`hooks.ts` says HOW the chains are built; this says WHO decides a call). The
 * distinction became load-bearing when the decision became per session: the gate
 * is the one place that must read `ToolCallScope` and reach the engine of the
 * conversation that issued the call.
 */
import {
  approval as approvalKey,
  beforeToolCall as beforeToolCallEvent,
  sessions as sessionsKey,
  tools as toolsKey,
  type Context,
  type Listener,
  type Plugin,
  type ToolCall,
  type ToolCallScope,
  type ToolCallVerdict,
} from '@noa/core';

/**
 * The gate decides with the PERMISSION ENGINE OF THE SESSION THAT ISSUED THE
 * CALL, reached through `ToolCallScope.sessionId`, and never with a
 * process-global one.
 *
 * That is the whole security property. One kernel runs several conversations at
 * once (a chat peer, the desktop, a resumed tab), so a shared engine let a peer's
 * tier — and a peer's remembered "always allow" grants — decide the desktop's
 * calls. The container's `approval` service is used only when the call belongs to
 * no session at all (an embedder driving the loop directly); a scope naming a
 * session this kernel no longer holds is refused rather than decided under
 * somebody else's tier.
 */
export const permissionGatePlugin: Plugin = {
  name: 'approval-gate',
  manifest: { title: '审批门', description: '在工具执行前按权限档位裁定放行、拒绝或询问；优先级最高。', tier: 'core' },
  inject: [toolsKey, approvalKey],
  apply: (ctx: Context): void => {
    const registry = ctx.must(toolsKey);
    const kernelGate = ctx.must(approvalKey);
    const listener: Listener<[ToolCall, ToolCallScope], ToolCallVerdict | undefined> = async (call, scope) => {
      const kind = await registry.permissionFor(call.name, call.args);
      if (kind === undefined) return undefined;
      // Read LIVE and OPTIONALLY. Live, because a provider can be replaced under
      // a long-lived gate; optional, because a bare embedded kernel has no
      // session registry at all — and REQUIRING one would make this plugin fail
      // to load, i.e. leave the gate uninstalled, which fails OPEN. No registry
      // means no per-session engines exist, so the kernel engine is the only
      // engine there is.
      const sessions = ctx.get(sessionsKey);
      const session = scope.sessionId === undefined || sessions === undefined
        ? undefined
        : sessions.get(scope.sessionId);
      const engine = session?.permission;
      if (engine?.decideDetailed !== undefined) {
        const decision = await engine.decideDetailed(call.name, kind, call);
        if (decision === 'allow') return undefined;
        return {
          action: 'deny',
          reason: decision.reason !== undefined ? `by user: ${decision.reason}` : 'by user',
        };
      }
      // A scope naming a session this kernel does not hold (a stale handle, or a
      // run outliving its session's dispose). Deciding it with the kernel engine
      // would judge it under somebody else's tier, so refuse instead.
      if (scope.sessionId !== undefined && sessions !== undefined) {
        return { action: 'deny', reason: 'this call belongs to a session that is no longer open' };
      }
      // A call with NO scope in a kernel that HAS sessions is just as suspect:
      // every product path (a session run, a PTC sub-dispatch, a nested
      // subagent loop) threads the scope, so a scopeless call means a run
      // bypassed the threading — and the kernel engine belongs to no
      // conversation, so deciding under it is the escalation path F01 closed.
      // Bare embedded kernels (no registry) keep the kernel-engine fallback:
      // there is no other engine and no scope to carry.
      if (scope.sessionId === undefined && sessions !== undefined) {
        return { action: 'deny', reason: 'this call carries no session scope' };
      }
      const decision = await kernelGate.decideDetailed(call.name, kind, call);
      if (decision === 'allow') return undefined;
      return {
        action: 'deny',
        reason: decision.reason !== undefined ? `by user: ${decision.reason}` : 'by user',
      };
    };
    ctx.on(beforeToolCallEvent, listener, { priority: 1000 });
  },
};
