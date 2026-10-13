/**
 * Per-session permission isolation — the security property behind threading
 * `ToolCallScope` through the tool hook chain.
 *
 * ONE kernel drives several conversations at once (a bot channel keeps one per
 * peer, the browser keeps one per open handle), and the engine that decides a
 * call must be the engine of the session that ISSUED it. A kernel-wide engine
 * made three conversational facts global: the TIER (a chat peer's `/perm full`
 * raised the desktop's), the REMEMBERED "always allow" grants, and the ASK's
 * publisher. Each of the three is pinned below against a REAL kernel, because
 * the failure mode is silent — the call simply runs, or the approval simply
 * appears on somebody else's screen.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession, AskResult, ChatProvider, KernelEvent, Plugin, StreamEvent, ToolCall } from '@noa/core';
import { createAgentKernel, registerTool } from '../src/index.js';

function provider(scripts: StreamEvent[][]): ChatProvider {
  let call = 0;
  return {
    async *stream() {
      const events = scripts[call] ?? [];
      call += 1;
      for (const ev of events) yield ev;
    },
  };
}

/** A tool gated as `execute`, so the tier decides it in every mode but `full`. */
function boomPlugin(): Plugin {
  return {
    name: 'boom',
    inject: ['tools'],
    apply(ctx) {
      registerTool(
        ctx,
        {
          name: 'boom',
          description: 'test tool gated as execute',
          parameters: { type: 'object' },
          execute: () => 'ran',
        },
        'execute',
      );
    },
  };
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nova-scope-'));
}

async function kernelWithTool() {
  return await createAgentKernel({
    rootDir: await tmp(),
    provider: provider([[{ type: 'text_delta', text: 'ok' }]]),
    config: { approval: 'read-only' },
    sessionDir: await tmp(),
    extraPlugins: [{ id: 'boom', plugin: boomPlugin() }],
  });
}

/**
 * Answer every ask this session raises with one verdict — the stand-in for the
 * human at its surface. Returns the disposer.
 */
function answerer(session: AgentSession, answer: AskResult): () => void {
  return session.subscribe((event: KernelEvent) => {
    if (event.type === 'approval_request') session.resolveApproval(event.request.id, answer);
  });
}

const call: ToolCall = { id: 'c1', name: 'boom', args: {}, rawArgs: '{}' };

