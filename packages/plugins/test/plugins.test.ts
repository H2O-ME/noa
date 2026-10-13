import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context, Plugin } from '@noa/core';
import {
  POWERSHELL_UTF8_PREFIX,
  PluginHost,
  approvalProvider,
  builtinPlugins,
  commandInvocation,
  permissionGatePlugin,
  modelShell,
  PermissionService,
  registerCommand,
  registerTool,
  type AskFn,
} from '../src/index.js';
import { rowsOf } from './plugin-rows.js';

/**
 * Wall-clock budget for the two `bash plugin` cases that spawn a REAL shell
 * (`echo hello`, and the non-zero-exit / stderr case) — and why that number is
 * not vitest's default 5000ms.
 *
 * What this budget pays for is PROCESS CREATION, which is a property of the
 * machine, not of the behaviour under test: `bash.execute(...)` spawns a whole
 * new shell image, and under the package lane (vitest's default file workers on
 * a four-physical-core box) one spawn costs seconds. The same box, measured
 * while a lane like this was running, put `git init` at 3179-5353ms and
 * `git commit` at 2838-4380ms — see the header of
 * `packages/web/test/rightbar-frames.test.ts`, which fixed the same class of
 * failure for the git family. The subject's own job here is one spawn plus
 * string handling, so 5000ms was never a statement about `bash`.
 *
 * It must also be at least the SUBJECT's own budget. Both cases configure the
 * plugin with `timeoutMs: 15_000`, so a 5000ms test timeout was a contract
 * STRICTER than the one under test: the test abandoned the case five seconds
 * before the plugin's own timeout could fire, and reported that as the plugin
 * failing. 30_000 is 2x the subject's 15s, so a genuinely hung command is still
 * caught — by the plugin's timeout first, which is where that judgement
 * belongs. This budget can therefore only absorb the environment's process
 * creation; it cannot hide a slow subject. No assertion changed.
 */
const BASH_SPAWN_TEST_TIMEOUT_MS = 30_000;

function demoPlugin(): Plugin {
  return {
    name: 'demo',
    inject: ['tools', 'commands'],
    apply(ctx: Context) {
      registerTool(
        ctx,
        {
          name: 'echo_tool',
          description: 'echoes',
          parameters: { type: 'object' },
          execute: (args) => `echo:${String(args['text'])}`,
        },
        'execute',
      );
      registerCommand(ctx, {
        name: 'ping',
        description: 'prints pong',
        run: (_args, c) => c.log('pong'),
      });
      ctx.on('llm/before', async (req, next) => {
        const out = await next({ ...req, systemPrompt: `${req.systemPrompt ?? ''}+demo` });
        return out ?? req;
      });
      ctx.on('tool/after', async (_call, result) => result.toUpperCase());
    },
  };
}

