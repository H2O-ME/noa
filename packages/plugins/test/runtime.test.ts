/**
 * createAgentKernel — the shared assembly point (M11 批1b): fragment seeding,
 * real PermissionService over the ApprovalBroker event flow, headless never
 * policy, PTC mode rebuild. Scripted provider, tmp dirs, zero network.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isContextFragment,
  jobs as jobsKey,
  sessionWorkspace,
  type ChatProvider,
  type ChatRequest,
  type KernelEvent,
  type PluginEntryOptions,
  type StreamEvent,
} from '@noa/core';
import { createAgentKernel, registerCommand, registerTool, type Plugin } from '../src/index.js';

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

/**
 * A provider that records every request and always answers with one short text.
 * Used to assert what the model actually RECEIVED (the seeded fragment), which
 * a projection-level assertion cannot prove.
 */
function capturingProvider(requests: ChatRequest[]): ChatProvider {
  return {
    async *stream(req: ChatRequest) {
      requests.push(req);
      yield { type: 'text_delta', text: 'ok' };
    },
  };
}

const askToolScript: StreamEvent[] = [
  {
    type: 'tool_call_delta',
    index: 0,
    id: 'call_a',
    name: 'probe',
    argsDelta: '{"q":"x"}',
  },
];
const answerScript: StreamEvent[] = [{ type: 'text_delta', text: 'final answer' }];

/** One `todo_write` call carrying a two-item plan. */
const todoToolScript: StreamEvent[] = [
  {
    type: 'tool_call_delta',
    index: 0,
    id: 'call_todo',
    name: 'todo_write',
    argsDelta: JSON.stringify({
      todos: [
        { content: '读代码', status: 'in_progress' },
        { content: '写补丁', status: 'pending' },
      ],
    }),
  },
];

function probePlugin(log: string[]): Plugin {
  return {
    name: 'probe',
    inject: ['tools'],
    apply(ctx) {
      registerTool(
        ctx,
        {
          name: 'probe',
          description: 'test probe',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          execute: (args) => {
            log.push(String(args['q'] ?? ''));
            return 'probed';
          },
          presentCall: (args) => ({
            card: 'generic',
            kind: 'other',
            title: `probe:${String(args['q'] ?? '')}`,
          }),
        },
        'execute',
      );
    },
  };
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nova-kernel-asm-'));
}

const baseConfig = { approval: 'auto' as const };

