/**
 * 遥控的执行面：把认得的指令接到内核接缝上（`qqbot-remote.ts`），以及**审批的
 * fail-closed**（`awaitRemoteAnswer`）。
 *
 * 内核接缝全部注入，所以每条指令都能对着假实现直接驱动。这里钉两件事故性的东西：
 *  - 换权限档**读回**确认（没落到就必须说没落到，不能报成功）；
 *  - 远程审批超时**必拒**——一个挂着的审批会把整轮运行永久停住，QQ 对端随时可能不回。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalMode, AskResult } from '@noa/core';
import {
  awaitRemoteAnswer,
  runRemoteCommand,
  type RelayCandidate,
  type RemoteContext,
  type RemoteRelayPort,
} from '../src/remote.js';

/** 一个会话接力座位，只要「有」就够：本文件读的是 `/help` 与 `/sessions` 的**行**。 */
function fakeRelay(candidates: RelayCandidate[] = []): RemoteRelayPort {
  return {
    list: () => Promise.resolve(candidates),
    use: () => Promise.resolve({ ok: false, reason: '本夹具不做切换' }),
    unbind: () => Promise.resolve(),
    bound: () => undefined,
  };
}

/** 一个记下所有动作的假内核 + 假会话。`mode: undefined` 模拟没有权限服务的会话。 */
function makeCtx(opts: { mode?: ApprovalMode; noPermissionService?: boolean; pending?: { id: string; call: { name: string } }[]; relay?: boolean } = {}) {
  const calls: string[] = [];
  // A session WITHOUT a permission service: `setApprovalMode` no-ops and the
  // read-back stays undefined — the case the "did it land" check exists for.
  const detached = opts.noPermissionService === true;
  let mode: ApprovalMode | undefined = detached ? undefined : (opts.mode ?? 'read-only');
  const resolved: { id: string; answer: AskResult }[] = [];
  const ctx: RemoteContext = {
    kernel: {
      rootDir: () => 'D:/work',
      setWorkspace: (dir) => {
        if (dir === 'bad') return Promise.reject(new Error('not a directory'));
        calls.push(`ws:${dir}`);
        return Promise.resolve([]);
      },
      models: {
        current: () => 'model-a',
        list: () => Promise.resolve([{ models: [{ id: 'model-a' }, { id: 'model-b' }] }]),
        select: (model) => {
          calls.push(`model:${model}`);
          return Promise.resolve({ id: model });
        },
      },
    },
    session: {
      setApprovalMode: (next) => {
        if (detached) return;
        calls.push(`perm:${next}`);
        mode = next;
      },
      approvalMode: () => mode,
      pendingApprovals: () => opts.pending ?? [],
      resolveApproval: (id, answer) => {
        resolved.push({ id, answer });
        return true;
      },
    },
    newSession: () => {
      calls.push('new');
      return Promise.resolve({} as never);
    },
    // The machine's local grant. A peer may go this high and no higher; the cap
    // itself is pinned by its own case below.
    maxTier: 'full',
    ...(opts.relay === true ? { relay: fakeRelay() } : {}),
  };
  return { ctx, calls, resolved };
}

