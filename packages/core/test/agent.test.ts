import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TURN_ABORTED_GUIDANCE,
  LENGTH_CUTOFF_TOOL_GUIDANCE,
  JobRegistry,
  getTimeTool,
  runAgent,
  type AgentEvent,
  type AgentMessage,
  type ChatProvider,
  type ChatRequest,
  type StreamEvent,
  type ToolDefinition,
  type ToolResultMessage,
  type UserMessage,
} from '../src/index.js';
import { scriptedProvider, collect } from './helpers/scripted-provider.js';

describe('runAgent', () => {
  it('streams a plain text answer and records usage', async () => {
    const provider = scriptedProvider([
      [
        { type: 'text_delta', text: 'Hel' },
        { type: 'text_delta', text: 'lo' },
        { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 8 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.' }));

    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'text_delta',
      'usage',
      'message',
      'done',
    ]);
    expect(messages).toHaveLength(1);
    const assistant = messages.find((m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant');
    expect(assistant?.content).toBe('Hello');
    expect(assistant?.usage).toEqual({ promptTokens: 10, completionTokens: 5, cachedTokens: 8 });
    const done = events.at(-1);
    expect(done?.type).toBe('done');
  });

  it('retries an EMPTY completion instead of ending the run in silence', async () => {
    // Provider pathology: everything streamed into reasoning_content, content
    // empty, finish present. Old behavior: phantom empty assistant message +
    // silent "complete" — the caller saw thinking stop and then nothing.
    const provider = scriptedProvider([
      [{ type: 'finish', finishReason: 'stop' }],
      [
        { type: 'text_delta', text: 'real answer' },
        { type: 'usage', usage: { promptTokens: 10, completionTokens: 3, cachedTokens: 0 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.' }));

    expect(events).toContainEqual({ type: 'empty_completion', attempt: 1, maxRetries: 2, finishReason: 'stop' });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'complete' });
    // no phantom empty assistant in the log — only the real answer
    const assistants = messages.filter((m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe('real answer');
  });

  it('throws after empty completions exhaust the retry budget instead of completing silently', async () => {
    const empty: StreamEvent[] = [{ type: 'finish', finishReason: 'stop' }];
    const provider = scriptedProvider([empty, empty, empty, empty]);
    const messages: AgentMessage[] = [];
    await expect(collect(runAgent({ provider, messages, rootDir: '.' }))).rejects.toThrow(/empty completion 3 times/);
    // nothing phantom was logged and the run did NOT report completion
    expect(messages).toHaveLength(0);
  });

  it('executes a tool call and feeds the result back in the next turn', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_time', argsDelta: '{"time' },
        { type: 'tool_call_delta', index: 0, argsDelta: 'zone":"UTC"}' },
        { type: 'usage', usage: { promptTokens: 20, completionTokens: 8, cachedTokens: 0 } },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'It is UTC now.' },
        { type: 'usage', usage: { promptTokens: 40, completionTokens: 6, cachedTokens: 20 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.', tools: [getTimeTool] }));

    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    const toolResult = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(toolResult?.toolCallId).toBe('call_1');
    expect(toolResult?.name).toBe('get_time');
    expect(toolResult?.content).toContain('(UTC)');

    const start = events.find((e): e is Extract<AgentEvent, { type: 'tool_call_start' }> => e.type === 'tool_call_start');
    expect(start?.call.args).toEqual({ timezone: 'UTC' });

    const lastUsage = events
      .filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')
      .at(-1);
    expect(lastUsage?.stats).toEqual({
      turns: 2,
      promptTokens: 60,
      completionTokens: 14,
      cachedTokens: 20,
      // turn-2 miss is 40-20=20 tokens, far below the 1024 noise floor
      missTokens: 0,
      missTurns: 0,
    });
  });

  it('attaches a tool-owned resultMeta to the logged tool message', async () => {
    // A genui-style tool publishes its rendered spec alongside the plain-text
    // answer the model sees. Killing test: removing the `meta` write in
    // completeToolCall makes this red (the field disappears from the log).
    const genuiTool: ToolDefinition = {
      name: 'render_ui',
      description: 'render a plugin UI',
      parameters: { type: 'object' },
      execute: async () => '已渲染界面',
      resultMeta: (args) => ({ spec: { title: 'genui', items: [], args } }),
    };
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'render_ui', argsDelta: '{"k":1}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'done' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.', tools: [genuiTool] }));
    const result = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(result?.meta).toEqual({ spec: { title: 'genui', items: [], args: { k: 1 } } });
    // The model-visible content is unchanged — meta rides alongside, not into.
    expect(result?.content).toBe('已渲染界面');
  });

  it('omits meta when the tool does not declare resultMeta', async () => {
    // Built-in tools today declare no resultMeta; their messages must not grow
    // an extra field. Killing test: adding an unconditional `meta: {}` write
    // makes this red.
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'get_time', argsDelta: '{"time' },
        { type: 'tool_call_delta', index: 0, argsDelta: 'zone":"UTC"}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.', tools: [getTimeTool] }));
    const result = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(result?.meta).toBeUndefined();
  });

  it('forwards tool progress chunks to onToolProgress', async () => {
    const streamingTool: ToolDefinition = {
      name: 'stream_out',
      description: 'emits progress chunks while running',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(_args, ctx) {
        ctx.onProgress?.('line one\n');
        ctx.onProgress?.('line two');
        return 'done';
      },
    };
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'stream_out', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const progress: string[] = [];
    const progressCallIds: string[] = [];
    await collect(
      runAgent({
        provider,
        messages,
        rootDir: '.',
        tools: [streamingTool],
        onToolProgress: (call, text) => {
          progress.push(text);
          progressCallIds.push(call.id);
        },
      }),
    );
    expect(progress).toEqual(['line one\n', 'line two']);
    // The call travels with the text, so concurrent calls cannot be conflated.
    expect(progressCallIds).toEqual(['call_1', 'call_1']);
  });

  it('attributes progress to the call that produced it under parallel dispatch', async () => {
    // Killing test: a session-level "last call" slot attributed every stream to
    // whichever call started most recently, so one tool's output was drawn on
    // another tool's row.
    const makeTool = (name: string): ToolDefinition => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      async execute(_args, ctx) {
        ctx.onProgress?.(`${name}-1`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        ctx.onProgress?.(`${name}-2`);
        return name;
      },
    });
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c_a', name: 'a', argsDelta: '{}' },
        { type: 'tool_call_delta', index: 1, id: 'c_b', name: 'b', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const seen: string[] = [];
    await collect(
      runAgent({
        provider,
        messages: [],
        rootDir: '.',
        tools: [makeTool('a'), makeTool('b')],
        onToolProgress: (call, text) => seen.push(`${call.id}:${text}`),
      }),
    );
    expect(seen.sort()).toEqual(['c_a:a-1', 'c_a:a-2', 'c_b:b-1', 'c_b:b-2']);
  });

  it('ends the turn promptly when the user aborts while a tool runs', async () => {
    const hangTool: ToolDefinition = {
      name: 'hang',
      description: 'never resolves on its own',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // A tool that ignores its cancellation signal entirely.
      execute() {
        return new Promise<string>(() => {});
      },
    };
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'hang', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 50);
    try {
      const events = await collect(
        runAgent({ provider, messages, rootDir: '.', tools: [hangTool], signal: ac.signal }),
      );
      // The run must END (the abort race settles the tool call), with a
      // synthesized tool result plus the turn-aborted guidance marker.
      expect(events.at(-1)?.type).toBe('done');
      const toolResult = messages.find((m): m is ToolResultMessage => m.role === 'tool');
      expect(toolResult?.content).toContain('aborted by user interrupt');
      expect(messages.at(-1)?.role).toBe('user');
    } finally {
      clearTimeout(timer);
    }
  });

  it('does not let empty-string id/name deltas overwrite captured values', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_time', argsDelta: '' },
        { type: 'tool_call_delta', index: 0, id: '', name: '', argsDelta: '{"timezone":"UTC"}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.', tools: [getTimeTool] }));

    const assistant = messages.find(
      (m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant' && m.toolCalls !== undefined,
    );
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: 'call_1',
      name: 'get_time',
      args: { timezone: 'UTC' },
    });
    const toolResult = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(toolResult?.name).toBe('get_time');
  });

  it('reports an error result for an unknown tool instead of throwing', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'nope', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'ack' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.' }));
    const toolResult = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(toolResult?.content).toBe('Error: unknown tool "nope"');
  });

  it('offloads oversized tool results to disk and keeps a reference', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'nova-agent-'));
    const big = 'x'.repeat(500);
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'big', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const bigTool: ToolDefinition = {
      name: 'big',
      description: 'returns a big string',
      parameters: { type: 'object' },
      execute: () => big,
    };
    const messages: AgentMessage[] = [];
    await collect(
      runAgent({
        provider,
        messages,
        rootDir: tmp,
        tools: [bigTool],
        maxToolResultBytes: 100,
        cacheDir: path.join(tmp, 'cache'),
      }),
    );
    const toolResult = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(toolResult?.truncatedRef).toBeTruthy();
    const full = await readFile(toolResult?.truncatedRef ?? '', 'utf8');
    expect(full).toBe(big);
    expect(toolResult?.content).toContain('[truncated');
    // head+tail truncation: the tail carries the most recent output
    expect(toolResult?.content.startsWith('x'.repeat(60))).toBe(true);
    expect(toolResult?.content.endsWith('x'.repeat(40))).toBe(true);
  });

  it('forwards reasoning deltas as events without persisting them', async () => {
    const provider = scriptedProvider([
      [
        { type: 'reasoning_delta', text: 'thinking ' },
        { type: 'reasoning_delta', text: 'hard' },
        { type: 'text_delta', text: 'answer' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.' }));

    const reasoning = events.filter((e): e is Extract<AgentEvent, { type: 'reasoning_delta' }> => e.type === 'reasoning_delta');
    expect(reasoning.map((e) => e.text)).toEqual(['thinking ', 'hard']);
    // no trace of reasoning in the persisted log
    expect(JSON.stringify(messages)).not.toContain('thinking');
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'answer')).toBe(true);
  });

  it('appends an interrupted-turn marker when the signal fires mid-stream', async () => {
    const controller = new AbortController();
    const provider: ChatProvider = {
      async *stream() {
        yield { type: 'text_delta', text: 'partial' };
        controller.abort();
        yield { type: 'text_delta', text: ' never consumed' };
      },
    };
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({ provider, messages, rootDir: '.', signal: controller.signal }),
    );

    expect(events.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'turn_aborted', 'done']);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' });
    // partial assistant text is discarded; the marker is the only trace
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: TURN_ABORTED_GUIDANCE });
    const abortedEvent = events.find((e): e is Extract<AgentEvent, { type: 'turn_aborted' }> => e.type === 'turn_aborted');
    expect(abortedEvent?.message).toBe(messages[0]);
  });

  it('treats a provider AbortError as a user interruption', async () => {
    const controller = new AbortController();
    const provider: ChatProvider = {
      async *stream() {
        yield { type: 'text_delta', text: 'partial' };
        controller.abort();
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
    };
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({ provider, messages, rootDir: '.', signal: controller.signal }),
    );

    expect(events.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'turn_aborted', 'done']);
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: TURN_ABORTED_GUIDANCE });
  });

  it('records queued tool calls as not executed when aborted between tools', async () => {
    const controller = new AbortController();
    const abortingTool: ToolDefinition = {
      name: 'aborting',
      description: 'aborts the signal during execution',
      parameters: { type: 'object' },
      execute: () => {
        controller.abort();
        return 'ran';
      },
    };
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'aborting', argsDelta: '{}' },
        { type: 'tool_call_delta', index: 1, id: 'c2', name: 'aborting', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(
      runAgent({ provider, messages, rootDir: '.', tools: [abortingTool], signal: controller.signal }),
    );

    // every tool call keeps its required result message
    const toolResults = messages.filter((m): m is ToolResultMessage => m.role === 'tool');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toMatchObject({ toolCallId: 'c1', content: 'ran' });
    expect(toolResults[1]).toMatchObject({
      toolCallId: 'c2',
      content: '[not executed: the user interrupted this turn]',
    });
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: TURN_ABORTED_GUIDANCE });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' });
  });
});

