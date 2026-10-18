/**
 * 遥控的执行面：把认得的指令接到内核接缝上（`qqbot-remote.ts`），以及**审批的
 * fail-closed**（`awaitRemoteAnswer`）。
 *
 * 内核接缝全部注入，所以每条指令都能对着假实现直接驱动。这里钉两件事故性的东西：
 *  - 换权限档**读回**确认（没落到就必须说没落到，不能报成功）；
 *  - 远程审批超时**必拒**——一个挂着的审批会把整轮运行永久停住，QQ 对端随时可能不回。
 */
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalMode, AskResult, PricingTable, TurnRewind, UsageStats } from '@noa/core';
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
function makeCtx(opts: { mode?: ApprovalMode; noPermissionService?: boolean; pending?: { id: string; call: { name: string } }[]; relay?: boolean; usage?: UsageStats; noUsageSeat?: boolean; pricing?: PricingTable; rewind?: (turns: number) => Promise<TurnRewind | undefined>; noSetDefault?: boolean; setDefault?: { ok: boolean; reason?: string }; selectRefusal?: string; configuredDefault?: string } = {}) {
  const calls: string[] = [];
  // A session WITHOUT a permission service: `setApprovalMode` no-ops and the
  // read-back stays undefined — the case the "did it land" check exists for.
  const detached = opts.noPermissionService === true;
  let mode: ApprovalMode | undefined = detached ? undefined : (opts.mode ?? 'auto');
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
          if (opts.selectRefusal !== undefined) return Promise.reject(new Error(opts.selectRefusal));
          calls.push(`model:${model}`);
          return Promise.resolve({ id: model });
        },
        ...(opts.noSetDefault === true
          ? {}
          : {
              setDefault: (model: string) => {
                calls.push(`default:${model}`);
                return Promise.resolve(opts.setDefault ?? { ok: true });
              },
              configuredDefault: () => Promise.resolve(opts.configuredDefault),
            }),
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
      ...(opts.noUsageSeat === true ? {} : { usage: () => opts.usage ?? zeroUsage() }),
      rewind: (turns) => {
        calls.push(`rewind:${turns}`);
        return opts.rewind === undefined ? Promise.resolve(undefined) : opts.rewind(turns);
      },
    },
    newSession: () => {
      calls.push('new');
      return Promise.resolve({} as never);
    },
    ...(opts.relay === true ? { relay: fakeRelay() } : {}),
    ...(opts.pricing === undefined ? {} : { pricing: opts.pricing }),
  };
  return { ctx, calls, resolved };
}

