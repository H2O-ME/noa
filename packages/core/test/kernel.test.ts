/**
 * AgentSession / ApprovalBroker / EventPump — the kernel handle contract every
 * surface will drive (M11 批1). No plugins, no terminal: a scripted provider,
 * a temp-dir session log and the event stream itself are the assertions.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentSession,
  ApprovalBroker,
  EventPump,
  JobRegistry,
  NOT_EXECUTED_GUIDANCE,
  QuestionBroker,
  Session,
  persistMissingToolResults,
  type AgentHooks,
  type AgentMessage,
  type ChatProvider,
  type CompactedSession,
  type CompactSessionOptions,
  type JobOutcome,
  type KernelEvent,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
} from '../src/index.js';
import { scriptedProvider } from './helpers/scripted-provider.js';

function echoTool(registry: string[]): ToolDefinition {
  return {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    execute: (args) => {
      registry.push(String(args['text'] ?? ''));
      return `echo: ${String(args['text'] ?? '')}`;
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'other',
      title: String(args['text'] ?? ''),
    }),
  };
}

const toolCallScript: StreamEvent = {
  type: 'tool_call_delta',
  index: 0,
  id: 'call_1',
  name: 'echo',
  argsDelta: '{"text":"hi"}',
};

async function makeSession(): Promise<Session> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-kernel-'));
  return Session.create(dir, 'sess_kernel');
}

/**
 * The permission gate expressed over a broker without importing plugins:
 * 'auto' short-circuits, null routes through the broker asker (deny answers
 * the classic "Permission denied: by user" content).
 */
function brokerHooks(broker: ApprovalBroker, auto: 'allow' | 'deny' | null): AgentHooks {
  return {
    beforeToolCall: async (call: ToolCall) => {
      if (auto === 'allow') return { action: 'allow' };
      if (auto === 'deny') return { action: 'deny', reason: 'by test' };
      const answer = await broker.asker(call, 'execute');
      return answer === 'allow'
        ? { action: 'allow' }
        : answer === 'deny'
          ? { action: 'deny', reason: 'by user' }
          : { action: 'allow' };
    },
  };
}

interface Harness {
  agent: AgentSession;
  broker: ApprovalBroker;
  events: KernelEvent[];
  executed: string[];
  jobs: JobRegistry;
}

async function harness(
  scripts: StreamEvent[][],
  opts?: {
    auto?: 'allow' | 'deny' | null;
    hooks?: AgentHooks;
    provider?: ChatProvider;
    maxTurns?: number;
    autoCompactLimit?: number;
    compact?: (options: CompactSessionOptions) => Promise<CompactedSession>;
  },
): Promise<Harness> {
  const session = await makeSession();
  const messages: AgentMessage[] = [];
  const jobs = new JobRegistry();
  const broker = new ApprovalBroker(() => ({ card: 'generic', kind: 'execute', title: 'echo' }));
  // The ask seam is required by `AgentSession` (a session without one has no way
  // to fail an outstanding question closed). This harness registers no ask tool,
  // so the broker is inert here — but it must still be attached, or the
  // constructor's own wiring throws.
  const questions = new QuestionBroker();
  const executed: string[] = [];
  const provider =
    opts?.provider ?? scriptedProvider(scripts.map((events) => events));
  const agent = new AgentSession({
    session,
    messages,
    provider,
    rootDir: () => tmpdir(),
    tools: () => [echoTool(executed)],
    hooks: () => opts?.hooks ?? brokerHooks(broker, opts?.auto ?? null),
    jobs,
    approvals: broker,
    questions,
    maxTurns: opts?.maxTurns ?? 5,
    cacheDir: () => tmpdir(),
    ...(opts?.autoCompactLimit !== undefined ? { autoCompactLimit: opts.autoCompactLimit } : {}),
    ...(opts?.compact !== undefined ? { compact: opts.compact } : {}),
  });
  const events: KernelEvent[] = [];
  agent.subscribe((e) => events.push(e));
  // The assembly wires this (plugins' kernel factory); mirroring it here keeps
  // the harness faithful to the shipped path rather than to a happy subset.
  jobs.setListener((job) => agent.observeJob(job));
  return { agent, broker, events, executed, jobs };
}

