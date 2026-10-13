/**
 * The prompt queue's contract (steering / interjection while a run is in
 * flight). Three tests, each pinning one user-visible promise:
 *
 *  1. a prompt committed while an ABORTED run is unwinding is not lost — it gets
 *     a run of its own (the old loop cleared the queue on its way out of an
 *     aborted run and never served it);
 *  2. a prompt committed mid-run is read by the model at the CURRENT run's next
 *     step, and does NOT earn a second run afterwards (the old loop only cleared
 *     the queue after the whole run, so the model answered the same text twice);
 *  3. abort + a residual queued prompt has ONE definite outcome: the trigger is
 *     withdrawn (it can never fire on a later prompt) while the TEXT survives in
 *     the append-only history, so the next run still carries it.
 *
 * Every wait is controlled by the test and the provider is scripted: nothing here
 * touches the network or a real `~/.noa` (see `packages/test-setup.ts`).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentSession,
  ApprovalBroker,
  JobRegistry,
  QuestionBroker,
  Session,
  type AgentHooks,
  type AgentMessage,
  type ChatProvider,
  type ChatRequest,
  type KernelEvent,
  type StreamEvent,
  type ToolDefinition,
} from '../src/index.js';
import { scriptedProvider } from './helpers/scripted-provider.js';

async function makeSession(): Promise<Session> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-queue-'));
  return Session.create(dir, 'sess_queue');
}

/** No plugins: an always-allow gate keeps the permission path out of the way. */
const allowAll: AgentHooks = { beforeToolCall: async () => ({ action: 'allow' }) };

/**
 * A provider whose every call records its request and can be parked, so the test
 * — not a timer — decides when a stream advances. `open()` releases call 1; later
 * calls pass straight through (they wait on an already-resolved promise).
 */
interface Controlled {
  readonly provider: ChatProvider;
  readonly requests: ChatRequest[];
  calls(): number;
  /** Resolves once the provider has been entered `n` times. */
  entered(n: number): Promise<void>;
  open(): void;
}

function controlledProvider(): Controlled {
  const requests: ChatRequest[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let calls = 0;
  let gate: Promise<void>;
  let release: () => void;
  gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    requests,
    calls: () => calls,
    entered: (n) =>
      calls >= n ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ n, resolve }); }),
    open: () => {
      const done = release;
      gate = Promise.resolve();
      release = () => undefined;
      done();
    },
    provider: {
      async *stream(request) {
        requests.push(request);
        calls += 1;
        for (const waiter of waiters.splice(0)) {
          if (calls >= waiter.n) waiter.resolve();
          else waiters.push(waiter);
        }
        await gate;
        yield { type: 'text_delta', text: `reply ${calls}` };
      },
    },
  };
}

interface Harness {
  agent: AgentSession;
  events: KernelEvent[];
  requests: ChatRequest[];
}

async function harness(opts?: {
  provider?: ChatProvider;
  scripts?: StreamEvent[][];
  capture?: ChatRequest[];
  tools?: ToolDefinition[];
}): Promise<Harness> {
  const session = await makeSession();
  const messages: AgentMessage[] = [];
  const requests = opts?.capture ?? [];
  const provider = opts?.provider ?? scriptedProvider(opts?.scripts ?? [], requests);
  const agent = new AgentSession({
    session,
    messages,
    provider,
    rootDir: () => tmpdir(),
    tools: () => opts?.tools ?? [],
    hooks: () => allowAll,
    jobs: new JobRegistry(),
    approvals: new ApprovalBroker(() => ({ card: 'generic', kind: 'execute', title: 'poke' })),
    questions: new QuestionBroker(),
    maxTurns: 5,
    cacheDir: () => tmpdir(),
  });
  const events: KernelEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return { agent, events, requests };
}

/** Wait for the run loop to settle. */
async function untilIdle(agent: AgentSession): Promise<void> {
  for (let i = 0; i < 3000 && agent.running; i++) await new Promise((r) => setTimeout(r, 1));
  expect(agent.running).toBe(false);
}

const userTexts = (request: ChatRequest): string[] =>
  request.messages.filter((m) => m.role === 'user').map((m) => m.content);

const indexOfEvent = (events: KernelEvent[], match: (event: KernelEvent) => boolean): number =>
  events.findIndex(match);

