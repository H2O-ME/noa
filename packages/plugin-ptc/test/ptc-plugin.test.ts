/**
 * PTC plugin integration: the SDK projection at the beforeLLMCall seam, and the
 * run_code bridge driving a real worker program over a scripted dispatch
 * pipeline (ordering, barriers, audit, denial propagation).
 */
import { describe, expect, it } from 'vitest';
import type {
  Context,
  SessionEvent,
  ToolDefinition,
  ToolDispatchCall,
  ToolDispatchResult,
  ToolExecuteContext,
} from '@noa/core';
import { builtinPlugins, PluginHost, registerTool } from '@noa/plugins';
import { plugin as ptcPlugin, RUN_CODE_NAME } from '../src/index.js';
import type { PtcPluginConfig } from '../src/index.js';

function fakeTool(name: string, opts: { parallel?: boolean } = {}): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: false,
    },
    execute: () => `${name}:ok`,
    ...(opts.parallel === true ? { isConcurrencySafe: () => true } : {}),
  };
}

/**
 * The row's settings travel as the entry's `config` — the plugin reads its own
 * budgets, so a test mounts it the way the tree does (`sync` with an id and a
 * config) rather than by calling a factory the host used to construct.
 */
async function hostWith(tools: ToolDefinition[], config: PtcPluginConfig = {}): Promise<PluginHost> {
  const host = new PluginHost('.');
  await host.sync([
    ...tools.map((tool) => ({
      id: `t-${tool.name}`,
      plugin: {
        name: `t-${tool.name}`,
        inject: ['tools'],
        apply: (ctx: Context) => registerTool(ctx, tool, 'read'),
      },
    })),
    { id: 'ptc', plugin: ptcPlugin, config },
  ]);
  return host;
}

function runCodeTool(host: PluginHost): ToolDefinition {
  const tool = host.tools.find((item) => item.name === RUN_CODE_NAME);
  if (tool === undefined) throw new Error('run_code not registered');
  return tool;
}

function makeCtx(
  dispatch: ToolExecuteContext['dispatch'],
  events: SessionEvent[] = [],
): ToolExecuteContext {
  return { rootDir: '.', dispatch, emit: (evt) => { events.push(evt); } };
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 10_000) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('ptc presentation', () => {
  it('appends the SDK to the system prompt, byte-stably, and never narrows the tool list', async () => {
    const host = await hostWith([fakeTool('echo'), fakeTool('other')]);
    const hooks = host.agentHooks();
    const req: ChatRequest = { messages: [], systemPrompt: 'BASE', tools: host.tools };
    const first = await hooks.beforeLLMCall!(req);
    // run_code is an ORDINARY tool: the native schemas ride through untouched.
    expect(first.tools!.map((tool) => tool.name).sort()).toEqual(['echo', 'other', RUN_CODE_NAME]);
    expect(first.systemPrompt!.startsWith('BASE')).toBe(true);
    expect(first.systemPrompt).toContain('declare const tools');
    expect(first.systemPrompt).toContain('echo');
    expect(first.systemPrompt).not.toContain('direct tool calls are OFF');
    const second = await hooks.beforeLLMCall!({ ...req, messages: [] });
    expect(second.systemPrompt).toBe(first.systemPrompt);
  });

  it('requests without run_code pass through untouched', async () => {
    const host = await hostWith([fakeTool('echo')]);
    const hooks = host.agentHooks();
    const req: ChatRequest = { messages: [], systemPrompt: 'BASE' };
    const out = await hooks.beforeLLMCall!(req);
    expect(out).toBe(req);
  });

  it('is NOT part of the built-in roster any more — the plugin loads from its own package by spec', async () => {
    // The extraction contract: the base roster contains no ptc row, so an
    // install without `@noa/plugin-ptc` still assembles; the kernel
    // reaches this plugin through `extensions.ts`'s spec table instead.
    expect(builtinPlugins({ rootDir: () => '.' }).some((plugin) => plugin.name === 'ptc')).toBe(false);
    // The plugin itself still registers the transport when applied directly.
    const host = await hostWith([]);
    expect(host.tools.some((tool) => tool.name === RUN_CODE_NAME)).toBe(true);
  });
});