describe('runAgent parallel tool dispatch', () => {
  it('executes adjacent concurrency-safe calls in parallel, results in call order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tracker: ToolDefinition = {
      name: 'track',
      description: 'tracks overlap',
      parameters: { type: 'object' },
      execute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return 'ok';
      },
      isConcurrencySafe: () => true,
    };
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'track', argsDelta: '{}' },
        { type: 'tool_call_delta', index: 1, id: 'c2', name: 'track', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.', tools: [tracker] }));

    expect(maxInFlight).toBe(2);
    const results = events.filter((e) => e.type === 'tool_call_result');
    // results surface in original call order even though execution overlapped
    expect(results.map((e) => (e as { call: { id: string } }).call.id)).toEqual(['c1', 'c2']);
    // both starts precede the first result
    const firstResultIdx = events.findIndex((e) => e.type === 'tool_call_result');
    expect(events.slice(0, firstResultIdx).filter((e) => e.type === 'tool_call_start')).toHaveLength(2);
  });

  it('keeps unsafe tools strictly serial between safe ones', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const makeTool = (name: string, safe: boolean): ToolDefinition => ({
      name,
      description: name,
      parameters: { type: 'object' },
      execute: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return 'ok';
      },
      ...(safe ? { isConcurrencySafe: () => true } : {}),
    });
    const tools = [makeTool('safe1', true), makeTool('unsafe', false), makeTool('safe2', true)];
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'safe1', argsDelta: '{}' },
        { type: 'tool_call_delta', index: 1, id: 'c2', name: 'unsafe', argsDelta: '{}' },
        { type: 'tool_call_delta', index: 2, id: 'c3', name: 'safe2', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.', tools }));

    expect(maxInFlight).toBe(1);
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(3);
  });
});