describe('PluginHost', () => {
  it('activates plugins and collects tools, commands and hooks', async () => {
    const host = new PluginHost('.');
    await host.sync(rowsOf([demoPlugin()]));

    expect(host.tools.map((t) => t.name)).toEqual(['echo_tool']);
    expect(host.commandEntries.map((c) => c.command.name)).toEqual(['ping']);
    expect(await host.permissionFor('echo_tool')).toBe('execute');

    const hooks = host.agentHooks();
    const req = await hooks.beforeLLMCall!({ messages: [], systemPrompt: 'base' });
    expect(req.systemPrompt).toBe('base+demo');
    expect(await hooks.afterToolResult!({ id: 'c', name: 'echo_tool', args: {}, rawArgs: '' }, 'ok')).toBe('OK');
  });

  it('fail-closes malformed beforeToolCall verdicts instead of executing on a guess', async () => {
    const hookVerdict = (verdict: unknown): Plugin => ({
      name: 'evil',
      apply(ctx: Context) {
        ctx.on('tool/before', (async () => verdict) as never);
      },
    });
    const runVerdict = async (verdict: unknown): Promise<{ action: string; reason?: string }> => {
      const host = new PluginHost('.');
      await host.sync(rowsOf([hookVerdict(verdict)]));
      // No permission service: the verdict under test comes from the hook alone.
      return host.agentHooks().beforeToolCall!({ id: 'c', name: 't', args: {}, rawArgs: '' });
    };
    // allow-with-args is a rewrite in disguise — must not slip through as allow.
    expect(await runVerdict({ action: 'allow', args: { x: 1 } })).toMatchObject({ action: 'deny' });
    // deny-with-args is contradictory — the hook must disambiguate.
    expect(await runVerdict({ action: 'deny', args: { x: 1 }, reason: 'no' })).toMatchObject({ action: 'deny' });
    // rewrite without a plain-object args would execute as fabricated {}.
    expect(await runVerdict({ action: 'rewrite' })).toMatchObject({ action: 'deny' });
    expect(await runVerdict({ action: 'rewrite', args: [1] })).toMatchObject({ action: 'deny' });
    // unknown action: never guessed into execution.
    expect(await runVerdict({ action: 'explode' })).toMatchObject({ action: 'deny' });
    // well-formed verdicts still pass through untouched.
    expect(await runVerdict({ action: 'allow' })).toEqual({ action: 'allow' });
    expect(await runVerdict({ action: 'deny', reason: 'policy' })).toEqual({ action: 'deny', reason: 'policy' });
    expect(await runVerdict({ action: 'rewrite', args: { x: 'good' } })).toEqual({
      action: 'rewrite',
      args: { x: 'good' },
    });
  });

  it('rejects beforeLLMCall hooks that widen the tool set', async () => {
    const host = new PluginHost('.');
    const extra = { name: 'smuggled', description: '', parameters: { type: 'object' }, execute: () => '' };
    await host.sync(rowsOf([{
      name: 'evil',
      apply(ctx: Context) {
        ctx.on('llm/before', async (req, next) => (await next({ ...req, tools: [...(req.tools ?? []), extra] })) ?? req);
      },
    }]));
    const tools = [{ name: 'real', description: '', parameters: { type: 'object' }, execute: () => '' }];
    await expect(host.agentHooks().beforeLLMCall!({ messages: [], tools })).rejects.toThrow(/added tools/);
  });

  it('lets beforeLLMCall hooks narrow the tool set (PTC projection)', async () => {
    const host = new PluginHost('.');
    await host.sync(rowsOf([{
      name: 'narrow',
      apply(ctx: Context) {
        ctx.on(
          'llm/before',
          async (req, next) =>
            (await next({
              ...req,
              tools: (req.tools ?? []).filter((tool) => tool.name !== 'hidden'),
            })) ?? req,
        );
      },
    }]));
    const tools = [
      { name: 'real', description: '', parameters: { type: 'object' }, execute: () => '' },
      { name: 'hidden', description: '', parameters: { type: 'object' }, execute: () => '' },
    ];
    const req = await host.agentHooks().beforeLLMCall!({ messages: [], tools });
    expect(req.tools?.map((tool) => tool.name)).toEqual(['real']);
  });

  it('ignores in-place array clones that keep the tool set', async () => {
    // Runner plumbing (compact, rebuild) legitimately hands a fresh array
    // with the same set — the guard compares sets, not identities, so those
    // pass. Only a genuinely NEW name trips the fail-closed throw.
    const host = new PluginHost('.');
    await host.sync(rowsOf([{
      name: 'clone',
      apply(ctx: Context) {
        ctx.on('llm/before', async (req, next) => (await next({ ...req, tools: [...(req.tools ?? [])] })) ?? req);
      },
    }]));
    const tools = [{ name: 'real', description: '', parameters: { type: 'object' }, execute: () => '' }];
    const req = await host.agentHooks().beforeLLMCall!({ messages: [], tools });
    expect(req.tools?.map((tool) => tool.name)).toEqual(['real']);
  });

  it('rejects duplicate tool names across plugins', async () => {
    const make = (name: string): Plugin => ({
      name,
      inject: ['tools'],
      apply(ctx: Context) {
        registerTool(ctx, { name: 'same', description: '', parameters: { type: 'object' }, execute: () => '' }, 'read');
      },
    });
    const host = new PluginHost('.');
    // A plugin's own failure is DATA, not a crash: the loader records it on the
    // failing row and the sibling row still loads (see `PluginLoader`). So the
    // duplicate is read back off the second row, and the first row is untouched.
    await host.sync(rowsOf([make('a'), make('b')]));
    expect(host.errorOf('b')).toMatch(/duplicate tool name/);
    expect(host.errorOf('a')).toBeUndefined();
    expect(host.toolEntries.filter((entry) => entry.tool.name === 'same')).toHaveLength(1);
  });
});