describe('prompt queue: steering while a run is in flight', () => {
  it('serves a prompt committed while an aborted run is still unwinding', async () => {
    const c = controlledProvider();
    const h = await harness({ provider: c.provider });
    await h.agent.prompt('go');
    // Park the first run inside the provider so the stop lands mid-stream.
    await c.entered(1);
    expect(h.agent.running).toBe(true);

    // Stop, then say something new while the stop is still settling. `abort()`
    // withdraws what was queued BEFORE it, so this is fresh intent rather than a
    // cancelled instruction — and it must not be dropped with the aborted run.
    h.agent.abort();
    await h.agent.prompt('follow-up');
    expect(h.agent.queued).toEqual(['follow-up']);
    c.open();
    await untilIdle(h.agent);

    // Without the fix the loop cleared the queue on its way out of the aborted
    // run: the prompt stayed in the log and the model never replied to it until
    // some unrelated later prompt happened to flush it.
    expect(c.calls()).toBe(2);
    expect(h.agent.queued).toEqual([]);
    expect(userTexts(c.requests[1]!)).toContain('follow-up');
    expect(userTexts(c.requests[1]!)).toContain('go');
  });

  it('lets the model read a mid-run prompt at the next step without running it twice', async () => {
    // Turn 1 asks for a tool; the tool is what commits the interjection, so it
    // lands between turn 1's request and turn 2's assembly.
    let steer: (() => Promise<void>) | undefined;
    const steerTool: ToolDefinition = {
      name: 'poke',
      description: 'poke',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        await steer?.();
        return 'poked';
      },
    };
    const h = await harness({
      tools: [steerTool],
      scripts: [
        [{ type: 'tool_call_delta', index: 0, id: 'call_1', name: 'poke', argsDelta: '{}' }],
        [{ type: 'text_delta', text: 'steered' }],
      ],
    });
    steer = () => h.agent.prompt('steer');
    await h.agent.prompt('go');
    await untilIdle(h.agent);

    // The SAME run's second request already carries the prompt: `assembleRequest`
    // re-reads the live message array, so steering needs no extra channel and no
    // new run. This is what "interjection" means.
    expect(h.requests).toHaveLength(2);
    expect(userTexts(h.requests[1]!)).toContain('steer');
    expect(h.events.filter((e) => e.type === 'turn_start')).toHaveLength(2);
    expect(h.events.filter((e) => e.type === 'done')).toHaveLength(1);
    // The queue lane sees the trigger appear...
    expect(h.events.some((e) => e.type === 'queue_update' && e.items.includes('steer'))).toBe(true);
    // ...and clears it at the step boundary where the model read it, NOT after
    // the run: a long run used to keep rendering a row it had already answered.
    const cleared = indexOfEvent(h.events, (e) => e.type === 'queue_update' && e.items.length === 0);
    expect(cleared).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(indexOfEvent(h.events, (e) => e.type === 'done'));
    expect(h.agent.queued).toEqual([]);
  });

  it('withdraws a residual queued prompt on abort but keeps its text in the history', async () => {
    const c = controlledProvider();
    const h = await harness({ provider: c.provider });
    await h.agent.prompt('go');
    await c.entered(1);
    // Queued while running: at abort time this is a RESIDUAL trigger.
    await h.agent.prompt('residual');
    expect(h.agent.queued).toEqual(['residual']);

    h.agent.abort();
    // The documented decision, made visible: abort WITHDRAWS the un-run trigger
    // (the queue lane empties at once) so it can never come back to life and
    // execute minutes later, out of context, on some unrelated prompt.
    expect(h.agent.queued).toEqual([]);
    c.open();
    await untilIdle(h.agent);
    expect(c.calls()).toBe(1);

    // ...but the TEXT is not lost: the log and the live array are append-only, so
    // the model still reads it on the next run — withdraw only the trigger.
    expect(h.agent.session.allMessages().some((m) => m.content === 'residual')).toBe(true);
    await h.agent.prompt('next');
    await untilIdle(h.agent);
    expect(c.calls()).toBe(2);
    expect(userTexts(c.requests[1]!)).toContain('residual');
    expect(userTexts(c.requests[1]!)).toContain('next');
  });
});