async function untilIdle(agent: AgentSession): Promise<void> {
  for (let i = 0; i < 3000 && (agent.running || agent.compacting); i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(agent.running).toBe(false);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('AgentSession run lifecycle', () => {
  it('commits the prompt, streams events and logs the model surface', async () => {
    const h = await harness(
      [
        [toolCallScript, { type: 'usage', usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 0 } }],
        [{ type: 'text_delta', text: 'all done' }],
      ],
      { auto: 'allow' },
    );
    await h.agent.prompt('go');
    await untilIdle(h.agent);

    const types = h.events.map((e) => e.type);
    expect(types[0]).toBe('user_message');
    expect(types).toContain('turn_start');
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_call_result');
    expect(types).toContain('text_delta');
    expect(types).toContain('done');
    expect(h.agent.usageSnapshot().promptTokens).toBe(10);
    expect(h.agent.lastPromptTokens).toBe(10);

    const roles = h.agent.session.allMessages().map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // "model-visible means logged": the surface projects identically to the log.
    expect(h.agent.session.deriveMessages().length).toBe(h.agent.messages.length);
  });

  it('records the run measurement in the log, anchored to the message it closed', async () => {
    const h = await harness(
      [
        [toolCallScript],
        [{ type: 'text_delta', text: 'and done' }],
      ],
      { auto: 'allow' },
    );
    await h.agent.prompt('go');
    await untilIdle(h.agent);

    // The `run_stats` event is the live surface's; the log record is what
    // makes the per-turn line survive a resume (nothing can re-derive a
    // first-token latency from messages that carry no timing).
    const logged = h.agent.session.events.filter((e) => e.type === 'run/stats');
    // ONE run (one prompt) that took two requests — the measurement is the
    // run's, not the request's.
    expect(logged).toHaveLength(1);
    const last = logged[0];
    expect(last?.stats.requests).toBe(2);
    expect(last?.stats.durationMs).toBeGreaterThanOrEqual(0);
    // The anchor is the message the run ended on, and it is a real logged id —
    // the row is drawn right after it on replay.
    const anchor = last?.afterMessageId;
    expect(anchor).toBeDefined();
    expect(h.agent.session.allMessages().some((m) => m.id === anchor)).toBe(true);
    // Log-only: the model surface never sees a measurement.
    expect(h.agent.session.deriveMessages().some((m) => m.content.includes('run/stats'))).toBe(false);
    // And the stats still ride the live stream, before the terminator.
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('run_stats')).toBeLessThan(types.lastIndexOf('done'));
  });

  it('closes every request timing even when the provider reports no usage', async () => {
    // No `usage` chunk anywhere in the script: the old meter closed a request
    // only on `usage`, so this run's `llmMs` stayed 0 and its per-request series
    // came out empty while `requests` said 1. The window now closes when the
    // provider's stream settles, which is what this asserts.
    const h = await harness([[{ type: 'text_delta', text: 'no usage here' }]], { auto: 'allow' });
    await h.agent.prompt('go');
    await untilIdle(h.agent);

    const stats = h.events.filter((e) => e.type === 'run_stats').at(-1)?.stats;
    expect(stats?.requests).toBe(1);
    expect(stats?.promptTokens).toBe(0);
    expect(stats?.requestTimings).toHaveLength(1);
    expect(stats?.requestTimings?.[0]?.finishedAt).toBeDefined();
  });

  it('derives phase transitions from the loop events', async () => {
    const h = await harness(
      [
        [{ type: 'reasoning_delta', text: 'hmm' }, toolCallScript],
        [{ type: 'text_delta', text: 'ok' }],
      ],
      { auto: 'allow' },
    );
    await h.agent.prompt('go');
    await untilIdle(h.agent);
    const phases = h.events.filter((e) => e.type === 'phase').map((e) => (e as { phase: string }).phase);
    // two loop turns: turn_start re-prices the phase to 'thinking' after the tool
    expect(phases).toEqual(['thinking', 'tool', 'thinking', 'writing', 'idle']);
  });

  it('queues prompts during a run and flushes them as a second run', async () => {
    // The first run is held open by the provider: a scripted stream that
    // finishes in the same tick can complete during the `await` before the
    // second prompt, which would start a run instead of queueing behind it.
    let open = (): void => {};
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    let call = 0;
    const provider: ChatProvider = {
      async *stream() {
        call += 1;
        if (call === 1) await held;
        yield { type: 'text_delta', text: call === 1 ? 'first' : 'second' };
      },
    };
    const h = await harness([], { auto: 'allow', provider });
    await h.agent.prompt('one');
    expect(h.agent.running).toBe(true);
    await h.agent.prompt('two');
    expect(h.agent.queued).toEqual(['two']);
    const queueEvents = h.events.filter((e) => e.type === 'queue_update');
    expect(queueEvents[0]).toEqual({ type: 'queue_update', items: ['two'] });
    open();
    // The flush starts its run asynchronously, so wait for that run to exist
    // before settling — otherwise the idle check wins the race and returns.
    for (let i = 0; i < 3000 && h.events.filter((e) => e.type === 'turn_start').length < 2; i++) await sleep(1);
    await untilIdle(h.agent);
    expect(h.agent.queued).toEqual([]);
    expect(h.agent.session.allMessages().filter((m) => m.role === 'user')).toHaveLength(2);
    expect(h.events.filter((e) => e.type === 'turn_start')).toHaveLength(2);
  });

  it('interrupt mid-stream logs the abort marker and ends the run', async () => {
    const h = await harness([], {
      auto: 'allow',
      provider: {
        async *stream() {
          yield { type: 'text_delta', text: 'a' };
          await sleep(50);
          yield { type: 'text_delta', text: 'b' };
        },
      },
    });
    await h.agent.prompt('go');
    await sleep(10);
    h.agent.abort();
    await untilIdle(h.agent);
    const types = h.events.map((e) => e.type);
    expect(types).toContain('turn_aborted');
    expect(h.agent.session.allMessages().some((m) => m.role === 'user' && m.content.includes('interrupted'))).toBe(
      true,
    );
  });

  it('classifies a failing gate as run_failed and repairs the log', async () => {
    const h = await harness(
      [[toolCallScript]],
      {
        hooks: {
          beforeToolCall: async () => {
            throw new Error('gate exploded');
          },
        },
      },
    );
    await h.agent.prompt('go');
    await untilIdle(h.agent);
    const failure = h.events.find((e) => e.type === 'run_failed') as
      | { message: string; aborted: boolean }
      | undefined;
    expect(failure?.message).toBe('gate exploded');
    expect(failure?.aborted).toBe(false);
    // the committed assistant tool_call got a synthesized result in the LOG
    const logged = h.agent.session.allMessages();
    const assistant = logged.find((m) => m.role === 'assistant');
    expect(assistant?.role === 'assistant' && assistant.toolCalls?.length).toBe(1);
    const callId = assistant?.role === 'assistant' ? assistant.toolCalls?.[0]?.id : undefined;
    expect(logged.some((m) => m.role === 'tool' && m.toolCallId === callId && m.content === NOT_EXECUTED_GUIDANCE)).toBe(
      true,
    );
    // repair is idempotent (core's own abandonment cleanup already ran in memory)
    expect(await persistMissingToolResults(h.agent.session, [...h.agent.messages])).toBe(0);
  });
});