describe('runAgent tool timeout', () => {
  it('abandons a call that exceeds timeoutMs and keeps the loop alive', async () => {
    const slow: ToolDefinition = {
      name: 'slow',
      description: 'ignores its signal',
      parameters: { type: 'object' },
      execute: async (_args, c) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        void c;
        return 'finished late';
      },
      timeoutMs: 30,
    };
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'slow', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'recovered' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.', tools: [slow] }));

    const result = messages.find((m): m is ToolResultMessage => m.role === 'tool');
    expect(result?.content).toContain('timed out after 30ms');
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'complete' });
  });
});

describe('length cutoff defense', () => {
  it('fails every tool call of a length-truncated message and lets the model re-issue', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_time', argsDelta: '{"time' },
        { type: 'usage', usage: { promptTokens: 20, completionTokens: 8, cachedTokens: 0 } },
        { type: 'finish', finishReason: 'length' },
      ],
      [
        { type: 'text_delta', text: 'recovered' },
        { type: 'usage', usage: { promptTokens: 40, completionTokens: 6, cachedTokens: 0 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.' }));

    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_call_result' }> => e.type === 'tool_call_result',
    );
    const starts = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_call_start' }> => e.type === 'tool_call_start',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.result.content).toContain(LENGTH_CUTOFF_TOOL_GUIDANCE);
    expect(results[0]?.result.content).toContain('get_time');
    // The START event must precede the result: surfaces build a tool row from
    // `tool_call_start`, so a bare result renders nowhere. Without this the live
    // stream and a reload disagreed — the browser drew nothing for the failure
    // while the replayed transcript drew the row.
    expect(starts).toHaveLength(1);
    expect(starts[0]?.call.id).toBe(results[0]?.call.id);
    expect(events.indexOf(starts[0]!)).toBeLessThan(events.indexOf(results[0]!));
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'complete' });
  });
});