describe('run_code bridge', () => {
  it('runs a program, resolves bindings through dispatch, curates output and audits each sub-call', async () => {
    const host = await hostWith([fakeTool('echo')]);
    const events: SessionEvent[] = [];
    const seen: ToolDispatchCall[] = [];
    const dispatch = async (call: ToolDispatchCall): Promise<ToolDispatchResult> => {
      seen.push(call);
      return { ok: true, result: `got:${JSON.stringify(call.args)}` };
    };
    const out = await runCodeTool(host).execute(
      {
        code: "const r = await tools.echo({ text: 'hi' });\nconsole.log('mid');\nreturn r;",
        description: 'read the echo tool',
      },
      makeCtx(dispatch, events),
    );
    expect(out).toContain('mid');
    expect(out).toContain('got:{"text":"hi"}');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('echo');
    const audits = events.filter((evt) => evt.type === 'code-dispatch');
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    if (audit.type === 'code-dispatch') {
      expect(audit.toolName).toBe('echo');
      expect(audit.isError).toBe(false);
      expect(audit.resultPreview).toContain('got:');
    }
  });

  it('surfaces denied sub-calls to the program as catchable ToolCallError', async () => {
    const host = await hostWith([fakeTool('echo')]);
    const events: SessionEvent[] = [];
    const dispatch = async (): Promise<ToolDispatchResult> => ({ ok: false, error: 'Permission denied: by user' });
    const out = await runCodeTool(host).execute(
      {
        code: "let msg = 'no-throw';\ntry { await tools.echo({}); } catch (e) { msg = `${e.name}:${e.toolName}:${e.message}`; }\nreturn msg;",
        description: 'denied call',
      },
      makeCtx(dispatch, events),
    );
    expect(out).toBe('ToolCallError:echo:Permission denied: by user');
    const audit = events.find((evt) => evt.type === 'code-dispatch');
    if (audit !== undefined && audit.type === 'code-dispatch') expect(audit.isError).toBe(true);
    else throw new Error('missing audit event');
  });

  it('drives the dispatch queue: submission order, exclusive barrier, overlapping parallel reads', async () => {
    const host = await hostWith([
      fakeTool('mutate'),
      fakeTool('readA', { parallel: true }),
      fakeTool('readB', { parallel: true }),
    ]);
    interface Gate {
      name: string;
      settle(result: ToolDispatchResult): void;
    }
    const calls: Gate[] = [];
    const dispatch = (call: ToolDispatchCall): Promise<ToolDispatchResult> =>
      new Promise<ToolDispatchResult>((resolve) => {
        calls.push({ name: call.name, settle: resolve });
      });
    const running = runCodeTool(host).execute(
      {
        code:
          'const [m, ab] = await Promise.all([\n'
          + '  tools.mutate({}),\n'
          + '  Promise.all([tools.readA({}), tools.readB({})]),\n'
          + ']);\n'
          + "return m + '|' + ab.join(',');",
        description: 'ordering',
      },
      makeCtx(dispatch),
    );
    // The exclusive call starts alone; the two parallel-safe submissions wait for the barrier.
    await waitFor(() => calls.length >= 1, 'mutate start');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.map((call) => call.name)).toEqual(['mutate']);
    calls[0]!.settle({ ok: true, result: 'm' });
    // After the barrier, both reads run concurrently (both start before either settles).
    await waitFor(() => calls.length >= 3, 'reads start');
    expect(calls.map((call) => call.name)).toEqual(['mutate', 'readA', 'readB']);
    calls[1]!.settle({ ok: true, result: 'a' });
    calls[2]!.settle({ ok: true, result: 'b' });
    expect(await running).toBe('m|a,b');
  });

  it('reports failed code runs with the failure kind and captured logs', async () => {
    const host = await hostWith([fakeTool('echo')]);
    const out = await runCodeTool(host).execute(
      { code: "console.log('before');\nthrow new Error('inside');", description: 'throwing' },
      makeCtx(async () => ({ ok: true, result: 'x' })),
    );
    expect(out).toContain('Error: code run failed (exception)');
    expect(out).toContain('inside');
    expect(out).toContain('before');
  });

  it('validates arguments and context', async () => {
    const host = await hostWith([fakeTool('echo')]);
    const tool = runCodeTool(host);
    expect(await tool.execute({ code: '  ', description: 'x' }, makeCtx(undefined))).toContain('code is required');
    expect(await tool.execute({ code: 'return 1;' }, makeCtx(undefined))).toContain('description is required');
    expect(await tool.execute({ code: 'return 1;', description: 'x' }, makeCtx(undefined))).toContain('nested tool dispatch');
    expect(await tool.execute({ code: 'return 1 + 2;', description: 'x' }, makeCtx(async () => ({ ok: true, result: 'unused' }))))
      .toBe('3');
  });

  it('preview renders the description and the program head', async () => {
    const host = await hostWith([fakeTool('echo')]);
    const preview = await runCodeTool(host).preview!(
      { description: 'do things', code: 'return 1;\nreturn 2;' },
      { rootDir: '.' },
    );
    expect(preview).toContain('run_code: do things');
    expect(preview).toContain('return 1;');
  });
});