describe('approval over the event stream', () => {
  it('carries the request as an event, answers by id, and reports resolution', async () => {
    const h = await harness([[toolCallScript], [{ type: 'text_delta', text: 'after approval' }]], {
      auto: null,
    });
    await h.agent.prompt('go');
    while (!h.events.some((e) => e.type === 'approval_request')) await sleep(1);
    const request = (h.events.find((e) => e.type === 'approval_request') as {
      request: { id: string; view?: { card: string } };
    }).request;
    expect(request.view?.card).toBe('generic');
    expect(h.agent.pendingApprovals().map((p) => p.id)).toEqual([request.id]);
    expect(h.agent.currentPhase).toBe('waiting_approval');
    expect(h.agent.resolveApproval(request.id, 'allow')).toBe(true);
    expect(h.agent.resolveApproval(request.id, 'allow')).toBe(false);
    await untilIdle(h.agent);

    expect(h.events.filter((e) => e.type === 'approval_resolved')).toHaveLength(1);
    expect(h.executed).toEqual(['hi']);
    expect(h.events.some((e) => e.type === 'done')).toBe(true);
    expect(h.events.some((e) => e.type === 'tool_call_result')).toBe(true);
  });

  it('settles an ask that a listener answers synchronously inside publish', async () => {
    // The scripted surface here is the harshest case: it answers the request
    // from inside `publish`, i.e. before `asker` had returned. The broker used
    // to install a placeholder resolver first and the real one after, so this
    // answer was swallowed (and the request removed from `outstanding()`),
    // leaving the run hung on a promise nothing could ever settle.
    const h = await harness([toolCallScript, { type: 'text_delta', text: 'after approval' }].map((e) => [e]), {
      auto: null,
    });
    h.agent.subscribe((event) => {
      if (event.type === 'approval_request') h.agent.resolveApproval(event.request.id, 'allow');
    });
    await h.agent.prompt('go');
    await untilIdle(h.agent);
    expect(h.executed).toEqual(['hi']);
    expect(h.events.some((e) => e.type === 'done')).toBe(true);
  });

  it('abort fail-closes every outstanding ask as deny', async () => {
    const h = await harness([[toolCallScript], [{ type: 'text_delta', text: 'never reached' }]], {
      auto: null,
    });
    await h.agent.prompt('go');
    while (!h.events.some((e) => e.type === 'approval_request')) await sleep(1);
    h.agent.abort();
    await untilIdle(h.agent);
    const resolved = h.events.find((e) => e.type === 'approval_resolved') as
      | { resolution: { source: string } }
      | undefined;
    expect(resolved?.resolution.source).toBe('aborted');
    // The gated call produced NO executed tool: either the deny verdict or the
    // aborted-skip synthesized it a result (loop-internal race), both fine.
    expect(h.executed).toEqual([]);
    const denial = h.events.find((e) => e.type === 'tool_call_result') as
      | { result: { content: string } }
      | undefined;
    expect(denial).toBeDefined();
    expect(denial?.result.content).toMatch(/Permission denied|not executed/);
  });

  it('a closed broker denies without publishing', async () => {
    const broker = new ApprovalBroker(() => undefined);
    broker.failAll('closed');
    const answer = await broker.asker({ id: 'c', name: 'x', args: {}, rawArgs: '{}' }, 'execute');
    expect(answer).toBe('deny');
  });
});