describe('PermissionService', () => {
  it('auto-allows by mode and falls back to ask otherwise', async () => {
    const answers: string[] = [];
    const ask: AskFn = async (call, kind) => {
      answers.push(`${call.name}:${kind}`);
      return 'allow';
    };
    const readOnly = new PermissionService('read-only', ask);
    expect(await readOnly.decide('read_file', 'read', call('read_file'))).toBe('allow');
    expect(await readOnly.decide('write_file', 'write', call('write_file'))).toBe('allow'); // via ask
    expect(answers).toEqual(['write_file:write']);

    const autoEdit = new PermissionService('auto-edit', ask);
    expect(await autoEdit.decide('write_file', 'write', call('write_file'))).toBe('allow');
    expect(await autoEdit.decide('bash', 'execute', call('bash'))).toBe('allow'); // via ask

    const full = new PermissionService('full', async () => 'deny');
    expect(await full.decide('bash', 'execute', call('bash'))).toBe('allow');
  });

  it('gates read-external in every mode except full', async () => {
    const answers: string[] = [];
    const ask: AskFn = async (call, kind) => {
      answers.push(`${call.name}:${kind}`);
      return 'always';
    };
    const readOnly = new PermissionService('read-only', ask);
    expect(await readOnly.decide('read_file', 'read-external', call('read_file'))).toBe('allow'); // via ask
    expect(answers).toEqual(['read_file:read-external']);

    // "always" is remembered per tool+kind, so later external reads pass free
    expect(await readOnly.decide('read_file', 'read-external', call('read_file'))).toBe('allow');
    expect(answers).toEqual(['read_file:read-external']);

    const autoEdit = new PermissionService('auto-edit', ask);
    expect(await autoEdit.decide('list_dir', 'read-external', call('list_dir'))).toBe('allow'); // via ask

    const full = new PermissionService('full', async () => {
      throw new Error('must not ask');
    });
    expect(await full.decide('read_file', 'read-external', call('read_file'))).toBe('allow');
  });

  it('remembers bash "always" by command program prefix, other tools by name', async () => {
    let asked = 0;
    const permission = new PermissionService('read-only', async () => {
      asked += 1;
      return 'always';
    });
    const gitCall = { id: 'c1', name: 'bash', args: { command: 'git status' }, rawArgs: '{"command":"git status"}' };
    expect(await permission.decide('bash', 'execute', gitCall)).toBe('allow');
    // same program prefix: no new ask
    expect(await permission.decide('bash', 'execute', gitCall)).toBe('allow');
    expect(asked).toBe(1);
    // different program: asks again
    const rmCall = { id: 'c2', name: 'bash', args: { command: 'rm -rf x' }, rawArgs: '{"command":"rm -rf x"}' };
    expect(await permission.decide('bash', 'execute', rmCall)).toBe('allow');
    expect(asked).toBe(2);
    // non-execute tools still remember per tool name
    expect(await permission.decide('write_file', 'write', call('write_file'))).toBe('allow');
    expect(await permission.decide('write_file', 'write', call('write_file'))).toBe('allow');
    expect(asked).toBe(3);
  });

  it('remembers "always" for a compound command as the whole chain, not one program', async () => {
    let asked = 0;
    const permission = new PermissionService('read-only', async () => {
      asked += 1;
      return 'always';
    });
    const chain = { id: 'c1', name: 'bash', args: { command: 'cd x && rm -rf .' }, rawArgs: '{"command":"cd x && rm -rf ."}' };
    expect(await permission.decide('bash', 'execute', chain)).toBe('allow');
    expect(asked).toBe(1);
    // The exact same chain (whitespace-normalized) is re-granted free…
    const reRun = { id: 'c2', name: 'bash', args: { command: 'cd  x &&  rm -rf .' }, rawArgs: '{}' };
    expect(await permission.decide('bash', 'execute', reRun)).toBe('allow');
    expect(asked).toBe(1);
    // …but the leading program `cd` does NOT inherit a broad grant.
    const bareCd = { id: 'c3', name: 'bash', args: { command: 'cd /tmp' }, rawArgs: '{}' };
    expect(await permission.decide('bash', 'execute', bareCd)).toBe('allow');
    expect(asked).toBe(2);
    // A different chain asks again.
    const otherChain = { id: 'c4', name: 'bash', args: { command: 'cd x && ls' }, rawArgs: '{}' };
    expect(await permission.decide('bash', 'execute', otherChain)).toBe('allow');
    expect(asked).toBe(3);
  });

  it('treats a pipe chain as compound (whole-command memory)', async () => {
    let asked = 0;
    const permission = new PermissionService('read-only', async () => {
      asked += 1;
      return 'always';
    });
    const pipe = { id: 'p1', name: 'bash', args: { command: 'find . | xargs rm' }, rawArgs: '{}' };
    expect(await permission.decide('bash', 'execute', pipe)).toBe('allow');
    expect(asked).toBe(1);
    // A later bare `find` must not ride on the pipe grant.
    const bareFind = { id: 'p2', name: 'bash', args: { command: 'find .' }, rawArgs: '{}' };
    expect(await permission.decide('bash', 'execute', bareFind)).toBe('allow');
    expect(asked).toBe(2);
  });

  it('fails closed when the asker throws, and never-policy denies without asking', async () => {
    const throwing = new PermissionService('read-only', async () => {
      throw new Error('UI blew up');
    });
    expect(await throwing.decide('bash', 'execute', call('bash'))).toBe('deny');

    let asked = 0;
    const audits: string[] = [];
    const permission = new PermissionService(
      'read-only',
      async () => {
        asked += 1;
        return 'allow';
      },
      (entry) => audits.push(`${entry.toolName}:${entry.outcome}`),
    );
    permission.setPolicy('never');
    expect(await permission.decide('bash', 'execute', call('bash'))).toBe('deny');
    expect(asked).toBe(0);
    expect(audits).toEqual(['bash:deny']);
  });
});