describe('malformed arguments defense', () => {
  it('fails a call whose arguments never parsed as JSON instead of running it with {}', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_time', argsDelta: '{"timezon' },
        { type: 'tool_call_delta', index: 0, argsDelta: 'e": UTC}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'recovered' },
        { type: 'usage', usage: { promptTokens: 30, completionTokens: 5, cachedTokens: 0 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.', tools: [getTimeTool] }));

    const results = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_call_result' }> => e.type === 'tool_call_result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.result.content).toContain('not valid JSON');
    expect(results[0]?.result.content).toContain('get_time');
    // Same contract as the length-cutoff path: the refusal carries its START, so
    // the live stream draws the row instead of only a reload doing so.
    const malformedStarts = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tool_call_start' }> => e.type === 'tool_call_start',
    );
    expect(malformedStarts).toHaveLength(1);
    expect(malformedStarts[0]?.call.id).toBe(results[0]?.call.id);
    // The malformed call never executed; the error result feeds back and the
    // model recovers on the next turn.
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'complete' });
  });
});

describe('provider reset (mid-stream retry)', () => {
  it('rolls back accumulators and stats, then keeps only the replayed attempt', async () => {
    const provider = scriptedProvider([
      [
        { type: 'text_delta', text: 'par' },
        { type: 'usage', usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 50 } },
        { type: 'reset', attempt: 1, maxRetries: 3, error: 'upstream dropped' },
        { type: 'text_delta', text: 'final' },
        { type: 'usage', usage: { promptTokens: 120, completionTokens: 6, cachedTokens: 100 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.' }));

    const retry = events.find((e): e is Extract<AgentEvent, { type: 'llm_retry' }> => e.type === 'llm_retry');
    expect(retry).toMatchObject({ type: 'llm_retry', attempt: 1, maxRetries: 3, error: 'upstream dropped' });
    // the failed attempt's usage is rolled back out of the cumulative stats
    expect(retry?.stats.promptTokens).toBe(0);

    // the persisted assistant message carries ONLY the replayed attempt
    const assistant = messages.find((m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant');
    expect(assistant?.content).toBe('final');
    expect(assistant?.usage).toEqual({ promptTokens: 120, completionTokens: 6, cachedTokens: 100 });

    const lastUsage = events
      .filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')
      .at(-1);
    expect(lastUsage?.stats).toMatchObject({ promptTokens: 120, completionTokens: 6, cachedTokens: 100 });
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'complete' });
  });

  it('discards partial tool-call deltas from the failed attempt', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'c_stale', name: 'get_time', argsDelta: '{"time' },
        { type: 'reset', attempt: 1, maxRetries: 3, error: 'upstream dropped' },
        { type: 'tool_call_delta', index: 0, id: 'c_fresh', name: 'get_time', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: 'ok' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.', tools: [getTimeTool] }));

    const assistant = messages.find(
      (m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant' && m.toolCalls !== undefined,
    );
    expect(assistant?.toolCalls?.[0]).toMatchObject({ id: 'c_fresh', args: {} });
    const toolResult = messages.find((m): m is Extract<AgentMessage, { role: 'tool' }> => m.role === 'tool');
    expect(toolResult?.toolCallId).toBe('c_fresh');
  });
});

describe('cache miss audit', () => {
  it('counts misses only after the provider reported cache activity and above the noise floor', async () => {
    const provider = scriptedProvider([
      [
        { type: 'tool_call_delta', index: 0, id: 'call_1', name: 'get_time', argsDelta: '{}' },
        { type: 'usage', usage: { promptTokens: 5000, completionTokens: 8, cachedTokens: 0 } },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [
        { type: 'tool_call_delta', index: 0, id: 'call_2', name: 'get_time', argsDelta: '{}' },
        { type: 'usage', usage: { promptTokens: 6000, completionTokens: 8, cachedTokens: 4000 } },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'usage', usage: { promptTokens: 7000, completionTokens: 4, cachedTokens: 6500 } },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.', tools: [getTimeTool] }));

    const lastUsage = events
      .filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')
      .at(-1);
    // turn 1: provider reported no cache yet → miss not counted (sticky gate);
    // turn 2: miss 2000 > noise floor 1024 → counted;
    // turn 3: miss 500 below floor → not counted
    expect(lastUsage?.stats.missTokens).toBe(2000);
    expect(lastUsage?.stats.missTurns).toBe(1);
  });
});

describe('background-job completion notices', () => {
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
  };

  async function completedRegistry(): Promise<JobRegistry> {
    const registry = new JobRegistry();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'sleep 10',
      cancel: () => {},
      done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
    });
    await flush();
    return registry;
  }

  it('returns the notice to the queue when the request dies before the model answers', async () => {
    const registry = await completedRegistry();
    const provider: ChatProvider = {
      // Deliberately yield-less: the request dies BEFORE its first event. The
      // generator form is what makes runAgent's catch see the throw (a plain
      // function's sync throw would escape before the stream is even created).
      // oxlint-disable-next-line require-yield
      async *stream() {
        throw new Error('context window exceeded');
      },
    };
    await expect(
      collect(runAgent({ provider, messages: [], rootDir: '.', jobs: registry })),
    ).rejects.toThrow('context window exceeded');
    // At-least-once: the drained batch is back, so the next run re-announces.
    expect(registry.drainFinished().map((n) => n.id)).toEqual(['bash-1']);
  });

  it('returns the notice when the stream dies mid-response (the reply never commits)', async () => {
    const registry = await completedRegistry();
    const provider: ChatProvider = {
      async *stream() {
        yield { type: 'text_delta', text: 'partial' };
        throw new Error('upstream exploded');
      },
    };
    const messages: AgentMessage[] = [];
    await expect(
      collect(runAgent({ provider, messages, rootDir: '.', jobs: registry })),
    ).rejects.toThrow('upstream exploded');
    expect(messages).toHaveLength(0); // no committed assistant turn
    expect(registry.drainFinished().map((n) => n.id)).toEqual(['bash-1']);
  });

  function capturingProvider(seen: AgentMessage[][]): ChatProvider {
    return {
      async *stream(req: ChatRequest) {
        seen.push(req.messages);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', usage: { promptTokens: 3, completionTokens: 1, cachedTokens: 0 } };
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
  }

  it('injects the finished-job notice into the request but never into the log', async () => {
    const registry = new JobRegistry();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'sleep 10',
      cancel: () => {},
      done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
    });
    await flush(); // let the registry settle the job before the run starts

    const seen: AgentMessage[][] = [];
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider: capturingProvider(seen), messages, rootDir: '.', jobs: registry }));

    expect(seen).toHaveLength(1);
    const tail = seen[0]!.at(-1);
    expect(tail?.role).toBe('user');
    expect((tail as UserMessage).content).toContain('bash-1 [completed] sleep 10 (exit code: 0)');
    // append-only log stays clean: no injected user message survived the run.
    expect(messages).toHaveLength(1);
    expect(messages.some((m) => m.role === 'user')).toBe(false);
    // the notice was consumed once and is not re-announced.
    expect(registry.drainFinished()).toEqual([]);
  });

  it('announces once across separate runs: the next run sees nothing stale', async () => {
    const registry = new JobRegistry();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'curl site',
      cancel: () => {},
      done: Promise.resolve({ status: 'failed', detail: 'exit code: 3' }),
    });
    await flush();

    const seen: AgentMessage[][] = [];
    const first = await collect(runAgent({ provider: capturingProvider(seen), messages: [], rootDir: '.', jobs: registry }));
    const second = await collect(runAgent({ provider: capturingProvider(seen), messages: [], rootDir: '.', jobs: registry }));
    expect(first.some((e) => e.type === 'done')).toBe(true);
    expect(second.some((e) => e.type === 'done')).toBe(true);
    expect(seen).toHaveLength(2);
    expect((seen[0]!.at(-1) as UserMessage).content).toContain('bash-1 [failed]');
    expect(seen[1]!.some((m) => m.role === 'user')).toBe(false); // drained on the first run
  });

  it('runs beforeLLMCall hooks BEFORE appending the notice, so in-place hooks still shrink the log', async () => {
    const registry = new JobRegistry();
    registry.start({
      kind: 'bash', sessionId: '',
      label: 'sleep 10',
      cancel: () => {},
      done: Promise.resolve({ status: 'completed', detail: 'exit code: 0' }),
    });
    await flush();

    // Simulate exec's wrapAutoCompact: the hook splices request.messages in
    // place to shrink the live surface. The hook must see the ALIASED array
    // (notice not yet appended), so its splice lands in the outer `messages`
    // log — otherwise compaction would run every turn and never shrink.
    const dropped: AgentMessage[] = [];
    const seen: AgentMessage[][] = [];
    const messages: AgentMessage[] = [
      { id: 'seed', ts: 0, role: 'user', content: 'seed' },
      { id: 'a1', ts: 0, role: 'assistant', content: 'old' },
    ];
    let receivedAfterHook: AgentMessage[] | undefined;
    const provider: ChatProvider = {
      async *stream(req: ChatRequest) {
        receivedAfterHook = req.messages;
        seen.push(req.messages);
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'finish', finishReason: 'stop' };
      },
    };
    await collect(
      runAgent({
        provider,
        messages,
        rootDir: '.',
        jobs: registry,
        hooks: {
          beforeLLMCall: async (req) => {
            // Here the request must still alias the append-only log: the
            // notice has not been synthesized yet, so this splice lands in
            // the outer array (exec's compact contract).
            expect(req.messages).toBe(messages);
            dropped.push(...req.messages.splice(0, req.messages.length - 1));
            return req;
          },
        },
      }),
    );

// The outer log was shrunk by the hook's in-place splice (the run then
    // appended its assistant reply, which the run owns).
    expect(dropped.map((m) => m.id)).toEqual(['seed']);
    expect(messages.map((m) => m.id)).toEqual(['a1', expect.any(String)]);
    expect(messages.at(-1)?.role).toBe('assistant');
    // ...and the notice was appended AFTER the hook, on top of the shrunk
    // surface, still without touching the log.
    expect(seen).toHaveLength(1);
    expect(receivedAfterHook?.at(-1)).toMatchObject({ role: 'user' });
    expect((receivedAfterHook!.at(-1) as UserMessage).content).toContain('bash-1 [completed]');
    expect(messages.some((m) => m.role === 'user')).toBe(false);
  });
});

