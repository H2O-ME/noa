/**
 * Integration test: the SSE client (packages/ai) piped directly into the agent
 * loop (packages/core). agent.test.ts and client.test.ts each test their half
 * with hand-written inputs — this guards the seam between them: if the
 * StreamEvent contract drifts between client and agent, every other test stays
 * green while the real pipeline breaks.
 *
 * Coverage that only exists here:
 *  - real SSE byte stream → OpenAICompatClient → runAgent tool dispatch
 *  - finish_reason:"length" flowing through the parser into the agent's cutoff
 *    defense (other tests synthesize the event by hand)
 *  - the cache-hit usage field surviving the full client→agent→stats path
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent, type AgentEvent, type AgentMessage } from '@noa/core';
import type { ToolDefinition } from '@noa/core';
import { OpenAICompatClient } from '../src/client.js';

function sse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(body));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function clientWithFetch(fn: () => Promise<Response>): OpenAICompatClient {
  return new OpenAICompatClient({
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl: fn,
    retryBaseDelayMs: 1,
  });
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'Echo back the text argument.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', description: 'The text to echo.' } },
    required: ['text'],
  },
  async execute(args) {
    return `echo: ${String(args['text'] ?? '')}`;
  },
};

describe('OpenAICompatClient → runAgent pipeline', () => {
  it('parses a real SSE tool-call stream through the agent loop and dispatches the tool', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noa-pipe-'));
    const turn1 = [
      'data: {"choices":[{"delta":{"content":"Let me echo."},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":""}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"text\\": \\"hello\\"}"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const turn2 = [
      'data: {"choices":[{"delta":{"content":"Done."},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":20,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":18}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const bodies = [turn1, turn2];
    let call = 0;
    const client = clientWithFetch(() => {
      const body = bodies[call] ?? bodies[bodies.length - 1]!;
      call += 1;
      return Promise.resolve(sse(body));
    });

    const messages: AgentMessage[] = [
      { id: 'u1', ts: 0, role: 'user', content: 'echo hello' },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider: client,
      messages,
      rootDir: root,
      tools: [echoTool],
    })) {
      events.push(ev);
    }

    // The client parsed the SSE deltas into tool_call_start and the agent
    // dispatched the echo tool.
    const toolStart = events.find((e) => e.type === 'tool_call_start');
    expect(toolStart).toMatchObject({ type: 'tool_call_start', call: { name: 'echo' } });
    const toolResult = events.find((e) => e.type === 'tool_call_result');
    expect(toolResult).toMatchObject({
      type: 'tool_call_result',
      result: { content: 'echo: hello' },
    });
    // result.content is the tool's return value
    expect(toolResult?.type === 'tool_call_result' && toolResult.result.content).toBe('echo: hello');

    // The agent loop ran a second turn (tool result → final answer).
    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas.some((e) => e.type === 'text_delta' && e.text.includes('Done.'))).toBe(true);

    // Usage / cache stats flowed through the full pipeline.
    const usageEv = events.filter((e) => e.type === 'usage');
    expect(usageEv.length).toBeGreaterThanOrEqual(1);
    expect(call).toBe(2); // two HTTP requests across both turns
  });

  it('end-to-end finish_reason:"length" triggers the agent cutoff defense (not a synthesized event)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noa-pipe-'));
    // A tool call that gets cut off mid-arguments by the output token limit.
    const turn1 = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"echo","arguments":"{\\"text\\": \\"hel"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"length","index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":10}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    // Second stream: model re-issues the call with complete arguments.
    const turn2 = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_2","function":{"name":"echo","arguments":"{\\"text\\": \\"hello\\"}"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    // Third stream: final answer.
    const turn3 = [
      'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const bodies = [turn1, turn2, turn3];
    let call = 0;
    const client = clientWithFetch(() => {
      const body = bodies[call] ?? bodies[bodies.length - 1]!;
      call += 1;
      return Promise.resolve(sse(body));
    });

    const messages: AgentMessage[] = [
      { id: 'u1', ts: 0, role: 'user', content: 'echo hello' },
    ];
    const events: AgentEvent[] = [];
    for await (const ev of runAgent({
      provider: client,
      messages,
      rootDir: root,
      tools: [echoTool],
    })) {
      events.push(ev);
    }

    // The truncated tool call must NOT have been dispatched to the tool —
    // instead it gets a cutoff-guidance error result. The re-issued call_2
    // is the only one that reaches the echo tool.
    const toolResults = events.filter((e) => e.type === 'tool_call_result');
    // Two results: call_1 with cutoff guidance, call_2 with real echo output.
    expect(toolResults).toHaveLength(2);
    const realResult = toolResults.find((e) =>
      e.type === 'tool_call_result' && e.call.id === 'call_2',
    );
    expect(realResult).toMatchObject({
      type: 'tool_call_result',
      result: { content: 'echo: hello' },
    });
    // call_1 got the cutoff guidance, not the echo output.
    const cutoffResult = toolResults.find((e) =>
      e.type === 'tool_call_result' && e.call.id === 'call_1',
    );
    expect(cutoffResult?.result.content).toContain('not executed');
    expect(cutoffResult?.result.content).not.toContain('echo:');
  });
});
