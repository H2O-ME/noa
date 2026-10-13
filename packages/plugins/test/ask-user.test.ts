/**
 * The `ask_user_question` tool: argument normalization, the model-facing
 * failures, and — the part that actually regressed twice elsewhere in this repo —
 * that the answerer is wired at the ASSEMBLY point rather than left to each
 * surface.
 *
 * `subagent_update` shipped as a declared event with a consumer and no producer
 * (see `AGENTS.md` §5), so the assertions below go through `createAgentKernel`
 * and a real run rather than calling the tool function directly: a tool that is
 * registered but never handed an answerer looks identical from the outside until
 * somebody tries to use it.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatProvider, KernelEvent, StreamEvent, ToolDefinition } from '@noa/core';
import { askUserPlugin, parseQuestions, PluginHost, type Plugin } from '../src/index.js';
import { createAgentKernel } from '../src/index.js';
import { rowsOf } from './plugin-rows.js';

const QUESTIONS = [
  { id: 'mode', question: 'Which mode?', options: [{ label: 'Fast' }, { label: 'Thorough (Recommended)' }] },
];

/** A provider that emits one tool call, then a closing line. */
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

const askScript = (args: unknown): StreamEvent[] => [
  { type: 'tool_call_delta', index: 0, id: 'call_ask', name: 'ask_user_question', argsDelta: JSON.stringify(args) },
];
const closing: StreamEvent[] = [{ type: 'text_delta', text: 'ok' }];

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nova-ask-'));
}

async function idle(agent: { running: boolean }): Promise<void> {
  for (let i = 0; i < 3000 && agent.running; i += 1) await new Promise((r) => setTimeout(r, 1));
  expect(agent.running).toBe(false);
}

/**
 * A kernel whose `ask_user_question` call the test answers from the session's own
 * event stream — the browser's path, minus the browser.
 */
