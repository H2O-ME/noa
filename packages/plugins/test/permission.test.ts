import { describe, expect, it, vi } from 'vitest';
import { PermissionService, alwaysScopeWords, type AskAnswer, type AskFn, type AskResult, type PermissionKind } from '../src/permission.js';
import type { ToolCall } from '@noa/core';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: `call_${name}`,
  name,
  args,
  rawArgs: JSON.stringify(args),
});

const EXECUTE: PermissionKind = 'execute';
const READ_EXTERNAL: PermissionKind = 'read-external';

/** Asker that records every dispatch and answers from a fixed script. */
function scriptedAsk(answers: AskResult[]): { ask: AskFn; asked: ToolCall[] } {
  const asked: ToolCall[] = [];
  let i = 0;
  const ask: AskFn = async (c) => {
    asked.push(c);
    return answers[i++] ?? 'deny';
  };
  return { ask, asked };
}

describe('PermissionService auto-allow matrix', () => {
  it.each([
    ['auto', 'read', 'allow'],
    ['auto', 'write', 'allow'],
    // 联网读不过闸：抓一个 URL 改不了这台机器上的任何东西，而 Hermes 的审批根本不覆盖
    // 联网工具（它只管 bash 与文件写入）。这条曾经是 'ask'，代价是每次查资料都停住等一张
    // 卡 —— 对无人值守的手机端是最糟的失败模式。见 `permission.ts` 的 `autoAllows`。
    ['auto', 'network', 'allow'],
    ['auto', 'execute', 'ask'],
    ['auto', 'read-external', 'ask'],
    ['full', 'read', 'allow'],
    ['full', 'write', 'allow'],
    ['full', 'execute', 'allow'],
    ['full', 'network', 'allow'],
    ['full', 'read-external', 'allow'],
  ] as const)('%s + %s → asker dispatched: %s', async (mode, kind, gate) => {
    const { ask, asked } = scriptedAsk(['allow']);
    const svc = new PermissionService(mode, ask);
    if (gate === 'allow') {
      // Auto-allowed: the asker is never consulted.
      await expect(svc.decide('some_tool', kind, call('some_tool'))).resolves.toBe('allow');
      expect(asked).toHaveLength(0);
    } else {
      // 'ask' verdict: decide() consults the asker and adopts its answer.
      await expect(svc.decide('some_tool', kind, call('some_tool'))).resolves.toBe('allow');
      expect(asked).toHaveLength(1);
    }
  });

  it('auto-allowed calls never dispatch the asker nor write audit entries', async () => {
    const audit = vi.fn();
    const { ask, asked } = scriptedAsk(['allow']);
    const svc = new PermissionService('auto', ask, audit);
    await svc.decide('read_file', 'read', call('read_file'));
    expect(asked).toHaveLength(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it('setMode switches the gate at runtime (/perm semantics)', async () => {
    const { ask } = scriptedAsk(['allow']);
    const svc = new PermissionService('auto', ask);
    // `auto`: an execute call is gated — the asker is consulted and its allow adopted.
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('allow');
    svc.setMode('full');
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('allow'); // auto-allowed now
    expect(svc.approvalMode).toBe('full');
  });
});

describe('PermissionService fail-closed branches', () => {
  it("denies when the asker returns an invalid answer (not allow/deny/always)", async () => {
    const ask: AskFn = async () => 'maybe' as unknown as AskAnswer;
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('deny');
  });

  it('denies when the asker throws instead of opening the gate', async () => {
    const ask: AskFn = async () => {
      throw new Error('asker died');
    };
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('deny');
  });

  it("'never' policy denies deterministically without dispatching any asker", async () => {
    const { ask, asked } = scriptedAsk(['allow']); // asker WOULD allow — must never run
    const svc = new PermissionService('auto', ask);
    svc.setPolicy('never');
    expect(svc.approvalPolicy).toBe('never');
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('deny');
    expect(asked).toHaveLength(0);
  });

  it("a later-registered 'never' policy still short-circuits pending asks", async () => {
    const { ask, asked } = scriptedAsk(['allow']);
    const svc = new PermissionService('auto', ask);
    // First ask goes through the asker (policy is still 'ask').
    await svc.decide('bash', EXECUTE, call('bash'));
    expect(asked).toHaveLength(1);
    svc.setPolicy('never');
    // `read-external`（不是 `network`）当这个「仍被拦的种类」：联网读现在自动放行，见
    // auto-allow 矩阵那条注释。
    await expect(svc.decide('bash', READ_EXTERNAL, call('bash'))).resolves.toBe('deny');
    expect(asked).toHaveLength(1); // unchanged — no second dispatch
  });
});

describe('PermissionService always-memory scopes', () => {
  it("execute 'always' remembers the program prefix: git status grants git log but not rm", async () => {
    const { ask, asked } = scriptedAsk(['always', 'deny']);
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git status -sb' }))).resolves.toBe('allow');
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git log --oneline' }))).resolves.toBe('allow');
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'git log' }))).resolves.toBe('allow');
    // Different program under the same tool: still gated (asked again → deny).
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'rm -rf /tmp/x' }))).resolves.toBe('deny');
    expect(asked).toHaveLength(2); // git status + rm — git log came from memory
  });

  it('an env-assignment prefix is not the granted program: NOVA=1 git status does not grant NOVA=1 rm', async () => {
    const { ask, asked } = scriptedAsk(['always', 'deny']);
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'NOVA=1 git status' }))).resolves.toBe('allow');
    // Same program under a different assignment value: still covered by the grant.
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'NOVA=2 git log' }))).resolves.toBe('allow');
    // A DIFFERENT program behind the same prefix must not inherit the grant.
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'NOVA=1 rm -rf /tmp/x' }))).resolves.toBe('deny');
    expect(asked).toHaveLength(2); // git status + rm — git log came from memory
  });

  it('compound commands are remembered as the whole normalized chain, not their head program', async () => {
    const { ask } = scriptedAsk(['always']);
    const svc = new PermissionService('auto', ask);
    await expect(
      svc.decide('bash', EXECUTE, call('bash', { command: 'cd x && rm -rf .' })),
    ).resolves.toBe('allow');
    // Same chain modulo whitespace: re-granted without asking.
    await expect(
      svc.decide('bash', EXECUTE, call('bash', { command: 'cd   x   &&  rm -rf .' })),
    ).resolves.toBe('allow');
    // `cd` alone must NOT have been granted by the chain's head program.
    const { ask: fresh, asked } = scriptedAsk(['deny']);
    const svc2 = new PermissionService('auto', fresh);
    await expect(svc2.decide('bash', EXECUTE, call('bash', { command: 'cd y' }))).resolves.toBe('deny');
    expect(asked).toHaveLength(1); // it asked — the prefix grant did not leak
  });

  it('newline chains and command substitution are remembered whole, not by head program', async () => {
    // Multi-line: bash runs lines sequentially — remembering the head `echo`
    // would let `echo hi\nrm -rf …` grant a bare `echo` forever.
    const { ask } = scriptedAsk(['always']);
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'echo hi\nrm -rf /tmp/x' }))).resolves.toBe(
      'allow',
    );
    // Same command modulo whitespace: re-granted from the whole-command key.
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'echo  hi\nrm -rf /tmp/x' }))).resolves.toBe(
      'allow',
    );
    // But the head program alone was NOT granted.
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'echo plain' }))).resolves.toBe('deny');

    // Command substitution: the user approved a program, not an arbitrary
    // interpolated payload — `$(...)`/backtick force whole-command memory too.
    const { ask: fresh, asked } = scriptedAsk(['always', 'deny']);
    const svc2 = new PermissionService('auto', fresh);
    await expect(svc2.decide('bash', EXECUTE, call('bash', { command: 'echo $(rm -rf /tmp/x)' }))).resolves.toBe(
      'allow',
    );
    await expect(svc2.decide('bash', EXECUTE, call('bash', { command: 'echo plain' }))).resolves.toBe('deny');
    expect(asked).toHaveLength(2); // both went through the asker — no prefix leak
  });

  it("non-execute 'always' is remembered per tool name + kind only", async () => {
    const { ask } = scriptedAsk(['always', 'deny', 'deny']);
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('read_external', READ_EXTERNAL, call('read_external', { path: 'a' }))).resolves.toBe('allow');
    await expect(svc.decide('read_external', READ_EXTERNAL, call('read_external', { path: 'b' }))).resolves.toBe('allow');
    // Same tool, different kind: still gated. (`execute` is the other still-gated
    // kind — a network read is auto-allowed now.)
    await expect(svc.decide('read_external', EXECUTE, call('read_external'))).resolves.toBe('deny');
    // Different tool, same kind: still gated.
    await expect(svc.decide('other_reader', READ_EXTERNAL, call('other_reader'))).resolves.toBe('deny');
  });

  it('check() reports remembered and auto-allowed calls without asking', async () => {
    const { ask, asked } = scriptedAsk(['always']);
    const svc = new PermissionService('auto', ask);
    await svc.decide('bash', EXECUTE, call('bash', { command: 'git status' }));
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'git diff' }))).resolves.toBe('allow');
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'curl evil' }))).resolves.toBe('ask');
    expect(asked).toHaveLength(1);
  });
});