describe('createAgentKernel', () => {
  it('seeds the context fragment and workspace marker into a fresh session', async () => {
    const dir = await tmp();
    const kernel = await createAgentKernel({
      rootDir: dir,
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    const first = kernel.agent.messages[0];
    expect(first).toBeDefined();
    expect(first !== undefined && isContextFragment(first)).toBe(true);
    expect(String(first?.content)).toContain('<environment>');
    expect(String(first?.content)).toContain(`cwd=${dir}`);
    expect(kernel.agent.session.events.some((e) => e.type === 'workspace')).toBe(true);

    await kernel.agent.prompt('hello');
    for (let i = 0; i < 2000 && kernel.agent.running; i++) await new Promise((r) => setTimeout(r, 1));
    const logged = kernel.agent.session.allMessages();
    // seeded context fragment + the prompt, then the assistant reply
    expect(logged.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
  });

  it('kernel.jobs is the container-provided registry — the service seam, not a copy', async () => {
    const seen: { jobs?: unknown } = {};
    const probe: Plugin = {
      name: 'jobs-probe',
      inject: [jobsKey],
      apply(ctx) {
        seen.jobs = ctx.must(jobsKey);
      },
    };
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
      extraPlugins: [{ id: 'jobs-probe', plugin: probe }],
    });
    // The probe reads through the container; the facade must hand back the
    // SAME instance — a second registry would fork background-job state.
    expect(seen.jobs).toBeDefined();
    expect(kernel.jobs).toBe(seen.jobs);
  });

  it('moves the current session\'s workspace marker when the workspace moves', async () => {
    const first = await tmp();
    const second = await tmp();
    const kernel = await createAgentKernel({
      rootDir: first,
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    // The listing files a session by the NEWEST marker in its log, so the one
    // written at creation is only correct while the session stays put.
    expect(sessionWorkspace(kernel.agent.session)).toBe(first);
    await kernel.setWorkspace(second);
    expect(kernel.rootDir()).toBe(second);
    expect(sessionWorkspace(kernel.agent.session)).toBe(second);

    // Re-pointing at the directory the marker already names must not append a
    // line: resuming a session restores its own workspace, which is the common
    // path and would otherwise grow every log by one event per switch.
    const before = kernel.agent.session.events.filter((e) => e.type === 'workspace').length;
    await kernel.setWorkspace(second);
    expect(kernel.agent.session.events.filter((e) => e.type === 'workspace')).toHaveLength(before);
  });

  it('re-seeds a still-blank session so the NEW workspace\'s context is sent', async () => {
    const first = await tmp();
    const second = await tmp();
    await writeFile(path.join(first, 'AGENTS.md'), 'DOC-FIRST', 'utf8');
    await writeFile(path.join(second, 'AGENTS.md'), 'DOC-SECOND', 'utf8');
    const requests: ChatRequest[] = [];
    const kernel = await createAgentKernel({
      rootDir: first,
      provider: capturingProvider(requests),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    const fragment = (): string => kernel.buildFragment();
    expect(fragment()).toContain('DOC-FIRST');
    const before = kernel.agent.session.file;

    await kernel.setWorkspace(second);

    // A session nobody has spoken to yet follows the workspace: its fragment is
    // built at creation, so leaving it alone would send the old project's docs
    // on the first prompt. The log is replaced, not rewritten.
    expect(kernel.agent.session.file).not.toBe(before);
    expect(fragment()).toContain('DOC-SECOND');
    await kernel.agent.prompt('hi');
    // `prompt()` starts the run and returns; the request reaches the provider on
    // the next tick, so poll rather than assuming it already arrived.
    while (requests.length === 0) await new Promise((r) => setTimeout(r, 1));
    const sent = requests[0]?.messages.map((m) => String(m.content)).join('\n') ?? '';
    expect(sent).toContain('DOC-SECOND');
    expect(sent).not.toContain('DOC-FIRST');

    // Re-pointing at the directory already in force must NOT mint another log:
    // resuming restores a session's own workspace, so this is the common path.
    const settled = kernel.agent.session.file;
    await kernel.setWorkspace(second);
    expect(kernel.agent.session.file).toBe(settled);
    await kernel.dispose();
  });

  it('leaves a session that has already spoken alone when the workspace moves', async () => {
    const first = await tmp();
    const second = await tmp();
    const kernel = await createAgentKernel({
      rootDir: first,
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    await kernel.agent.prompt('first turn');
    const spoken = kernel.agent.session.file;

    await kernel.setWorkspace(second);

    // Its fragment is the truthful record of the workspace those turns ran in;
    // rewriting it is what append-only forbids.
    expect(kernel.agent.session.file).toBe(spoken);
    expect(kernel.rootDir()).toBe(second);
    await kernel.dispose();
  });

  it('never replaces a RESUMED blank session when the workspace moves', async () => {
    const first = await tmp();
    const second = await tmp();
    // A blank log created in `second`, then resumed while the kernel is rooted
    // at `first` — the shape `/resume` produces for a session nobody has used.
    const origin = await createAgentKernel({
      rootDir: second,
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    const resumedFile = origin.agent.session.file;
    await origin.dispose();

    const requests: ChatRequest[] = [];
    const kernel = await createAgentKernel({
      rootDir: first,
      provider: capturingProvider(requests),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    await kernel.newAgentSession({ resumeFile: resumedFile });
    expect(kernel.agent.session.file).toBe(resumedFile);

    await kernel.setWorkspace(second);

    // The log is a durable artifact the reader chose to open: replacing it would
    // discard that choice and leave their `ready` naming a log they never asked
    // for. The marker step already corrected it for every future reader.
    expect(kernel.agent.session.file).toBe(resumedFile);
    await kernel.dispose();
  });

  it('publishes a todo event when the model writes a plan', async () => {
    const dir = await tmp();
    // The chain this pins: `todo_write` → log-only `todo/write` session event →
    // a `todo` KernelEvent → the surface's plan panel. The event was declared in
    // `protocol.ts` with no producer, which is why this asserts the LIVE event
    // and not just the logged one.
    const kernel = await createAgentKernel({
      rootDir: dir,
      provider: provider([todoToolScript, answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((event) => events.push(event));

    await kernel.agent.prompt('plan it');
    while (!events.some((event) => event.type === 'done')) await new Promise((r) => setTimeout(r, 1));

    const published = events.filter((event) => event.type === 'todo');
    expect(published).toHaveLength(1);
    const todos = published[0]?.type === 'todo' ? published[0].todos : [];
    expect(todos).toEqual([
      { content: '读代码', status: 'in_progress' },
      { content: '写补丁', status: 'pending' },
    ]);
    // Durable too: a resumed reader restores the panel from the log.
    expect(kernel.agent.session.latestTodos()).toEqual(todos);
    await kernel.dispose();
  });

  it('routes the approval gate through the broker: request event → resolve → execution', async () => {
    const log: string[] = [];
    const dir = await tmp();
    const kernel = await createAgentKernel({
      rootDir: dir,
      provider: provider([askToolScript, answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
      extraPlugins: [{ id: 'probe', plugin: probePlugin(log) }],
    });
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    await kernel.agent.prompt('ask');
    while (!events.some((e) => e.type === 'approval_request')) await new Promise((r) => setTimeout(r, 1));
    const request = (events.find((e) => e.type === 'approval_request') as {
      request: { id: string; call: { name: string }; view?: { title?: string }; preview?: string[] };
    }).request;
    expect(request.call.name).toBe('probe');
    expect(request.view?.title).toBe('probe:x');
    expect(kernel.agent.resolveApproval(request.id, 'allow')).toBe(true);
    for (let i = 0; i < 2000 && kernel.agent.running; i++) await new Promise((r) => setTimeout(r, 1));
    expect(log).toEqual(['x']);
    // audit pair lands in the session log (ask-path only)
    expect(
      kernel.agent.session.events.filter((e) => e.type === 'approval').map((e) => (e as { outcome: string }).outcome),
    ).toEqual(['allow']);
  });

  it('publishes subagent lifecycle on the session with no surface wiring', async () => {
    // The kernel owns this, like jobs: `subagent_update` had no producer at all
    // because the progress callback was left to the caller and no surface ever
    // supplied one, so the UI row built for it was unreachable. An assembly
    // with no `onSubagentProgress` must still produce the event.
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
    });
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    // The tool's own callback is what the assembly wires; calling it through the
    // published session is the same path a real delegation takes.
    kernel.agent.observeSubagent({ type: 'start', label: 'scout' });
    const published = events.find((e) => e.type === 'subagent_update');
    expect(published).toBeDefined();
    expect(published?.type === 'subagent_update' ? published.progress.label : '').toBe('scout');
  });

  it('the never policy denies headless asks without dispatching the broker', async () => {
    const log: string[] = [];
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: provider([askToolScript, answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
      extraPlugins: [{ id: 'probe', plugin: probePlugin(log) }],
    });
    kernel.permission.setPolicy('never');
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    await kernel.agent.prompt('ask');
    for (let i = 0; i < 2000 && kernel.agent.running; i++) await new Promise((r) => setTimeout(r, 1));
    expect(events.some((e) => e.type === 'approval_request')).toBe(false);
    expect(log).toEqual([]);
    const denial = events.find((e) => e.type === 'tool_call_result') as
      | { result: { content: string } }
      | undefined;
    expect(denial?.result.content).toContain('Permission denied');
  });

});

describe('createAgentKernel · model control', () => {
  /** The shipped client's shape: an id it owns, an endpoint catalog, a retarget. */
  function switchable(ids: string[], initial = ids[0] ?? ''): ChatProvider {
    let current = initial;
    return {
      get model(): string {
        return current;
      },
      setModel(next: string): void {
        current = next;
      },
      async listModels(): Promise<string[]> {
        return [...ids];
      },
      async *stream() {
        yield { type: 'text_delta', text: `[${current}]` };
      },
    };
  }

  const catalog = {
    label: 'api.test.example',
    describe: (model: string): Promise<{ name?: string } | undefined> =>
      Promise.resolve(model === 'm2' ? { name: 'Model Two' } : undefined),
  };

  it('is absent for a client that cannot be retargeted (the seat stays unrendered)', async () => {
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: provider([answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
      modelCatalog: catalog,
    });
    expect(kernel.models).toBeUndefined();
  });

  it('lists the endpoint ids with the surface metadata, and switches in place', async () => {
    const providerInstance = switchable(['m1', 'm2']);
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: providerInstance,
      config: baseConfig,
      sessionDir: await tmp(),
      modelCatalog: catalog,
    });
    const models = kernel.models;
    if (models === undefined) throw new Error('no model control');
    expect(models.current()).toBe('m1');
    expect(await models.list()).toEqual([
      {
        id: 'endpoint',
        name: 'api.test.example',
        models: [{ id: 'm1', name: 'm1' }, { id: 'm2', name: 'Model Two' }],
      },
    ]);

    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    const chosen = await models.select('m2');
    expect(chosen).toMatchObject({ id: 'm2', name: 'Model Two' });
    // In place on the ONE client: the id moved…
    expect(providerInstance.model).toBe('m2');
    expect(models.current()).toBe('m2');
    // …and the session announced it, so a second surface renders the same model.
    expect(events.find((e) => e.type === 'model')).toMatchObject({ type: 'model', model: 'm2' });
  });

  it('always offers the model in force, even when the endpoint omits it', async () => {
    // A deployment that retired the id this client was started on: the menu
    // still has to answer "what am I talking to", so the row is prepended.
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: switchable(['m8', 'm9'], 'm1'),
      config: baseConfig,
      sessionDir: await tmp(),
      modelCatalog: catalog,
    });
    const models = kernel.models;
    if (models === undefined) throw new Error('no model control');
    const groups = await models.list();
    expect(groups[0]?.models.map((m) => m.id)).toEqual(['m1', 'm8', 'm9']);
  });
});

describe('createAgentKernel · commands', () => {
  /** A third-party command: the registry is a plugin seam, not a built-in list. */
  const echoPlugin: Plugin = {
    name: 'echo-command',
    inject: ['commands'],
    apply(ctx) {
      registerCommand(ctx, {
        name: 'echo',
        description: '测试命令',
        run: (args, out) => {
          out.log(`echo ${args}`);
        },
      });
    },
  };

  async function withCommands(
    scripts: StreamEvent[][],
    extraPlugins: readonly PluginEntryOptions[] = [{ id: 'echo-command', plugin: echoPlugin }],
  ) {
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: provider(scripts),
      config: baseConfig,
      sessionDir: await tmp(),
      extraPlugins,
    });
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    return { kernel, events };
  }

  it('publishes the kernel catalog and every plugin command in one list', async () => {
    const { kernel } = await withCommands([answerScript]);
    const names = kernel.commands.map((command) => command.name);
    expect(names).toContain('compact');
    expect(names).toContain('echo');
    expect(kernel.commands.every((command) => command.description.length > 0)).toBe(true);
  });

  it('runs a command as a run/done event pair carrying what it logged', async () => {
    const { kernel, events } = await withCommands([answerScript]);
    await kernel.runCommand('echo', 'hi');
    expect(events.filter((e) => e.type === 'command')).toEqual([
      { type: 'command', name: 'echo', phase: 'run' },
      { type: 'command', name: 'echo', phase: 'done', text: 'echo hi' },
    ]);
  });

  it('answers an unknown name in its own row rather than throwing at the caller', async () => {
    const { kernel, events } = await withCommands([answerScript]);
    await kernel.runCommand('nope', '');
    expect(events.filter((e) => e.type === 'command')).toEqual([
      { type: 'command', name: 'nope', phase: 'done', text: '未知命令：/nope' },
    ]);
  });

  it('a command that throws reports the reason in the same row (the run survives)', async () => {
    const failing: Plugin = {
      name: 'failing-command',
      inject: ['commands'],
      apply(ctx) {
        registerCommand(ctx, {
          name: 'boom',
          description: '总是失败',
          run: () => {
            throw new Error('别按我');
          },
        });
      },
    };
    const { kernel, events } = await withCommands([answerScript], [{ id: 'failing-command', plugin: failing }]);
    await kernel.runCommand('boom', '');
    expect(events.filter((e) => e.type === 'command').at(-1)).toMatchObject({
      phase: 'done',
      text: expect.stringContaining('别按我'),
    });
  });

  it('/compact drives the kernel compaction, in-band with its lifecycle', async () => {
    const summaryScript: StreamEvent[] = [{ type: 'text_delta', text: '## 摘要\n压缩后的摘要' }];
    const { kernel, events } = await withCommands([answerScript, summaryScript], []);
    await kernel.agent.prompt('hello');
    for (let i = 0; i < 2000 && kernel.agent.running; i += 1) await new Promise((r) => setTimeout(r, 1));
    await kernel.runCommand('compact', '');
    const triggers = events
      .filter((e) => e.type === 'compaction')
      .map((e) => e.progress);
    expect(triggers).toContainEqual({ state: 'start', trigger: 'manual' });
    expect(triggers.at(-1)).toMatchObject({ state: 'done', trigger: 'manual' });
    // The command's own rows bracket it (the report the transcript renders).
    expect(events.filter((e) => e.type === 'command').map((e) => e.phase)).toEqual(['run', 'done']);
  });

  it('refuses /compact while a turn is in flight — core guards, the command words it', async () => {
    // A tool call held open keeps the run in flight deterministically (waiting
    // on `running` alone raced the poll window under parallel vitest).
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker: Plugin = {
      name: 'gate-command',
      inject: ['tools'],
      apply(ctx) {
        registerTool(
          ctx,
          {
            name: 'gate',
            description: 'holds the turn open',
            parameters: { type: 'object', properties: {} },
            execute: async () => {
              await gate;
              return 'released';
            },
          },
          'read',
        );
      },
    };
    const gateScript: StreamEvent[] = [
      { type: 'tool_call_delta', index: 0, id: 'call_gate', name: 'gate', argsDelta: '{}' },
      { type: 'finish', finishReason: 'tool_calls' },
    ];
    const kernel = await createAgentKernel({
      rootDir: await tmp(),
      provider: provider([gateScript, answerScript]),
      config: baseConfig,
      sessionDir: await tmp(),
      extraPlugins: [{ id: 'blocker', plugin: blocker }],
    });
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    const run = kernel.agent.prompt('hold the turn');
    for (let i = 0; i < 5000 && !events.some((e) => e.type === 'tool_call_start'); i += 1) {
      await new Promise((r) => setTimeout(r, 1));
    }
    await kernel.runCommand('compact', '');
    const done = events.find((e): e is Extract<KernelEvent, { type: 'command' }> => e.type === 'command' && e.phase === 'done');
    expect(done?.name).toBe('compact');
    expect(done?.text ?? '').toContain('本轮进行中');
    // 拒绝即终局：没有任何压缩事件发生（core 的守卫是唯一执行点）。
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    release?.();
    await run;
  });
});