describe('stale-todo nag', () => {
  const toolTurn = (id: string, name: string): StreamEvent[] => [
    { type: 'tool_call_delta', index: 0, id, name, argsDelta: '{}' },
    { type: 'finish', finishReason: 'tool_calls' },
  ];
  const stopTurn = (text: string): StreamEvent[] => [
    { type: 'text_delta', text },
    { type: 'finish', finishReason: 'stop' },
  ];
  const noopTool = (name: string): ToolDefinition => ({
    name,
    description: `test tool ${name}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return 'ok';
    },
  });
  const planTool: ToolDefinition = {
    name: 'plan_write',
    description: 'persists the plan snapshot (test stand-in, not the real todo_write)',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, ctx) {
      await ctx.emit?.({ type: 'todo/write', todos: [], at: Date.now() });
      return 'saved';
    },
  };

  it('injects one ephemeral nudge after three tool turns without a plan snapshot', async () => {
    const seen: ChatRequest[] = [];
    const provider: ChatProvider = {
      async *stream(req: ChatRequest) {
        seen.push(req);
        // Fourth request carries the nag → answer; earlier ones do tool turns.
        if (seen.length <= 3) {
          yield* (async function* () {
            yield { type: 'tool_call_delta', index: 0, id: `c${seen.length}`, name: 'work', argsDelta: '{}' };
            yield { type: 'finish', finishReason: 'tool_calls' };
          })();
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'finish', finishReason: 'stop' };
        }
      },
    };
    const messages: AgentMessage[] = [];
    const emitted: unknown[] = [];
    await collect(
      runAgent({
        provider,
        messages,
        rootDir: '.',
        tools: [noopTool('work')],
        emit: async (evt) => {
          emitted.push(evt);
        },
      }),
    );
    // Three tool turns armed the nag; the fourth request carried it as an
    // ephemeral tail — visible to the model, never in the log.
    expect(seen).toHaveLength(4);
    const nagged = seen[3]!;
    expect(nagged.messages.at(-1)).toMatchObject({ role: 'user' });
    expect((nagged.messages.at(-1) as UserMessage).content).toContain('todo');
    expect(seen.slice(0, 3).every((req) => req.messages.every((m) => m.content !== (nagged.messages.at(-1) as UserMessage).content))).toBe(true);
    expect(messages.some((m) => m.role === 'user' && m.content.includes('todo list'))).toBe(false);
    expect(emitted).toEqual([]);
  });

  it('resets the counter when any tool persists a todo/write snapshot', async () => {
    const seen: ChatRequest[] = [];
    const provider: ChatProvider = {
      async *stream(req: ChatRequest) {
        seen.push(req);
        const n = seen.length;
        if (n === 1) {
          yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'plan_write', argsDelta: '{}' };
          yield { type: 'finish', finishReason: 'tool_calls' };
        } else if (n <= 3) {
          yield { type: 'tool_call_delta', index: 0, id: `c${n}`, name: 'work', argsDelta: '{}' };
          yield { type: 'finish', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'finish', finishReason: 'stop' };
        }
      },
    };
    const messages: AgentMessage[] = [];
    await collect(
      runAgent({
        provider,
        messages,
        rootDir: '.',
        tools: [planTool, noopTool('work')],
        emit: async () => {},
      }),
    );
    // plan snapshot on turn 1 reset the counter: only two stale turns
    // followed, so no request ever carried the nag.
    expect(seen).toHaveLength(4);
    for (const req of seen) {
      expect(req.messages.some((m) => m.role === 'user' && m.content.includes('todo list'))).toBe(false);
    }
  });

  it('counts one assistant turn once no matter how many calls the batch held', async () => {
    const seen: ChatRequest[] = [];
    const provider: ChatProvider = {
      async *stream(req: ChatRequest) {
        seen.push(req);
        if (seen.length === 1) {
          // One turn, two parallel-safe calls — still a single count.
          yield { type: 'tool_call_delta', index: 0, id: 'c1a', name: 'work', argsDelta: '{}' };
          yield { type: 'tool_call_delta', index: 1, id: 'c1b', name: 'work', argsDelta: '{}' };
          yield { type: 'finish', finishReason: 'tool_calls' };
        } else if (seen.length <= 3) {
          yield { type: 'tool_call_delta', index: 0, id: `c${seen.length}`, name: 'work', argsDelta: '{}' };
          yield { type: 'finish', finishReason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'finish', finishReason: 'stop' };
        }
      },
    };
    const messages: AgentMessage[] = [];
    await collect(
      runAgent({ provider, messages, rootDir: '.', tools: [noopTool('work')], emit: async () => {} }),
    );
    // Turns with tools: 1 (two calls) + 2 more = 3 stale → nag on request 4.
    expect(seen).toHaveLength(4);
    expect((seen[3]!.messages.at(-1) as UserMessage).content).toContain('todo');
  });

  it('never counts pure-qa turns and never logs the nudge', async () => {
    const seen: ChatRequest[] = [];
    const provider = scriptedProvider([
      stopTurn('answer one'),
      toolTurn('c1', 'work'),
      stopTurn('answer two'),
      toolTurn('c2', 'work'),
      stopTurn('final'),
    ]);
    const wrapped: ChatProvider = {
      async *stream(req: ChatRequest) {
        seen.push(req);
        yield* provider.stream(req);
      },
    };
    const messages: AgentMessage[] = [];
    await collect(
      runAgent({ provider: wrapped, messages, rootDir: '.', tools: [noopTool('work')], emit: async () => {} }),
    );
    // Only two tool turns ever ran — below the threshold — so no request
    // carried the nag, and the log holds no trace of it.
    for (const req of seen) {
      expect(req.messages.some((m) => m.role === 'user' && m.content.includes('todo list'))).toBe(false);
    }
    expect(messages.some((m) => m.role === 'user')).toBe(false);
  });

  it('counts a length-cut tool turn as stale (nothing could execute)', async () => {
    const seen: ChatRequest[] = [];
    const provider = scriptedProvider([
      toolTurn('c1', 'work'),
      toolTurn('c2', 'work'),
      // The provider cut this batch off mid-stream: `length` fails every call
      // without executing anything, so this turn must count as stale too.
      [
        { type: 'tool_call_delta', index: 0, id: 'c3', name: 'work', argsDelta: '{"x":' },
        { type: 'finish', finishReason: 'length' },
      ],
      stopTurn('final'),
    ]);
    const wrapped: ChatProvider = {
      async *stream(req: ChatRequest) {
        seen.push(req);
        yield* provider.stream(req);
      },
    };
    const messages: AgentMessage[] = [];
    await collect(
      runAgent({ provider: wrapped, messages, rootDir: '.', tools: [noopTool('work')], emit: async () => {} }),
    );
    // Two normal tool turns + one length-cut turn = 3 stale → nag on request 4.
    expect(seen).toHaveLength(4);
    expect((seen[3]!.messages.at(-1) as UserMessage).content).toContain('todo');
  });

  it('keeps request-level trims out of the log (wire shrinks, history intact)', async () => {
    const seen: ChatRequest[] = [];
    // Four tool turns → 4 tool groups + closing answer. Micro keeps the
    // newest 3 tool groups verbatim, so the wire must show exactly the
    // oldest result as a placeholder while the log keeps every body.
    const provider = scriptedProvider([
      toolTurn('c1', 'work'),
      toolTurn('c2', 'work'),
      toolTurn('c3', 'work'),
      toolTurn('c4', 'work'),
      stopTurn('final'),
    ]);
    const wrapped: ChatProvider = {
      async *stream(req: ChatRequest) {
        seen.push(req);
        yield* provider.stream(req);
      },
    };
    const messages: AgentMessage[] = [];
    await collect(
      runAgent({
        provider: wrapped,
        messages,
        rootDir: '.',
        tools: [noopTool('work')],
        emit: async () => {},
      }),
    );
    expect(seen).toHaveLength(5);
    const lastWire = seen[4]!.messages;
    const wireResults = lastWire.filter((m) => m.role === 'tool');
    expect(wireResults).toHaveLength(4);
    expect(wireResults[0]?.content).toContain('compacted');
    expect(wireResults.slice(1).every((r) => r.content === 'ok')).toBe(true);
    // The canonical log kept every original body — trims never splice it.
    const logged = messages.filter((m): m is ToolResultMessage => m.role === 'tool');
    expect(logged).toHaveLength(4);
    expect(logged.every((r) => r.content === 'ok')).toBe(true);
  });

  it('steers into another turn when a beforeTurnEnd hook returns steer', async () => {
    // Killing test: removing the `beforeTurnEnd` branch in the loop makes this
    // red — the run ends after turn 1 with stop_reason 'complete' and never
    // sees the steered message.
    const provider = scriptedProvider([
      [{ type: 'text_delta', text: 'done' }, { type: 'finish', finishReason: 'stop' }],
      [{ type: 'text_delta', text: ' after steer' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    let fired = 0;
    const events = await collect(
      runAgent({
        provider,
        messages,
        rootDir: '.',
        hooks: {
          beforeTurnEnd: async () => {
            fired += 1;
            // Steer on the FIRST natural end only — second end returns stop so
            // the run terminates and does not loop until maxTurns.
            if (fired === 1) {
              return { action: 'steer' as const, message: { role: 'user' as const, id: 'steer-1', ts: Date.now(), content: '继续' } };
            }
            return { action: 'stop' as const };
          },
        },
      }),
    );
    expect(fired).toBe(2);
    // The steer message landed in the log and the run took another turn.
    expect(messages.some((m) => m.role === 'user' && m.content === '继续')).toBe(true);
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done');
    expect(done?.stopReason).toBe('complete');
  });

  it('does not steer past maxTurns even if the hook keeps returning steer', async () => {
    // Killing test: removing the `turn < maxTurns` guard makes the loop trust
    // the hook forever (or until the model emits a tool call). The guard caps
    // runaway steering at the operator-set quota.
    const provider = scriptedProvider([
      [{ type: 'text_delta', text: 'a' }, { type: 'finish', finishReason: 'stop' }],
      [{ type: 'text_delta', text: 'b' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    let fired = 0;
    await collect(
      runAgent({
        provider,
        messages,
        rootDir: '.',
        maxTurns: 1,
        hooks: {
          beforeTurnEnd: async () => {
            fired += 1;
            return { action: 'steer' as const, message: { role: 'user' as const, id: 'steer', ts: Date.now(), content: 'x' } };
          },
        },
      }),
    );
    // Hook fires once (at the natural end of turn 1); the quota guard refuses
    // the steer and the run ends — no second turn, no infinite loop.
    expect(fired).toBe(1);
    expect(messages.some((m) => m.role === 'user' && m.content === 'x')).toBe(false);
  });
});