async function runningAsk(args: unknown, opts: { userQuestions?: boolean } = {}): Promise<{
  events: KernelEvent[];
  answer: (selected: string[]) => boolean;
  run: Promise<void>;
}> {
  const dir = await tmp();
  const kernel = await createAgentKernel({
    rootDir: dir,
    provider: provider([askScript(args), closing]),
    config: { approval: 'read-only' },
    sessionDir: await tmp(),
    ...(opts.userQuestions === true ? { userQuestions: true } : {}),
  });
  const events: KernelEvent[] = [];
  kernel.agent.subscribe((e) => events.push(e));
  // `prompt()` returns as soon as it has STARTED the loop (`void this.runLoop()`),
  // so awaiting it proves nothing — the run's end is the loop going idle.
  void kernel.agent.prompt('go');
  const opened = (async (): Promise<void> => {
    // Wait for the ask to be on the wire. Give up early only when it provably
    // cannot arrive: a completed tool result (fired inline, as the NO_PROVIDER
    // path does) or a run that has STARTED and already finished.
    let started = false;
    for (let i = 0; i < 3000; i += 1) {
      if (kernel.agent.pendingQuestions().length > 0) break;
      if (events.some((e) => e.type === 'turn_start')) started = true;
      if (events.some((e) => e.type === 'tool_call_result')) break;
      if (started && !kernel.agent.running) break;
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
  // The caller gets a kernel that is already parked on the ask (or provably past
  // it), so `answer` never races the request becoming outstanding.
  await opened;
  return {
    events,
    answer: (selected) => {
      const request = kernel.agent.pendingQuestions()[0];
      if (request === undefined) return false;
      return kernel.agent.resolveQuestion(request.id, {
        answers: [{ id: request.questions[0]?.id ?? '', selected }],
      });
    },
    run: (async () => {
      // The settle path: wait for the LOOP to finish, which is not the same as
      // awaiting `prompt()` — that returns as soon as the loop has started.
      for (let i = 0; i < 3000 && kernel.agent.running; i += 1) await new Promise((r) => setTimeout(r, 1));
      expect(kernel.agent.running).toBe(false);
    })(),
  };
}

/** The content of the run's first tool result (the model's view of the ask). */
function resultOf(events: KernelEvent[]): string {
  const found = events.find((e) => e.type === 'tool_call_result');
  return found !== undefined && found.type === 'tool_call_result' ? found.result.content : '';
}

describe('parseQuestions — the model\'s arguments are untrusted input', () => {
  it('normalizes the wire schema, dropping absent optionals', () => {
    expect(parseQuestions(QUESTIONS)).toEqual(QUESTIONS);
    expect(parseQuestions([{ id: 'a', question: 'why?' }])).toEqual([{ id: 'a', question: 'why?' }]);
  });

  it('maps multi_select to the kernel name and keeps explicit false off', () => {
    expect(parseQuestions([{ id: 'a', question: 'q', multi_select: true }])).toEqual([
      { id: 'a', question: 'q', multiSelect: true },
    ]);
    // `multi_select: false` is the default, not a recorded fact: keeping the key
    // would make `multiSelect !== true` checks needlessly indirect downstream.
    expect(parseQuestions([{ id: 'a', question: 'q', multi_select: false }])).toEqual([{ id: 'a', question: 'q' }]);
  });

  it('refuses an empty batch with the kernel\'s own wording', () => {
    expect(parseQuestions([])).toBe('Error: ask_user_question requires at least one question');
  });

  it('refuses duplicate ids rather than letting the answer be ambiguous', () => {
    // The answer names questions by id; two questions with one id make the
    // answer undecidable, and resolving it by position would guess.
    expect(parseQuestions([
      { id: 'a', question: 'first' },
      { id: 'a', question: 'second' },
    ])).toMatch(/duplicate question id/);
  });

  it('refuses malformed fields, each naming what is wrong', () => {
    const bad: [unknown, RegExp][] = [
      ['no', /must be a non-empty array/],
      [[{ question: 'no id' }], /needs a non-empty string id/],
      [[{ id: 'a' }], /needs a non-empty question string/],
      [[{ id: 'a', question: 'q', options: 'x' }], /options must be an array/],
      [[{ id: 'a', question: 'q', options: [{ label: '' }] }], /non-empty string label/],
      [[{ id: 'a', question: 'q', options: [{}] }], /non-empty string label/],
      [[{ id: 'a', question: 'q', multi_select: 'yes' }], /multi_select must be a boolean/],
      [[{ id: 'a', question: 'q', header: '' }], /invalid header/],
      [[{ id: 'a', question: 'q', detail: '' }], /invalid detail text/],
    ];
    for (const [value, pattern] of bad) {
      const out = parseQuestions(value);
      expect(typeof out, JSON.stringify(value)).toBe('string');
      expect(out as string).toMatch(pattern);
    }
  });

  it('refuses control characters in the text the model sends', () => {
    expect(parseQuestions([{ id: 'a', question: 'bell\u0007' }])).toMatch(/question string/);
    // Multiline detail legitimately carries newlines, so only other control
    // bytes are refused there.
    expect(parseQuestions([{ id: 'a', question: 'q', detail: 'line1\nline2' }])).toEqual([
      { id: 'a', question: 'q', detail: 'line1\nline2' },
    ]);
  });
});

describe('ask-user plugin, no answerer (the headless surfaces)', () => {
  it('registers the tool and reports NO_PROVIDER without hanging the run', async () => {
    // `nova exec` and the QQ channel call exactly this: the tool is present, and
    // the run's defined outcome is the typed refusal — never a parked ask.
    const dir = await tmp();
    const kernel = await createAgentKernel({
      rootDir: dir,
      provider: provider([askScript({ questions: QUESTIONS }), closing]),
      config: { approval: 'read-only' },
      sessionDir: await tmp(),
    });
    const events: KernelEvent[] = [];
    kernel.agent.subscribe((e) => events.push(e));
    expect(kernel.host.toolEntries.some((entry) => entry.tool.name === 'ask_user_question')).toBe(true);
    await kernel.agent.prompt('go');
    await idle(kernel.agent);
    expect(kernel.agent.pendingQuestions()).toHaveLength(0);
    expect(events.some((e) => e.type === 'question_request')).toBe(false);
    expect(resultOf(events)).toBe('Error: no user-questions answerer accepted the request');
  });
});

describe('ask-user plugin, answerer wired at the assembly point', () => {
  it('publishes question_request and delivers the answer back to the run', async () => {
    const h = await runningAsk({ questions: QUESTIONS }, { userQuestions: true });
    expect(h.events.some((e) => e.type === 'question_request')).toBe(true);
    expect(h.answer(['Fast'])).toBe(true);
    await h.run;
    // The model reads the answer as the reference's JSON shape, so the selected
    // label — not a display-stripped version of it — is what comes back.
    expect(resultOf(h.events)).toBe(JSON.stringify({ answers: [{ id: 'mode', selected: ['Fast'] }] }));
    expect(h.events.some((e) => e.type === 'question_resolved')).toBe(true);
  });

  it('reports an invalid answer back to the surface as a refusal, not a settled wait', async () => {
    const h = await runningAsk({ questions: QUESTIONS }, { userQuestions: true });
    expect(h.answer(['Never offered'])).toBe(false);
    expect(h.answer(['Thorough (Recommended)'])).toBe(true);
    await h.run;
    expect(resultOf(h.events)).toContain('Thorough (Recommended)');
  });
});

describe('askUserPlugin through the real tool host', () => {
  /** Register the plugin the way a surface does and read its tool back. */
  async function toolOf(plugin: Plugin): Promise<ToolDefinition> {
    const host = new PluginHost('.');
    await host.sync(rowsOf([plugin]));
    const tool = host.tools.find((t) => t.name === 'ask_user_question');
    if (tool === undefined) throw new Error('the plugin registered no ask_user_question tool');
    return tool;
  }
  it('reports the kernel\'s cancel text when the human dismisses the batch', async () => {
    const answerer = (): Promise<never> => Promise.reject(new Error('the user cancelled ask_user_question'));
    const tool = await toolOf(askUserPlugin({ ask: () => answerer }));
    expect(await tool.execute({ questions: QUESTIONS }, { rootDir: '.' })).toBe(
      'Error: the user cancelled ask_user_question',
    );
  });

  it('passes the abort signal through to the answerer', async () => {
    // The signal is how a headless surface (or a turn's abort) releases the ask;
    // dropping it here would leave the broker with no way to settle.
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const tool = await toolOf(askUserPlugin({
      ask: () => (_questions, signal) => {
        seen = signal;
        return Promise.reject(new Error('aborted'));
      },
    }));
    await tool.execute({ questions: QUESTIONS }, { rootDir: '.', signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  it('reads the answerer per call, so a surface that gains a human mid-run is honoured', async () => {
    // `ask` is a THUNK, not the answerer itself: an assembly-time boolean once
    // made a late-claiming surface silently never ask. Reading at call
    // time is what makes the registry's late resolution count.
    let available = false;
    const tool = await toolOf(askUserPlugin({
      ask: () => (available ? async () => ({ answers: [] }) : undefined),
    }));
    // No answerer yet: the typed refusal, not a parked run.
    expect(await tool.execute({ questions: QUESTIONS }, { rootDir: '.' })).toBe(
      'Error: no user-questions answerer accepted the request',
    );
    available = true;
    expect(await tool.execute({ questions: QUESTIONS }, { rootDir: '.' })).not.toContain('Error:');
  });

  it('is serialized by the loop: it declares itself not concurrency-safe', async () => {
    // Two questions at once would put two cards in the composer seat. The
    // broker has no queue of its own, so this declaration is the whole guard.
    const tool = await toolOf(askUserPlugin({ ask: () => async () => ({ answers: [] }) }));
    expect(tool.isConcurrencySafe?.({ questions: QUESTIONS })).toBe(false);
  });

  it('uses the read permission class: asking is not itself a side effect', async () => {
    const host = new PluginHost('.');
    await host.sync(rowsOf([askUserPlugin({ ask: () => async () => ({ answers: [] }) })]));
    expect(host.toolEntries.find((entry) => entry.tool.name === 'ask_user_question')?.permission).toBe('read');
  });

  it('renders the first question as the call row\'s title', async () => {
    const tool = await toolOf(askUserPlugin({ ask: async () => ({ answers: [] }) }));
    expect(tool.presentCall?.({ questions: QUESTIONS })).toMatchObject({ title: 'Which mode?' });
  });
});