describe('EventPump', () => {
  it('fans out to async consumers in order and ends on close', async () => {
    const pump = new EventPump();
    const a: KernelEvent[] = [];
    const b: KernelEvent[] = [];
    const drainA = (async () => {
      for await (const e of pump.events()) a.push(e);
    })();
    const drainB = (async () => {
      for await (const e of pump.events()) b.push(e);
    })();
    const note: KernelEvent = { type: 'notice', code: 'surface_lagged', text: 'x' };
    pump.publish(note);
    pump.publish(note);
    pump.close();
    await Promise.all([drainA, drainB]);
    expect(a).toEqual([note, note]);
    expect(b).toEqual([note, note]);
  });

  it('does not re-enter the error reporter from inside a reported failure', () => {
    // Killing test: the session's reporter publishes a `listener_failed` notice
    // back onto the SAME pump, so a listener that throws on every event
    // recursed throw → report → publish → throw until the stack gave out.
    let reports = 0;
    const pump: EventPump = new EventPump(() => {
      reports += 1;
      pump.publish({ type: 'notice', code: 'listener_failed', text: 'reported' });
    });
    pump.subscribe(() => {
      throw new Error('surface bug');
    });
    pump.publish({ type: 'notice', code: 'compact_failed', text: 'original' });
    expect(reports).toBe(1);
  });

  it('reports a throwing listener instead of crashing the process', async () => {
    const reported: unknown[] = [];
    const pump = new EventPump((err) => reported.push(err));
    const seen: KernelEvent[] = [];
    pump.subscribe(() => {
      throw new Error('surface bug');
    });
    const off = pump.subscribe((e) => seen.push(e));
    pump.publish({ type: 'notice', code: 'compact_failed', text: 'still delivered' });
    await sleep(10);
    off();
    // The event reached the healthy listener, the failure was reported, and
    // nothing escaped publish(). The old contract re-threw it on a microtask —
    // an uncaught exception, so one bad surface listener killed the agent.
    expect(seen).toHaveLength(1);
    expect(reported.map((e) => String(e))).toEqual(['Error: surface bug']);
  });
});