describe('per-session permission scope', () => {
  it('decides each call with the engine of the session that issued it', async () => {
    const kernel = await kernelWithTool();
    const a = await kernel.newAgentSession();
    a.setApprovalMode('read-only');
    const stopA = answerer(a, 'deny');
    const b = await kernel.newAgentSession();
    b.setApprovalMode('full');

    expect(a.session.id).not.toBe(b.session.id);

    // The gate reads the scope, not "the current session": whoever happens to be
    // current must have no influence on the verdict. A pass through the chain is
    // reported by the composer as an explicit `allow`.
    kernel.activateSession(a);
    expect(await kernel.hooks.beforeToolCall?.(call, { sessionId: b.session.id })).toEqual({ action: 'allow' });
    kernel.activateSession(b);
    expect(await kernel.hooks.beforeToolCall?.(call, { sessionId: a.session.id })).toEqual({
      action: 'deny',
      reason: 'by user',
    });

    stopA();
    await kernel.dispose();
  });

  it('refuses a call whose session is not open instead of judging it elsewhere', async () => {
    // A scope naming a session this kernel does not hold is a stale handle or a
    // run outliving its session's dispose. Falling back to the kernel engine
    // would decide it under somebody else's tier.
    const kernel = await kernelWithTool();
    kernel.permission.setMode('full');
    expect(await kernel.hooks.beforeToolCall?.(call, { sessionId: 'nope' })).toEqual({
      action: 'deny',
      reason: 'this call belongs to a session that is no longer open',
    });
    await kernel.dispose();
  });

  it('refuses a SCOPELESS call instead of judging it with the kernel engine', async () => {
    // In a kernel that has sessions, every legitimate path threads the scope
    // (session runs, PTC sub-dispatches, nested subagent loops). A call with
    // an empty scope means something bypassed the threading — deciding it
    // under the kernel engine was exactly the F01 escalation path (a nested
    // run outliving a restricted parent conversation could come back
    // scopeless and be judged by the kernel's broader tier).
    const kernel = await kernelWithTool();
    kernel.permission.setMode('full');
    expect(await kernel.hooks.beforeToolCall?.(call, {})).toEqual({
      action: 'deny',
      reason: 'this call carries no session scope',
    });
    await kernel.dispose();
  });

  it('does not carry a remembered "always allow" grant across sessions', async () => {
    const kernel = await kernelWithTool();
    const a = await kernel.newAgentSession();
    const b = await kernel.newAgentSession();
    const stopA = answerer(a, 'always');
    const stopB = answerer(b, 'deny');

    // Answering A's ask with `always` is a grant on A's ENGINE. If it were
    // remembered kernel-wide, B would inherit A's decision and never be asked.
    expect(await kernel.hooks.beforeToolCall?.(call, { sessionId: a.session.id })).toEqual({ action: 'allow' });
    expect(await kernel.hooks.beforeToolCall?.(call, { sessionId: b.session.id })).toEqual({
      action: 'deny',
      reason: 'by user',
    });

    stopA();
    stopB();
    await kernel.dispose();
  });

  it('records an approval in the conversation that asked, not in the current one', async () => {
    const kernel = await kernelWithTool();
    const a = await kernel.newAgentSession();
    const b = await kernel.newAgentSession();
    const stopA = answerer(a, 'allow');
    // B is the current session throughout, so any audit line written through
    // `current()` lands in the wrong log.
    kernel.activateSession(b);

    await kernel.hooks.beforeToolCall?.(call, { sessionId: a.session.id });
    // The audit is appended asynchronously by the engine's callback.
    for (let i = 0; i < 200 && !a.session.events.some((e) => e.type === 'approval'); i++) {
      await new Promise((r) => setTimeout(r, 1));
    }

    const auditOf = (session: AgentSession): string[] =>
      session.session.events.filter((e) => e.type === 'approval').map((e) => (e as { outcome: string }).outcome);
    expect(auditOf(a)).toEqual(['allow']);
    expect(auditOf(b)).toEqual([]);

    stopA();
    await kernel.dispose();
  });

  it('binds every session with the process-wide never policy', async () => {
    // The counterpart of the three above: `never` is about the PROCESS (is there
    // an interactive answerer at all), so a headless runner pinning it before or
    // after opening sessions must reach all of them — and it must reach them
    // WITHOUT dispatching an ask nobody could answer.
    const kernel = await kernelWithTool();
    const a = await kernel.newAgentSession();
    kernel.permission.setPolicy('never');
    const b = await kernel.newAgentSession();
    expect(a.approvalPolicy).toBe('never');
    expect(b.approvalPolicy).toBe('never');
    const asked: string[] = [];
    a.subscribe((event: KernelEvent) => {
      if (event.type === 'approval_request') asked.push(event.request.id);
    });
    expect(await kernel.hooks.beforeToolCall?.(call, { sessionId: a.session.id })).toEqual({
      action: 'deny',
      reason: 'by user',
    });
    expect(asked).toEqual([]);
    await kernel.dispose();
  });

  it('reports the tier of the session in force through Kernel.permission', async () => {
    // `/perm` in the CLI reads this accessor: it must follow the conversation
    // being looked at, or the operator changes one tier and reads another.
    const kernel = await kernelWithTool();
    const a = await kernel.newAgentSession();
    const b = await kernel.newAgentSession();
    a.setApprovalMode('auto-edit');
    b.setApprovalMode('full');
    kernel.activateSession(a);
    expect(kernel.permission.approvalMode).toBe('auto-edit');
    kernel.permission.setMode('read-only');
    expect(a.approvalMode).toBe('read-only');
    expect(b.approvalMode).toBe('full');
    kernel.activateSession(b);
    expect(kernel.permission.approvalMode).toBe('full');
    await kernel.dispose();
  });
});