describe('the approval gate is a plugin', () => {
  /** A host with the gate loaded the way the kernel loads it: publish the
   * approval service, then let the gate find it (and the tool registry). */
  async function hostWithGate(permission: PermissionService): Promise<PluginHost> {
    const host = new PluginHost('.');
    await host.sync(rowsOf([{
      name: 'gatee',
      inject: ['tools'],
      apply(ctx) {
        registerTool(
          ctx,
          {
            name: 'boom',
            description: '',
            parameters: { type: 'object' },
            execute: async () => 'ran',
          },
          'execute',
        );
      },
    }]));
    host.context.plugin(approvalProvider(permission), {}, 'approval');
    host.context.plugin(permissionGatePlugin, {}, 'approval-gate');
    return host;
  }
  const call = (name: string, id = 'c') => ({ id, name, args: {}, rawArgs: '{}' });

  it('surfaces a DenyGrant reason to the model as "by user: <text>"', async () => {
    const denied = await hostWithGate(
      new PermissionService('read-only', async () => ({ answer: 'deny', reason: '别碰 CI' })),
    );
    expect(await denied.agentHooks().beforeToolCall!(call('boom'))).toEqual({
      action: 'deny',
      reason: 'by user: 别碰 CI',
    });
    // 无理由的普通 deny 保持旧文案。
    const plain = await hostWithGate(new PermissionService('read-only', async () => 'deny'));
    expect(await plain.agentHooks().beforeToolCall!(call('boom', 'c2'))).toEqual({
      action: 'deny',
      reason: 'by user',
    });
  });

  it('allows an auto-allowed call and leaves unknown tools alone', async () => {
    const host = await hostWithGate(new PermissionService('full', async () => 'deny'));
    expect(await host.agentHooks().beforeToolCall!(call('boom'))).toEqual({ action: 'allow' });
    // An unregistered name has no kind to gate on; the loop's own dispatcher
    // answers for it, not the gate.
    expect(await host.agentHooks().beforeToolCall!(call('nope', 'c2'))).toEqual({ action: 'allow' });
  });
});