describe('prompt durability', () => {
  it('writes the log before the live surface, so a failed append is not shown', async () => {
    const h = await harness([[{ type: 'text_delta', text: 'unused' }]]);
    const append = h.agent.session.append.bind(h.agent.session);
    h.agent.session.append = async () => {
      throw new Error('disk full');
    };
    await expect(h.agent.prompt('must not appear')).rejects.toThrow('disk full');
    // The transcript must not show a message the durable log never received:
    // that divergence survives every later resume and cannot be repaired.
    expect(h.agent.messages).toHaveLength(0);
    h.agent.session.append = append;
  });

  it('drops a model message the log refused, so surface and log cannot diverge', async () => {
    // Killing test: `runAgent` pushes the assistant message and the session
    // appends it; when the append failed the message stayed on the live surface
    // while the log never got it, so the next request and a later resume
    // disagreed about history.
    const h = await harness(
      [[{ type: 'text_delta', text: 'answer' }, { type: 'finish', finishReason: 'stop' }]],
      { auto: 'allow' },
    );
    const append = h.agent.session.append.bind(h.agent.session);
    h.agent.session.append = async (msg: AgentMessage) => {
      if (msg.role === 'assistant') throw new Error('disk full');
      return append(msg);
    };
    await h.agent.prompt('go');
    await untilIdle(h.agent);

    expect(h.events.some((e) => e.type === 'run_failed')).toBe(true);
    // The user prompt committed; the assistant answer did not — in EITHER place.
    expect(h.agent.messages.some((m) => m.role === 'user')).toBe(true);
    expect(h.agent.messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(h.agent.session.allMessages().some((m) => m.role === 'assistant')).toBe(false);
  });
});

describe('session log writer', () => {
  it('refuses a write that was queued before a seal', async () => {
    // Killing test: the sealed check ran only BEFORE queueing, so a write
    // already in the chain still landed after `dispose()` sealed the log —
    // resurrecting a file the surface had deleted.
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-writer-'));
    const session = await Session.create(dir, 'sess_writer');
    await session.append({ id: 'm0', ts: 0, role: 'user', content: 'first' });

    const late = session.append({ id: 'late', ts: 0, role: 'user', content: 'late' });
    session.seal();
    await expect(late).rejects.toThrow(/sealed/);
    await session.drain();

    const reopened = await Session.open(session.file);
    expect(reopened.allMessages().map((m) => m.id)).toEqual(['m0']);
  });
});

describe('compaction and runs are mutually exclusive', () => {
  it('queues a prompt that arrives during a compaction instead of running it concurrently', async () => {
    // Killing test: a manual compaction leaves `running` false, so `prompt()`
    // used to start a run whose request was assembled against the very array
    // the compaction was about to splice.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = await harness(
      [[{ type: 'text_delta', text: 'ran' }, { type: 'finish', finishReason: 'stop' }]],
      {
        auto: 'allow',
        compact: async (options): Promise<CompactedSession> => {
          await gate;
          return { surface: [...options.messages], summary: 's', retained: options.messages.length };
        },
      },
    );
    const compacting = h.agent.compact('manual');
    await h.agent.prompt('during');
    expect(h.agent.queued).toEqual(['during']);
    release();
    await compacting;
    await untilIdle(h.agent);
    expect(h.agent.queued).toEqual([]);
  });
});