describe('PermissionService adjustable always scope (M10 组件6)', () => {
  it('a 2-word grant covers the same prefix but never a sibling subcommand', async () => {
    const { ask, asked } = scriptedAsk([{ answer: 'always', scopeWords: 2 }, 'deny']);
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git status -sb' }))).resolves.toBe('allow');
    // 前 2 词命中即放行（含更多尾词）。
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git status --porcelain' }))).resolves.toBe('allow');
    // 更短的同前缀命令：词数不足 2，前缀语义不成立 → 重新询问（脚本 deny）。
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git' }))).resolves.toBe('deny');
    expect(asked).toHaveLength(2);
    // 兄弟子命令绝不命中。
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'git commit -m x' }))).resolves.toBe('ask');
    // 程序前缀也没被记住——范围比默认更紧。
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'git log' }))).resolves.toBe('ask');
  });

  it('out-of-range / compound / non-execute grants fall back to the default scope', async () => {
    // N 超出命令词数：回落默认（程序前缀），不抛错也不放大授权。
    const { ask } = scriptedAsk([{ answer: 'always', scopeWords: 9 }, 'allow']);
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git status' }))).resolves.toBe('allow');
    await expect(svc.check('bash', EXECUTE, call('bash', { command: 'git log' }))).resolves.toBe('allow'); // exec:git 生效

    // 复合命令没有词前缀语义：scope grant 回落整条记忆。
    const { ask: ask2 } = scriptedAsk([{ answer: 'always', scopeWords: 2 }]);
    const svc2 = new PermissionService('auto', ask2);
    await expect(svc2.decide('bash', EXECUTE, call('bash', { command: 'cd x && git status' }))).resolves.toBe('allow');
    await expect(svc2.check('bash', EXECUTE, call('bash', { command: 'git log' }))).resolves.toBe('ask');
    await expect(svc2.check('bash', EXECUTE, call('bash', { command: 'cd x && git   status' }))).resolves.toBe('allow');

    // 非 execute 的 grant：scope 无意义，回落 tool:kind。
    const { ask: ask3 } = scriptedAsk([{ answer: 'always', scopeWords: 3 }]);
    const svc3 = new PermissionService('auto', ask3);
    await expect(svc3.decide('read_external', READ_EXTERNAL, call('read_external', { path: 'a' }))).resolves.toBe('allow');
    await expect(svc3.decide('read_external', READ_EXTERNAL, call('read_external', { path: 'b' }))).resolves.toBe('allow');
  });

  it('malformed grants deny (fail-closed), plain AskAnswer strings keep working', async () => {
    const bad: unknown[] = [
      { answer: 'always', scopeWords: 0 },
      { answer: 'always', scopeWords: 1.5 },
      { answer: 'always' },
      { answer: 'allow', scopeWords: 2 },
      { answer: 'yes', scopeWords: 2 },
      'maybe',
    ];
    for (const raw of bad) {
      const ask: AskFn = async () => raw as AskResult;
      const svc = new PermissionService('auto', ask);
      await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'git status' }))).resolves.toBe('deny');
    }
  });

  it('alwaysScopeWords: bare commands expose tokens, compound/empty expose none', () => {
    expect(alwaysScopeWords(' git  status -sb ')).toEqual(['git', 'status', '-sb']);
    expect(alwaysScopeWords('git commit -m "two words"')).toHaveLength(5); // 词法前缀本就朴素
    expect(alwaysScopeWords('echo $(whoami)')).toEqual([]);
    expect(alwaysScopeWords('ls && ls')).toEqual([]);
    expect(alwaysScopeWords('')).toEqual([]);
    expect(alwaysScopeWords(undefined)).toEqual([]);
    expect(alwaysScopeWords(42)).toEqual([]);
  });
});