describe('remote command execution', () => {
  it('switches the permission tier and reads it back', async () => {
    const { ctx, calls } = makeCtx();
    const out = await runRemoteCommand({ kind: 'perm', mode: 'full' }, ctx);
    expect(calls).toContain('perm:full');
    expect(out.reply).toContain('全放行');
  });

  it('admits a permission switch that did not land', async () => {
    // `setApprovalMode` no-ops when the session has no permission service. A reply
    // that echoed the request would claim a switch the kernel never made.
    const { ctx } = makeCtx({ noPermissionService: true });
    const out = await runRemoteCommand({ kind: 'perm', mode: 'full' }, ctx);
    expect(out.reply).toContain('未能切换');
  });

  it('refuses a tier above the machine\'s own ceiling', async () => {
    // The whole point of driving a machine from a chat window is that a stolen
    // phone is not a stolen keyboard: the ceiling is applied where the tier would
    // CHANGE, so no other path can exceed it. The refusal names the limit rather
    // than silently granting the smaller tier, which a peer would read as success.
    const { ctx, calls } = makeCtx();
    const capped: RemoteContext = { ...ctx, maxTier: 'auto-edit' };
    const refused = await runRemoteCommand({ kind: 'perm', mode: 'full' }, capped);
    expect(refused.reply).toContain('最高只能到「自动编辑」');
    expect(calls).not.toContain('perm:full');
    // At or below the ceiling still works.
    expect((await runRemoteCommand({ kind: 'perm', mode: 'auto-edit' }, capped)).reply).toContain('自动编辑');
    expect(calls).toContain('perm:auto-edit');
    // Absent means the WEAKEST tier, never "unlimited".
    const bare: RemoteContext = { ...ctx, maxTier: undefined };
    expect((await runRemoteCommand({ kind: 'perm', mode: 'full' }, bare)).reply).toContain('最高只能到「只读」');
  });

  it('refuses to pretend a model switch happened with no model seat', async () => {
    const ctx = makeCtx().ctx;
    const bare: RemoteContext = { ...ctx, kernel: { ...ctx.kernel, models: undefined } };
    expect((await runRemoteCommand({ kind: 'model', model: 'x' }, bare)).reply).toContain('没有模型座位');
    expect((await runRemoteCommand({ kind: 'models' }, bare)).reply).toContain('没有模型座位');
  });

  it('lists the model ids and switches through the kernel seat', async () => {
    const { ctx, calls } = makeCtx();
    const list = await runRemoteCommand({ kind: 'models' }, ctx);
    expect(list.reply).toContain('model-a');
    expect(list.reply).toContain('model-b');
    const switched = await runRemoteCommand({ kind: 'model', model: 'model-b' }, ctx);
    expect(calls).toContain('model:model-b');
    expect(switched.reply).toContain('model-b');
  });

  it('reports a workspace refusal instead of swallowing it', async () => {
    const { ctx } = makeCtx();
    const refused = await runRemoteCommand({ kind: 'workspace', dir: 'bad' }, ctx);
    expect(refused.reply).toContain('not a directory');
    const moved = await runRemoteCommand({ kind: 'workspace', dir: 'D:/other' }, ctx);
    expect(moved.reply).toContain('D:/work');
  });

  it('answers an approval with a denial that carries a reason', async () => {
    // A bare `deny` would reach the model as an unexplained refusal; the reason is
    // what turns it into an instruction, which is the same contract the browser's
    // deny box honours.
    const { ctx, resolved } = makeCtx({ pending: [{ id: 'apr1', call: { name: 'bash' } }] });
    const out = await runRemoteCommand({ kind: 'approve', allow: false }, ctx);
    expect(out.reply).toContain('bash');
    expect(resolved).toEqual([{ id: 'apr1', answer: { answer: 'deny', reason: expect.any(String) } }]);
  });

  it('says there is nothing to approve when the queue is empty', async () => {
    const { ctx } = makeCtx();
    expect((await runRemoteCommand({ kind: 'approve', allow: true }, ctx)).reply).toContain('没有待审批');
  });

  it('advertises every verb it accepts, the session-relay ones included', async () => {
    // `/help` used to be built from the KERNEL port alone, so the three verbs that
    // live on the relay seat could never appear: the manual listed six commands
    // while the parser accepted eleven — and the omitted ones are the reason this
    // channel exists at all (会话接力: point the phone at the conversation the
    // desktop is working in). To whoever is reading, a hidden verb IS a missing verb.
    const { ctx } = makeCtx({ relay: true });
    const help = (await runRemoteCommand({ kind: 'help' }, ctx)).reply;
    for (const verb of ['/status', '/perm', '/model', '/ws', '/new', '/sessions', '/use', '/unbind', '/stop', '/answer', '/approve', '/deny', '/help']) {
      expect(help).toContain(verb);
    }
    // The seat rule still holds: with no relay seat, the relay verbs are not
    // advertised — a line for a command that can only answer "no seat for that"
    // teaches the peer a command that will not work.
    const bare = (await runRemoteCommand({ kind: 'help' }, makeCtx().ctx)).reply;
    expect(bare).not.toContain('/sessions');
    expect(bare).not.toContain('/unbind');
  });

  it('renders a session row the reader can choose by', async () => {
    // The listing used to print a handle and a directory and nothing else, so two
    // conversations in one directory read as two identical rows. A row now leads
    // with what the conversation is ABOUT, carries where and when it happened,
    // and keeps the handle LAST so the hint can point at one position.
    const relay = fakeRelay([
      { target: 'a1b2c3', id: 'sess_a1b2c3d4e5f6', file: 'D:/s/a1.jsonl', where: 'D:/work/agent', at: 1_760_000_000_000, title: '重构 qqbot 通道', busy: false, mine: true },
      { target: '9f8e7d', id: 'sess_9f8e7d6c5b4a', file: 'D:/s/9f.jsonl', where: 'D:/work/agent', at: 1_760_000_000_000, title: '', busy: true, mine: false },
    ]);
    const ctx: RemoteContext = { ...makeCtx().ctx, relay };
    const reply = (await runRemoteCommand({ kind: 'sessions' }, ctx)).reply;
    expect(reply).toContain('重构 qqbot 通道');
    expect(reply).toContain('D:/work/agent');
    expect(reply).toContain('[本对话]');
    // An unused conversation says so rather than showing an empty label.
    expect(reply).toContain('（还没说过话）');
    expect(reply).toContain('[进行中]');
    expect(reply).toMatch(/a1b2c3$/mu);
  });

  it('hands back the new session for /new so the caller can rebind', async () => {
    const { ctx, calls } = makeCtx();
    const out = await runRemoteCommand({ kind: 'new' }, ctx);
    expect(calls).toContain('new');
    expect(out.nextAgent).toBeDefined();
  });
});

describe('remote approval waiting', () => {
  it('fails CLOSED when the peer never answers', async () => {
    // The bound is the whole reason this function exists: an ask that waits
    // forever parks the run, and a QQ peer can always fail to reply.
    vi.useFakeTimers();
    try {
      const pending = awaitRemoteAnswer(() => new Promise(() => undefined), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the answer when the peer replies in time', async () => {
    expect(await awaitRemoteAnswer(() => Promise.resolve('/approve'), 5_000)).toBe('/approve');
  });
});