describe('automatic compaction at run boundaries', () => {
  it('compacts after an over-limit turn instead of reporting a phantom failure', async () => {
    const calls: CompactSessionOptions[] = [];
    const h = await harness(
      [
        [{ type: 'text_delta', text: 'first' }, { type: 'usage', usage: { promptTokens: 5000, completionTokens: 2, cachedTokens: 0 } }],
      ],
      {
        autoCompactLimit: 100,
        compact: async (options): Promise<CompactedSession> => {
          calls.push(options);
          return { surface: [...options.messages], summary: 'summary', retained: options.messages.length };
        },
      },
    );
    await h.agent.prompt('go');
    await untilIdle(h.agent);
    // The gate runs INSIDE the run loop, where `running` is true — going
    // through the public `compact()` guard made every boundary compaction throw
    // "cannot compact while a run is active", i.e. auto-compact was dead and
    // the operator saw a failure notice every turn.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.trigger).toBe('auto');
    const notices = h.events.filter((e) => e.type === 'notice');
    expect(notices).toEqual([]);
    expect(
      h.events
        .filter((e) => e.type === 'compaction')
        .map((e) => (e as { progress: { state: string } }).progress.state),
    ).toEqual(['start', 'done']);
  });
});

describe('compaction through the handle', () => {
  it('compacts in place, splices the surface and reports progress events', async () => {
    const session = await makeSession();
    const messages: AgentMessage[] = [
      { id: 'msg_ctx_1', ts: 1, role: 'user', content: '<environment>\ncwd=x\n</environment>' },
      { id: 'msg_u1', ts: 2, role: 'user', content: 'first task' },
      { id: 'msg_a1', ts: 3, role: 'assistant', content: 'first answer' },
    ];
    for (const m of messages) await session.append(m);
    const broker = new ApprovalBroker(() => undefined);
    const agent = new AgentSession({
      session,
      messages,
      provider: scriptedProvider([[{ type: 'text_delta', text: 'THE SUMMARY' }]]),
      rootDir: () => tmpdir(),
      tools: () => [],
      hooks: () => ({}),
      jobs: new JobRegistry(),
      approvals: broker,
      questions: new QuestionBroker(),
      cacheDir: () => tmpdir(),
    });
    const events: KernelEvent[] = [];
    agent.subscribe((e) => events.push(e));
    const outcome = await agent.compact('manual');
    expect(
      events
        .filter((e) => e.type === 'compaction')
        .map((e) => (e as { progress: { state: string } }).progress.state),
    ).toEqual(['start', 'done']);
    expect(outcome.retained).toBeGreaterThan(0);
    expect(messages.some((m) => m.content.includes('THE SUMMARY'))).toBe(true);
    // projection parity: the spliced surface is what a resume would derive
    expect(session.deriveMessages().map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it('rejects compaction while a run is active', async () => {
    const h = await harness(
      [[{ type: 'text_delta', text: 'x' }, { type: 'text_delta', text: 'y' }]],
      { auto: 'allow' },
    );
    await h.agent.prompt('go');
    await expect(h.agent.compact('manual')).rejects.toThrow('while a run is active');
    await untilIdle(h.agent);
  });
});

describe('background jobs through the handle', () => {
  const statuses = (events: readonly KernelEvent[]): string[] =>
    events.filter((e) => e.type === 'job_update').map((e) => (e.type === 'job_update' ? e.job.status : ''));

  it('stops a job from the surface, and reports the transition like every other one', async () => {
    const h = await harness([]);
    // A producer that honours the request asynchronously, like a real one: the
    // cancel() call is the request, the done promise is the teardown.
    let settle = (): void => undefined;
    let cancelled = false;
    const done = new Promise<JobOutcome>((resolve) => {
      settle = (): void => resolve({ status: 'killed' });
    });
    const started = h.jobs.start({ kind: 'bash', sessionId: '', label: 'sleep 60', cancel: () => (cancelled = true), done });
    expect(h.agent.jobSnapshots().map((j) => j.id)).toEqual([started.id]);

    await expect(h.agent.stopJob(started.id)).resolves.toBe(true);
    // The stop is a REQUEST: the producer was told, the row turns 'stopping'
    // now, and the kill arrives as a later update — a surface never has to
    // await the teardown to stay in sync.
    expect(cancelled).toBe(true);
    expect(statuses(h.events)).toEqual(['running', 'stopping']);
    expect(h.agent.jobSnapshots()[0]).toMatchObject({ status: 'stopping' });

    // An id the registry never issued is a no-op, not an error: the control is
    // optimistic, and a stale row's click must stay harmless.
    await expect(h.agent.stopJob('bash-404')).resolves.toBe(false);

    settle();
    await h.jobs.dispose();
    expect(statuses(h.events)).toEqual(['running', 'stopping', 'killed']);
  });
});