describe('PermissionService deny with reason (M10 组件7)', () => {
  it('DenyGrant carries the user-typed reason through decideDetailed', async () => {
    const svc = new PermissionService('auto', scriptedAsk([{ answer: 'deny', reason: ' 别碰 CI ' }]).ask);
    await expect(svc.decideDetailed('bash', EXECUTE, call('bash', { command: 'rm x' }))).resolves.toEqual({
      decision: 'deny',
      reason: '别碰 CI',
    });
  });

  it('plain deny / blank or non-string reasons deny without a reason', async () => {
    const plain = new PermissionService('auto', scriptedAsk(['deny']).ask);
    await expect(plain.decideDetailed('bash', EXECUTE, call('bash'))).resolves.toEqual({ decision: 'deny' });
    const blank = new PermissionService('auto', scriptedAsk([{ answer: 'deny', reason: '   ' }]).ask);
    await expect(blank.decideDetailed('bash', EXECUTE, call('bash'))).resolves.toEqual({ decision: 'deny' });
    const junk = new PermissionService(
      'auto',
      scriptedAsk([{ answer: 'deny', reason: 42 } as unknown as AskResult]).ask,
    );
    await expect(junk.decideDetailed('bash', EXECUTE, call('bash'))).resolves.toEqual({ decision: 'deny' });
  });

  it("decide() keeps the flat 'allow'|'deny' contract; 'never' denies reasonless; allow stays a string", async () => {
    const svc = new PermissionService('auto', scriptedAsk([{ answer: 'deny', reason: 'x' }]).ask);
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('deny');
    const never = new PermissionService('auto', scriptedAsk([{ answer: 'deny', reason: 'x' }]).ask);
    never.setPolicy('never');
    await expect(never.decideDetailed('bash', EXECUTE, call('bash'))).resolves.toEqual({ decision: 'deny' });
    const ok = new PermissionService('auto', scriptedAsk(['allow']).ask);
    await expect(ok.decideDetailed('bash', EXECUTE, call('bash'))).resolves.toBe('allow');
  });
});