/** 一份全零的用量读数（各用例只覆盖自己关心的字段）。 */
function zeroUsage(overrides: Partial<UsageStats> = {}): UsageStats {
  return { turns: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, missTokens: 0, missTurns: 0, ...overrides };
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

  it('refuses to pretend a model switch happened with no model seat', async () => {
    const ctx = makeCtx().ctx;
    const bare: RemoteContext = { ...ctx, kernel: { ...ctx.kernel, models: undefined } };
    // 而且要把话说全：座位不在是「本部署的模型写在配置文件里」，不是「端点未配置」，
    // 更不能把人指向一个不存在的设置页（Noa 没有设置页）。
    for (const command of [{ kind: 'model', model: 'x' } as const, { kind: 'models' } as const]) {
      const reply = (await runRemoteCommand(command, bare)).reply;
      expect(reply).toContain('没有模型切换座位');
      expect(reply).toContain('config.json');
      expect(reply).not.toContain('设置页');
    }
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

  it('a plain switch changes the process and does NOT touch the config file', async () => {
    // 一个 provider 实例被所有对话共用，所以「切模型」本来就是全局的 —— 这一点必须
    // 说出来，否则操作者会以为它只影响当前会话。而没写 `default` 就不该动配置文件：
    // 重启后回到原样，回复也要这么讲。
    const { ctx, calls } = makeCtx();
    const out = await runRemoteCommand({ kind: 'model', model: 'model-b' }, ctx);
    expect(calls.filter((call) => call.startsWith('default:'))).toEqual([]);
    expect(out.reply).toContain('本进程');
    expect(out.reply).toContain('/model default model-b');
  });

  it('`/model default <id>` switches AND writes the default', async () => {
    const { ctx, calls } = makeCtx();
    const out = await runRemoteCommand({ kind: 'model', model: 'model-b', persist: true }, ctx);
    expect(calls).toContain('model:model-b');
    expect(calls).toContain('default:model-b');
    expect(out.reply).toContain('下次启动仍是它');
  });

  it('admits the default did not change when there is nothing to write it into', async () => {
    // 切到了就说切到了，但别把「默认也改了」说成事实 —— 这个进程没有可写的配置文件。
    const { ctx } = makeCtx({ noSetDefault: true });
    const out = await runRemoteCommand({ kind: 'model', model: 'model-b', persist: true }, ctx);
    expect(out.reply).toContain('模型已切到 model-b');
    expect(out.reply).toContain('默认模型没改');
  });

  it('names the reason when the write-back itself is refused', async () => {
    const { ctx } = makeCtx({ setDefault: { ok: false, reason: '配置里没有 provider 段，写不了默认模型' } });
    const out = await runRemoteCommand({ kind: 'model', model: 'model-b', persist: true }, ctx);
    expect(out.reply).toContain('模型已切到 model-b');
    expect(out.reply).toContain('没有 provider 段');
  });

  it('lists what exists when the endpoint refuses the id, instead of blaming the endpoint', async () => {
    // 拼错的名字在这里被拒并列出可选项，而不是让上游回 404、让人以为端点坏了。
    const { ctx, calls } = makeCtx({ selectRefusal: 'unknown model: modle-b' });
    const out = await runRemoteCommand({ kind: 'model', model: 'modle-b' }, ctx);
    expect(out.reply).toContain('模型未切换');
    expect(out.reply).toContain('unknown model');
    expect(out.reply).toContain('model-a');
    expect(calls.filter((call) => call.startsWith('default:'))).toEqual([]);
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
    for (const verb of ['/status', '/usage', '/perm', '/model', '/ws', '/new', '/sessions', '/use', '/unbind', '/stop', '/answer', '/approve', '/deny', '/help']) {
      expect(help).toContain(verb);
    }
    // The seat rule still holds: with no relay seat, the relay verbs are not
    // advertised — a line for a command that can only answer "no seat for that"
    // teaches the peer a command that will not work.
    const bare = (await runRemoteCommand({ kind: 'help' }, makeCtx().ctx)).reply;
    expect(bare).not.toContain('/sessions');
    expect(bare).not.toContain('/unbind');
  });

  it('advertises `/model default` only when something can actually write it', async () => {
    // 同一个座位规则：帮助里写一个做不到的动词，等于教对端一条没用的指令。
    const withWrite = (await runRemoteCommand({ kind: 'help' }, makeCtx().ctx)).reply;
    expect(withWrite).toContain('/model default <id>');
    const readOnly = (await runRemoteCommand({ kind: 'help' }, makeCtx({ noSetDefault: true }).ctx)).reply;
    expect(readOnly).toContain('/model <id>');
    expect(readOnly).not.toContain('/model default');
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

describe('/undo and /retry', () => {
  const plan = (turns: number): TurnRewind => ({
    keepIds: ['m1'],
    dropped: turns,
    prompt: { id: 'u9', ts: 0, role: 'user', content: '上次那句话' },
  });

  it('reports what actually went, not what was asked for', async () => {
    // `/undo 99` on a two-turn conversation drops two. Echoing the request would
    // be the same class of lie as a permission switch that never landed.
    const { ctx, calls } = makeCtx({ rewind: () => Promise.resolve({ ...plan(2), dropped: 2 }) });
    const out = await runRemoteCommand({ kind: 'undo', turns: 99 }, ctx);
    expect(calls).toContain('rewind:99');
    expect(out.reply).toContain('已回退 2 轮');
  });

  it('says there is nothing to take back instead of claiming a cut', async () => {
    const { ctx } = makeCtx({ rewind: () => Promise.resolve(undefined) });
    expect((await runRemoteCommand({ kind: 'undo', turns: 1 }, ctx)).reply).toContain('没有可以回退的轮次');
    expect((await runRemoteCommand({ kind: 'retry' }, ctx)).reply).toContain('没有可以重做的轮次');
  });

  it('reports the kernel refusal when a run is in flight', async () => {
    // The kernel refuses to splice the surface under a live request; the peer has
    // to be told, because "nothing happened" and "it refused" look identical.
    const { ctx } = makeCtx({ rewind: () => Promise.reject(new Error('会话正在跑一轮')) });
    expect((await runRemoteCommand({ kind: 'undo', turns: 1 }, ctx)).reply).toContain('回退失败：会话正在跑一轮');
  });

  it('makes /retry re-send the dropped turn\'s prompt, with no reply of its own', async () => {
    const { ctx, calls } = makeCtx({ rewind: () => Promise.resolve(plan(1)) });
    const out = await runRemoteCommand({ kind: 'retry' }, ctx);
    expect(calls).toContain('rewind:1');
    expect(out.reply).toBe('');
    expect(out.resend).toEqual({ text: '上次那句话' });
  });

  it('carries the dropped turn\'s images into the re-send', async () => {
    const image = { id: 'img_1', mediaType: 'image/png' as const, bytes: 3, digest: 'abc', file: 'D:/s/img_1.png' };
    const { ctx } = makeCtx({
      rewind: () => Promise.resolve({ ...plan(1), prompt: { ...plan(1).prompt, images: [image] } }),
    });
    const out = await runRemoteCommand({ kind: 'retry' }, ctx);
    expect(out.resend?.images).toEqual([image]);
  });

  it('advertises both verbs', async () => {
    const help = (await runRemoteCommand({ kind: 'help' }, makeCtx().ctx)).reply;
    expect(help).toContain('/undo');
    expect(help).toContain('/retry');
  });
});

describe('/usage', () => {
  const PRICED: PricingTable = { 'model-a': { input: 1, output: 2 } };
  const USED: UsageStats = {
    turns: 12,
    promptTokens: 1_000_000,
    completionTokens: 500_000,
    cachedTokens: 400_000,
    missTokens: 0,
    missTurns: 0,
  };

  it('turns the session totals into an estimate when the model is priced', async () => {
    const { ctx } = makeCtx({ usage: USED, pricing: PRICED });
    const reply = (await runRemoteCommand({ kind: 'usage' }, ctx)).reply;
    expect(reply).toContain('model-a');
    expect(reply).toContain('轮次：12');
    // 1M prompt @ $1/M + 0.5M completion @ $2/M = $2.00
    expect(reply).toContain('≈ $2.0000（输入 $1.0000 + 输出 $1.0000）');
  });

  it('groups thousands so a long-running session stays readable', async () => {
    const { ctx } = makeCtx({
      usage: zeroUsage({ promptTokens: 12_345_678, cachedTokens: 1_000_000, completionTokens: 987_654 }),
      pricing: PRICED,
    });
    const reply = (await runRemoteCommand({ kind: 'usage' }, ctx)).reply;
    expect(reply).toContain('输入：12,345,678 token（缓存命中 1,000,000）');
    expect(reply).toContain('输出：987,654 token');
  });

  it('says the model is UNPRICED instead of printing $0.00', async () => {
    // The failure this exists to prevent: a bare `$0.00` is indistinguishable from
    // "free", and an operator reading their bill would draw the opposite
    // conclusion from the truth.
    const noTable = (await runRemoteCommand({ kind: 'usage' }, makeCtx({ usage: USED }).ctx)).reply;
    expect(noTable).toContain('未配价');
    expect(noTable).not.toContain('$0');

    const unlisted = (await runRemoteCommand(
      { kind: 'usage' },
      makeCtx({ usage: USED, pricing: { 'other-model': { input: 1 } } }).ctx,
    )).reply;
    expect(unlisted).toContain('model-a 未配价');

    // An entry with neither side filled in has nothing to price with either.
    const empty = (await runRemoteCommand(
      { kind: 'usage' },
      makeCtx({ usage: USED, pricing: { 'model-a': {} } }).ctx,
    )).reply;
    expect(empty).toContain('未配价');
  });

  it('reports a LOWER BOUND when only one side is priced', async () => {
    // Pricing only the input side must not read as "the output was free": the sum
    // is a floor, and the line says so.
    const { ctx } = makeCtx({ usage: USED, pricing: { 'model-a': { input: 1 } } });
    const reply = (await runRemoteCommand({ kind: 'usage' }, ctx)).reply;
    expect(reply).toContain('≥ $1.0000（输入 $1.0000；未配价的一侧未计入）');
  });

  it('admits when this process keeps no usage accounting', async () => {
    const { ctx } = makeCtx({ noUsageSeat: true });
    expect((await runRemoteCommand({ kind: 'usage' }, ctx)).reply).toContain('读不到本会话的用量');
  });

  it('shows the cache-miss line only when there IS a miss', async () => {
    const quiet = (await runRemoteCommand({ kind: 'usage' }, makeCtx({ usage: USED, pricing: PRICED }).ctx)).reply;
    expect(quiet).not.toContain('未命中缓存');

    const wasting = (
      await runRemoteCommand(
        { kind: 'usage' },
        makeCtx({ usage: zeroUsage({ promptTokens: 5000, missTokens: 2000, missTurns: 3 }), pricing: PRICED }).ctx,
      )
    ).reply;
    expect(wasting).toContain('未命中缓存：2,000 token（按全价计，共 3 轮）');
  });

  it('never prints a nonzero amount as $0', async () => {
    // A single cheap turn can land below a millionth of a dollar. `$0` there is a
    // lie about a model that does cost money, so the floor is spelled as a bound.
    const { ctx } = makeCtx({ usage: zeroUsage({ promptTokens: 1 }), pricing: { 'model-a': { input: 0.01 } } });
    const reply = (await runRemoteCommand({ kind: 'usage' }, ctx)).reply;
    expect(reply).toContain('<$0.000001');
    expect(reply).not.toMatch(/≈ \$0\b/u);
  });

  it('keeps enough precision for a sub-cent amount to be worth reading', async () => {
    const { ctx } = makeCtx({ usage: zeroUsage({ promptTokens: 100, completionTokens: 100 }), pricing: PRICED });
    const reply = (await runRemoteCommand({ kind: 'usage' }, ctx)).reply;
    expect(reply).toContain('≈ $0.0003（输入 $0.0001 + 输出 $0.0002）');
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