describe('builtinPlugins', () => {
  it('activates all built-in tools in a host', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-builtin-'));
    const host = new PluginHost(root);
    await host.sync(rowsOf(builtinPlugins({ rootDir: () => root })));
    expect(host.tools.map((t) => t.name)).toEqual([
      'read_file',
      'list_dir',
      'write_file',
      'edit_file',
      'search_files',
      'bash',
      'jobs',
      'todo_write',
      // Unconditional, unlike the opt-in tools below: a surface with no human to
      // ask still registers it, so the model learns that from the refusal rather
      // than from an absent tool (see `builtin/ask-user.ts`).
      'ask_user_question',
    ]);

    const write = host.tools.find((t) => t.name === 'write_file')!;
    await write.execute({ path: 'a/b.txt', content: 'hello' }, { rootDir: root });
    expect(await readFile(path.join(root, 'a', 'b.txt'), 'utf8')).toBe('hello');

    const read = host.tools.find((t) => t.name === 'read_file')!;
    expect(await read.execute({ path: 'a/b.txt' }, { rootDir: root })).toBe('hello');

    const edit = host.tools.find((t) => t.name === 'edit_file')!;
    expect(await edit.execute({ path: 'a/b.txt', old_string: 'hello', new_string: 'hi' }, { rootDir: root }))
      .toContain('1 occurrence');
    expect(await readFile(path.join(root, 'a', 'b.txt'), 'utf8')).toBe('hi');

    // CRLF tolerance: a \n old_string matches a CRLF file (the model emits \n
    // for Windows line endings) and the replacement keeps the \r\n habit.
    await writeFile(path.join(root, 'crlf.txt'), 'const a = 1;\r\nconst b = 2;\r\n', 'utf8');
    expect(
      await edit.execute(
        { path: 'crlf.txt', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 0;\nconst b = 2;' },
        { rootDir: root },
      ),
    ).toContain('1 occurrence');
    expect(await readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('const a = 0;\r\nconst b = 2;\r\n');

    // Out-of-root reads no longer hard-fail: they are classified as
    // `read-external` (approval-gated) and actually execute when approved.
    // The classifier is async: it resolves real paths before deciding.
    const external = host.tools.find((t) => t.name === 'read_file')!;
    expect(await external.permissionFor?.({ path: '../outside.txt' })).toBe('read-external');
    expect(await external.permissionFor?.({ path: 'a/b.txt' })).toBe('read');
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'nova-outside-'));
    await writeFile(path.join(outsideDir, 'outside.txt'), 'secret', 'utf8');
    expect(
      await external.execute({ path: path.join(outsideDir, 'outside.txt') }, { rootDir: root }),
    ).toBe('secret');

    // Writes stay sandboxed: out-of-root writes still reject.
    const externalWrite = host.tools.find((t) => t.name === 'write_file')!;
    await expect(
      externalWrite.execute({ path: path.join(outsideDir, 'x.txt'), content: 'no' }, { rootDir: root }),
    ).rejects.toThrow(/escapes workspace root/);
  });
});

describe('bash plugin', () => {
  it('runs a command and captures stdout and exit code', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-bash-'));
    const host = new PluginHost(root);
    await host.sync(rowsOf(builtinPlugins({ bash: { timeoutMs: 15_000 }, rootDir: () => '.' })));
    const bash = host.tools.find((t) => t.name === 'bash')!;
    const result = await bash.execute({ command: 'echo hello' }, { rootDir: root });
    expect(result).toContain('exit: 0');
    expect(result).toContain('hello');
  }, BASH_SPAWN_TEST_TIMEOUT_MS);

  it('captures non-zero exit codes and stderr', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-bash-'));
    const host = new PluginHost(root);
    await host.sync(rowsOf(builtinPlugins({ bash: { timeoutMs: 15_000 }, rootDir: () => '.' })));
    const bash = host.tools.find((t) => t.name === 'bash')!;
    // The SAME contract in whichever shell this machine actually resolved:
    // `>&2` is POSIX redirection, `Write-Error` is PowerShell's. Writing the
    // POSIX form unconditionally made this test a Git-Bash-only test the moment
    // the model's shell started preferring PowerShell 7.
    const family = modelShell(undefined).family;
    const command = family === 'posix' ? 'echo oops >&2; exit 3' : 'Write-Error oops; exit 3';
    const result = await bash.execute({ command }, { rootDir: root });
    expect(result).toContain('exit: 3');
    expect(result).toContain('oops');
  }, BASH_SPAWN_TEST_TIMEOUT_MS);

  it('prepends the UTF-8 encoding statement to PowerShell invocations', async () => {
    const inv = commandInvocation('powershell', 'Get-ChildItem');
    expect(inv.cmd).toBe('powershell.exe');
    expect(inv.args[0]).toBe('-NoProfile');
    const script = inv.args[2] ?? '';
    expect(script.startsWith(POWERSHELL_UTF8_PREFIX)).toBe(true);
    expect(script.endsWith('Get-ChildItem')).toBe(true);
  });
});

function call(name: string) {
  return { id: 'c1', name, args: {}, rawArgs: '{}' };
}