describe('PermissionService ask serialization', () => {
  it('concurrent ask-path decides dispatch the asker one at a time (modal contract)', async () => {
    // PTC run_code fires parallel sub-calls through the same PermissionService.
    // Without serialization both asks race for the single approval modal —
    // the displaced one never resolves and the run hangs.
    let releaseFirst: (() => void) | undefined;
    let secondStarted = false;
    const ask: AskFn = async (c) => {
      if (c.id === 'call_a') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return 'always';
      }
      secondStarted = true;
      return 'deny';
    };
    const svc = new PermissionService('auto', ask);
    const first = svc.decide('bash', EXECUTE, { id: 'call_a', name: 'bash', args: { command: 'git status' }, rawArgs: '{"command":"git status"}' });
    const second = svc.decide('bash', EXECUTE, { id: 'call_b', name: 'bash', args: { command: 'rm -rf x' }, rawArgs: '{"command":"rm -rf x"}' });

    // While the first ask is pending, the second must not have been dispatched.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondStarted).toBe(false);

    releaseFirst?.();
    await expect(first).resolves.toBe('allow');
    await expect(second).resolves.toBe('deny');
    expect(secondStarted).toBe(true);
  });

  it('a failing ask does not poison the queue — the next ask still runs', async () => {
    let throwing = true;
    const ask: AskFn = async () => {
      if (throwing) throw new Error('modal torn down');
      return 'allow';
    };
    const svc = new PermissionService('auto', ask);
    await expect(svc.decide('bash', EXECUTE, call('bash'))).resolves.toBe('deny'); // fail-closed
    throwing = false;
    // The chain swallowed the failure: the next ask-path decide dispatches.
    await expect(svc.decide('bash', EXECUTE, call('bash', { command: 'ls' }))).resolves.toBe('allow');
  });
});

describe('PermissionService audit', () => {
  it('records every ask-path outcome, including fail-closed denials', async () => {
    const audit = vi.fn<(e: { toolName: string; kind: PermissionKind; outcome: AskAnswer }) => void>();
    const throwing: AskFn = async () => {
      throw new Error('boom');
    };
    const svc = new PermissionService('auto', throwing, audit);
    await svc.decide('bash', EXECUTE, call('bash', { command: 'ls' }));
    expect(audit).toHaveBeenCalledWith({ toolName: 'bash', kind: EXECUTE, outcome: 'deny' });

    const { ask } = scriptedAsk(['always']);
    const svc2 = new PermissionService('auto', ask, audit);
    await svc2.decide('read_external', READ_EXTERNAL, call('read_external'));
    expect(audit).toHaveBeenCalledWith({ toolName: 'read_external', kind: READ_EXTERNAL, outcome: 'always' });
  });
});
