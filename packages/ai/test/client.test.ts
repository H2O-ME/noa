import type { StreamEvent } from '@noa/core';
import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatClient } from '../src/client.js';
import { RATE_LIMIT_WINDOW_MS, RETRY_BACKOFF_MAX_MS, parseRetryAfterMs } from '../src/retry.js';

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"Hi"},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_time","arguments":""}}]},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"index":0}]}',
  '',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":8}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

function sseResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** A 200 SSE response whose body dies mid-stream (gateway drop). */
function failingSseResponse(partialBody: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(partialBody));
      // error() discards queued chunks, so the partial delivery only happens
      // if the reader drains it before the failure fires.
      setTimeout(() => controller.error(new Error('terminated')), 5);
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function clientWith(fetchImpl: typeof fetch): OpenAICompatClient {
  return new OpenAICompatClient({
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    fetchImpl,
    retryBaseDelayMs: 1,
    // No full-window waits here: these tests are about the ATTEMPT budget, and a
    // bare 429 (no `retry-after`) would otherwise park each one for a minute of
    // real time. The window itself is pinned by its own test below.
    maxRateLimitWaits: 0,
  });
}

async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** The primary at `https://example.test/v1` plus one fallback, recording calls. */
function failoverClient(
  fetchImpl: typeof fetch,
  fallback: { baseURL: string; apiKey: string; model?: string } = {
    baseURL: 'https://backup.test/v1',
    apiKey: 'sk-backup',
  },
): OpenAICompatClient {
  return new OpenAICompatClient({
    baseURL: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    fallbacks: [fallback],
    fetchImpl,
    retryBaseDelayMs: 1,
    /** See `clientWith`: budget tests must not pay the quota window. */
    maxRateLimitWaits: 0,
  });
}

/** A recording fetchImpl: answers by URL, counting every call. */
function byUrl(handlers: Record<string, () => Response | Promise<Response>>): {
  impl: typeof fetch;
  calls: string[];
  bodies: Record<string, unknown>[];
  keys: string[];
} {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const keys: string[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push(url);
    const handler = handlers[url];
    if (handler === undefined) return Promise.resolve(new Response('no handler', { status: 500 }));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    keys.push(headers['authorization'] ?? '');
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return Promise.resolve(handler());
  };
  return { impl, calls, bodies, keys };
}

describe('OpenAICompatClient', () => {
  it('translates SSE chunks into stream events including usage', async () => {
    const client = clientWith(() => Promise.resolve(sseResponse(SSE_BODY)));
    const events = await drain(client.stream({ messages: [] }));

    expect(events.some((e) => e.type === 'text_delta' && e.text === 'Hi')).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === 'tool_call_delta' && e.id === 'call_1' && e.name === 'get_time',
      ),
    ).toBe(true);
    const usage = events.find((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 8,
    });
    const finish = events.find((e): e is Extract<StreamEvent, { type: 'finish' }> => e.type === 'finish');
    expect(finish?.finishReason).toBe('tool_calls');
  });

  it('keeps the first tool-call id/name when later chunks repeat them as empty strings', async () => {
    const gatewayBody = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_time","arguments":""}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":"{\\"timezone\\": "}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"","type":"","function":{"name":"","arguments":"\\"UTC\\"}"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":5,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const client = clientWith(() => Promise.resolve(sseResponse(gatewayBody)));
    const events = await drain(client.stream({ messages: [] }));

    const nameDeltas = events
      .filter((e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> => e.type === 'tool_call_delta')
      .filter((e) => e.name !== undefined);
    expect(nameDeltas).toHaveLength(1);
    expect(nameDeltas[0]?.name).toBe('get_time');
    expect(nameDeltas[0]?.id).toBe('call_abc');
  });

  it('coerces missing/non-integer tool-call indexes to 0 so the accumulator keys stay stable', async () => {
    const gatewayBody = [
      // No index at all: coerced to 0, id still picked up.
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_x","function":{"name":"a","arguments":"{}"}}]},"index":0}]}',
      '',
      // String-typed index from a non-conformant gateway: coerced to 0.
      'data: {"choices":[{"delta":{"tool_calls":[{"index":"1","id":"","function":{"arguments":"{}"}}]},"index":0}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const client = clientWith(() => Promise.resolve(sseResponse(gatewayBody)));
    const events = await drain(client.stream({ messages: [] }));

    const deltas = events.filter(
      (e): e is Extract<StreamEvent, { type: 'tool_call_delta' }> => e.type === 'tool_call_delta',
    );
    expect(deltas.length).toBeGreaterThan(0);
    for (const d of deltas) expect(d.index).toBe(0);
  });

  it('translates reasoning_content deltas and passes max_tokens through', async () => {
    const reasoningBody = [
      'data: {"choices":[{"delta":{"reasoning_content":"step 1"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(sseResponse(reasoningBody));
    };
    const client = clientWith(fetchImpl);
    const events = await drain(client.stream({ messages: [] }));

    expect(
      events.some((e) => e.type === 'reasoning_delta' && e.text === 'step 1'),
    ).toBe(true);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'answer')).toBe(true);

    const clientWithLimit = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl: (_input, init) => {
        capturedInit = init;
        return Promise.resolve(sseResponse('data: [DONE]\n\n'));
      },
      retryBaseDelayMs: 1,
      temperature: 0.3,
      maxTokens: 4096,
    });
    await drain(clientWithLimit.stream({ messages: [] }));
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body['max_tokens']).toBe(4096);
    expect(body['temperature']).toBe(0.3);
  });

  it('retries a 429 and then succeeds', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response(null, { status: 429 }));
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = clientWith(fetchImpl);
    const events = await drain(client.stream({ messages: [] }));
    expect(calls).toBe(2);
    expect(events).toEqual([]);
  });

  it('waits out a whole quota window for a 429 that outlived the cheap backoff', async () => {
    // Observed live: the gateway answered `429 {"message":"rpm exhausted"}` with no
    // `retry-after`, the client spent its whole attempt budget in about seven
    // seconds of exponential backoff, and the turn died telling the operator to
    // try again later. A per-minute quota cannot be cleared by seven seconds of
    // patience, so the second failure in a streak sits out a full window.
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl: typeof fetch = () => {
        calls += 1;
        if (calls <= 2) return Promise.resolve(new Response(null, { status: 429 }));
        return Promise.resolve(sseResponse('data: [DONE]\n\n'));
      };
      const client = new OpenAICompatClient({
        baseURL: 'https://example.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        fetchImpl,
        retryBaseDelayMs: 1,
        maxRateLimitWaits: 1,
      });
      const done = drain(client.stream({ messages: [] }));

      // Attempt 0 → the cheap backoff, not the window.
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toBe(2);
      // Attempt 1 → now the full window, and nothing goes out during it.
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS - 1_000);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up rather than waiting more windows than configured', async () => {
    vi.useFakeTimers();
    try {
      const calls: number[] = [];
      const fetchImpl: typeof fetch = () => {
        calls.push(1);
        return Promise.resolve(new Response(null, { status: 429 }));
      };
      const client = new OpenAICompatClient({
        baseURL: 'https://example.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        fetchImpl,
        retryBaseDelayMs: 1,
        maxRateLimitWaits: 1,
        maxRetries: 5,
      });
      const done = drain(client.stream({ messages: [] })).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_WINDOW_MS * 5);
      const err = await done;
      expect(err).toBeInstanceOf(Error);
      // The guess is bounded: 6 attempts would have been the budget, but only the
      // first one gets the cheap backoff and only one gets the window, so the
      // whole thing stops after the third failure instead of waiting forever.
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws HttpError on a terminal 400', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('{"error":{"message":"bad request"}}', { status: 400 }));
    const client = clientWith(fetchImpl);
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow('HTTP 400');
  });

  it('retries a mid-stream failure after emitting reset, then succeeds', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(failingSseResponse('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
      }
      return Promise.resolve(
        sseResponse('data: {"choices":[{"delta":{"content":"fresh"}}]}\n\ndata: [DONE]\n\n'),
      );
    };
    const client = clientWith(fetchImpl);
    const events = await drain(client.stream({ messages: [] }));

    expect(calls).toBe(2);
    // the partial attempt reached the consumer, so the retry announced itself
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'par')).toBe(true);
    const reset = events.find((e): e is Extract<StreamEvent, { type: 'reset' }> => e.type === 'reset');
    expect(reset).toMatchObject({ type: 'reset', attempt: 1, maxRetries: 3, error: 'terminated' });
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'fresh')).toBe(true);
  });

  it('retries a stream that ends cleanly without a finish reason', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) {
        // no finish_reason and no [DONE]: the reply was silently truncated
        return Promise.resolve(sseResponse('data: {"choices":[{"delta":{"content":"cut"}}]}\n\n'));
      }
      return Promise.resolve(
        sseResponse(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      );
    };
    const client = clientWith(fetchImpl);
    const events = await drain(client.stream({ messages: [] }));

    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'reset')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'ok')).toBe(true);
  });

  it('throws after the retry budget is exhausted on repeated mid-stream failures', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(failingSseResponse('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'));
    };
    const client = clientWith(fetchImpl);
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow('terminated');
    expect(calls).toBe(4); // initial attempt + maxRetries(3)
  });

  it('does not emit reset when the failure precedes the first event', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('socket hang up'));
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = clientWith(fetchImpl);
    const events = await drain(client.stream({ messages: [] }));
    expect(calls).toBe(2);
    expect(events.every((e) => e.type !== 'reset')).toBe(true);
  });

  it('maps internal messages and tools to the wire format', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = clientWith(fetchImpl);
    await drain(
      client.stream({
        systemPrompt: 'be brief',
        messages: [
          { id: 'm1', ts: 0, role: 'user', content: 'q' },
          {
            id: 'm2',
            ts: 0,
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 't', args: {}, rawArgs: '' }],
          },
          { id: 'm3', ts: 0, role: 'tool', toolCallId: 'c1', name: 't', content: 'r' },
        ],
        tools: [{ name: 't', description: 'd', parameters: { type: 'object' }, execute: () => '' }],
      }),
    );

    expect(capturedUrl).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      stream: boolean;
      messages: Array<Record<string, unknown>>;
      tools: Array<Record<string, unknown>>;
    };
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'q' });
    expect(body.messages[2]?.['tool_calls']).toEqual([
      { id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } },
    ]);
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'r' });
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 't', description: 'd', parameters: { type: 'object' } },
    });
  });

  it('sends tools sorted by name without mutating the caller array', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = clientWith(fetchImpl);
    const tools = [
      { name: 'write_file', description: 'w', parameters: { type: 'object' }, execute: () => '' },
      { name: 'bash', description: 'b', parameters: { type: 'object' }, execute: () => '' },
      { name: 'edit_file', description: 'e', parameters: { type: 'object' }, execute: () => '' },
    ];
    const before = tools.map((t) => t.name);
    await drain(client.stream({ messages: [], tools }));

    // Wire order is lexicographic regardless of registration order.
    const body = JSON.parse(String(capturedInit?.body)) as {
      tools: Array<{ function: { name: string } }>;
    };
    expect(body.tools.map((t) => t.function.name)).toEqual(['bash', 'edit_file', 'write_file']);
    // The caller's array is untouched.
    expect(tools.map((t) => t.name)).toEqual(before);
    expect(tools.map((t) => t.name)).toEqual(['write_file', 'bash', 'edit_file']);
  });

  it('caches the wire-format tool array by input identity across turns', async () => {
    const seenBodies: RequestInit[] = [];
    const fetchImpl: typeof fetch = (_input, init) => {
      seenBodies.push(init!);
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = clientWith(fetchImpl);
    const tools = [
      { name: 'bash', description: 'b', parameters: { type: 'object' }, execute: () => '' },
      { name: 'edit_file', description: 'e', parameters: { type: 'object' }, execute: () => '' },
    ];
    // Two turns with the SAME tools reference — the cache must hit on turn 2.
    await drain(client.stream({ messages: [], tools }));
    await drain(client.stream({ messages: [], tools }));
    expect(seenBodies).toHaveLength(2);
    const body1 = JSON.parse(String(seenBodies[0]!.body)) as { tools: unknown[] };
    const body2 = JSON.parse(String(seenBodies[1]!.body)) as { tools: unknown[] };
    expect(body1.tools).toEqual(body2.tools);
    // A DIFFERENT array reference (same content) must still serialize correctly.
    const toolsClone = [
      { name: 'bash', description: 'b', parameters: { type: 'object' }, execute: () => '' },
      { name: 'edit_file', description: 'e', parameters: { type: 'object' }, execute: () => '' },
    ];
    await drain(client.stream({ messages: [], tools: toolsClone }));
    const body3 = JSON.parse(String(seenBodies[2]!.body)) as { tools: unknown[] };
    expect(body3.tools).toEqual(body1.tools);
  });
});

describe('endpoint fallback', () => {
  const PRIMARY = 'https://example.test/v1/chat/completions';
  const BACKUP = 'https://backup.test/v1/chat/completions';
  const ok = (): Response =>
    sseResponse('data: {"choices":[{"delta":{"content":"served"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');

  it('switches to the fallback on a terminal failure, inside the same request', async () => {
    const rec = byUrl({
      [PRIMARY]: () => new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl);
    const events = await drain(client.stream({ messages: [] }));

    // A 401 is terminal — retrying the SAME host cannot fix a rejected key, so
    // the primary is tried exactly once and the budget moves to the fallback.
    expect(rec.calls).toEqual([PRIMARY, BACKUP]);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'served')).toBe(true);
  });

  it('switches to the fallback after the retry budget is spent', async () => {
    const rec = byUrl({
      [PRIMARY]: () => new Response(null, { status: 503 }),
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl);
    const events = await drain(client.stream({ messages: [] }));

    // A 503 IS worth retrying, so the same host gets the whole budget first — it
    // is the most likely place for the next attempt to succeed.
    expect(rec.calls.filter((u) => u === PRIMARY)).toHaveLength(4); // 1 + maxRetries(3)
    expect(rec.calls.at(-1)).toBe(BACKUP);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'served')).toBe(true);
  });

  it('hands a rate-limited primary over to the fallback once its window budget is spent', async () => {
    // A bare 429 is not the same kind of failure as a 503: the attempt budget
    // would be spent on backoff that cannot outlast a per-minute quota. With no
    // window waits allowed, the handover happens as soon as the second failure
    // proves the cheap answer did not work — and the fallback is a different
    // host, so it may well not be throttled at all.
    const rec = byUrl({
      [PRIMARY]: () => new Response(null, { status: 429 }),
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl);
    const events = await drain(client.stream({ messages: [] }));

    expect(rec.calls.filter((u) => u === PRIMARY)).toHaveLength(2);
    expect(rec.calls.at(-1)).toBe(BACKUP);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'served')).toBe(true);
  });

  it('addresses the fallback with its own key, and its model only when it names one', async () => {
    const rec = byUrl({
      [PRIMARY]: () => new Response(null, { status: 403 }),
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl, {
      baseURL: 'https://backup.test/v1',
      apiKey: 'sk-backup',
      model: 'backup-model',
    });
    await drain(client.stream({ messages: [] }));

    expect(rec.keys).toEqual(['Bearer sk-test', 'Bearer sk-backup']);
    // The body is rebuilt per endpoint, so the model id follows the endpoint.
    expect(rec.bodies.map((b) => b['model'])).toEqual(['test-model', 'backup-model']);
  });

  it('defaults the fallback model to the primary\'s when the fallback names none', async () => {
    const rec = byUrl({
      [PRIMARY]: () => new Response(null, { status: 404 }),
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl);
    await drain(client.stream({ messages: [] }));
    expect(rec.bodies.map((b) => b['model'])).toEqual(['test-model', 'test-model']);
  });

  it('announces a mid-reply switch with a reset naming the failed endpoint', async () => {
    const rec = byUrl({
      // Every attempt on the primary delivers a partial reply and then dies.
      [PRIMARY]: () => failingSseResponse('data: {"choices":[{"delta":{"content":"par"}}]}\n\n'),
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl);
    const events = await drain(client.stream({ messages: [] }));

    const resets = events.filter((e): e is Extract<StreamEvent, { type: 'reset' }> => e.type === 'reset');
    // 3 in-target retries + 1 for the endpoint switch itself.
    expect(resets).toHaveLength(4);
    // The last one is the switch, and it names WHERE the failure was: without
    // the host an operator cannot tell a bad endpoint from a bad request.
    expect(resets.at(-1)?.error).toContain('https://example.test/v1');
    // Every primary attempt replayed from scratch, and only the fallback's reply
    // survived — that is what the reset contract buys.
    expect(
      events.filter((e): e is Extract<StreamEvent, { type: 'text_delta' }> => e.type === 'text_delta').map((e) => e.text),
    ).toEqual(['par', 'par', 'par', 'par', 'served']);
  });

  it('prefers the fallback for later requests while the primary is in cooldown', async () => {
    let backupMode: 'ok' | 'fail' = 'ok';
    const rec = byUrl({
      [PRIMARY]: () => new Response(null, { status: 401 }),
      [BACKUP]: () => (backupMode === 'ok' ? ok() : new Response(null, { status: 500 })),
    });
    const client = failoverClient(rec.impl);
    await drain(client.stream({ messages: [] }));
    expect(rec.calls).toEqual([PRIMARY, BACKUP]);

    // Second request: the primary just failed, so the known-good fallback takes
    // the first attempt and the primary is not re-hit at all.
    rec.calls.length = 0;
    await drain(client.stream({ messages: [] }));
    expect(rec.calls).toEqual([BACKUP]);
  });

  it('returns to the primary once it serves, and keeps it as the last resort meanwhile', async () => {
    let primaryMode: 'fail' | 'ok' = 'fail';
    let backupMode: 'ok' | 'fail' = 'ok';
    const rec = byUrl({
      [PRIMARY]: () => (primaryMode === 'ok' ? ok() : new Response(null, { status: 401 })),
      [BACKUP]: () => (backupMode === 'ok' ? ok() : new Response(null, { status: 401 })),
    });
    const client = failoverClient(rec.impl);
    await drain(client.stream({ messages: [] }));
    expect(rec.calls).toEqual([PRIMARY, BACKUP]);

    // While cooling down the primary is still IN the plan, last — so a fallback
    // that also fails ends with the primary's error instead of "no endpoints".
    rec.calls.length = 0;
    backupMode = 'fail';
    primaryMode = 'ok';
    await drain(client.stream({ messages: [] }));
    expect(rec.calls).toEqual([BACKUP, PRIMARY]);

    // The primary served that request, so it leads again.
    rec.calls.length = 0;
    await drain(client.stream({ messages: [] }));
    expect(rec.calls).toEqual([PRIMARY]);
  });

  it('reports the last endpoint\'s error when every endpoint fails', async () => {
    const rec = byUrl({
      [PRIMARY]: () => new Response('{"error":{"message":"primary down"}}', { status: 401 }),
      [BACKUP]: () => new Response('{"error":{"message":"backup down"}}', { status: 401 }),
    });
    const client = failoverClient(rec.impl);
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow('backup down');
    expect(rec.calls).toEqual([PRIMARY, BACKUP]);
  });

  it('drops a fallback that repeats the primary instead of spending it twice', async () => {
    const rec = byUrl({ [PRIMARY]: () => new Response(null, { status: 401 }) });
    const client = failoverClient(rec.impl, {
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
    });
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow('HTTP 401');
    expect(rec.calls).toEqual([PRIMARY]);
  });

  it('does not switch endpoints when the caller aborted', async () => {
    const controller = new AbortController();
    const rec = byUrl({
      [PRIMARY]: () => {
        controller.abort();
        return new Response(null, { status: 401 });
      },
      [BACKUP]: ok,
    });
    const client = failoverClient(rec.impl);
    await expect(drain(client.stream({ messages: [], signal: controller.signal }))).rejects.toThrow();
    expect(rec.calls).toEqual([PRIMARY]);
  });
});

describe('session cache routing', () => {
  it('sends prompt_cache_key and session affinity headers when sessionId is set', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const longId = 'sess_abcdefghijklmnop'.repeat(4); // 84 chars, above the 64-char budget
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      sessionId: longId,
      fetchImpl,
    });
    await drain(client.stream({ messages: [] }));

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-session-id']).toBe(longId);
    // Request-scoped id: unique per request, prefixed by the session id.
    expect(headers['x-client-request-id']).toBe(`${longId}-1`);
    expect(headers['x-session-affinity']).toBe(longId);
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body['prompt_cache_key']).toBe(longId.slice(0, 64));
  });

  it('omits cache routing entirely when sessionId is unset', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = clientWith(fetchImpl);
    await drain(client.stream({ messages: [] }));

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-session-id']).toBeUndefined();
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body['prompt_cache_key']).toBeUndefined();
  });

  it('rebinds the session identity via setSessionId (e.g. /new)', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      sessionId: 'sess_old',
      fetchImpl,
    });
    client.setSessionId('sess_new');
    await drain(client.stream({ messages: [] }));

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['x-session-id']).toBe('sess_new');
    expect(headers['x-session-affinity']).toBe('sess_new');
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(body['prompt_cache_key']).toBe('sess_new');
  });

  it('honors Retry-After from a 429 response before succeeding', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }));
      }
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl,
      // If the server hint were ignored, backoff would stall for ~5s here.
      retryBaseDelayMs: 5000,
    });
    const started = Date.now();
    await drain(client.stream({ messages: [] }));
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('honors an HTTP-date Retry-After (past date retries immediately)', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls += 1;
      if (calls === 1) {
        // Long past: the server's "wait until" already elapsed → 0ms wait.
        return Promise.resolve(
          new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': 'Sun, 06 Nov 1994 08:49:37 GMT' },
          }),
        );
      }
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl,
      retryBaseDelayMs: 5000,
    });
    const started = Date.now();
    await drain(client.stream({ messages: [] }));
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('fails loudly on an unparseable Retry-After instead of guessing a delay', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('rate limited', { status: 429, headers: { 'retry-after': 'soon' } }));
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl,
      retryBaseDelayMs: 1,
      maxRetries: 0,
    });
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow(/invalid retry-after/);
  });

  it('caps its own exponential backoff at RETRY_BACKOFF_MAX_MS', async () => {
    // A generous base with late attempts would otherwise sleep for minutes.
    // The spy also sees the per-attempt idle-timeout arms (timeoutMs each);
    // filter those out — the backoff waits are the ones that must be capped.
    const realSetTimeout = globalThis.setTimeout;
    const waits: number[] = [];
    const setTimeoutSpy = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      waits.push(ms ?? 0);
      return realSetTimeout(handler, 0, ...(rest as []));
    }) as typeof setTimeout;
    vi.stubGlobal('setTimeout', setTimeoutSpy);
    try {
      const failures = 4;
      let calls = 0;
      const fetchImpl: typeof fetch = () => {
        calls += 1;
        if (calls <= failures) return Promise.resolve(new Response('busy', { status: 503 }));
        return Promise.resolve(sseResponse('data: [DONE]\n\n'));
      };
      const timeoutMs = 120_000;
      const client = new OpenAICompatClient({
        baseURL: 'https://example.test/v1',
        apiKey: 'sk-test',
        model: 'test-model',
        fetchImpl,
        retryBaseDelayMs: 60_000,
        maxRetries: failures,
        timeoutMs,
      });
      await drain(client.stream({ messages: [] }));
      expect(calls).toBe(failures + 1);
      const backoffs = waits.filter((ms) => ms !== timeoutMs);
      // One backoff sleep per failed attempt; every one capped (jitter adds
      // at most half the base — still far under the uncapped 60s*2^3).
      expect(backoffs).toHaveLength(failures);
      for (const ms of backoffs) expect(ms).toBeLessThanOrEqual(RETRY_BACKOFF_MAX_MS + 30_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('parseRetryAfterMs', () => {
  const headers = (value: string | null): Headers => {
    const h = new Headers();
    if (value !== null) h.set('retry-after', value);
    return h;
  };

  it('parses delta-seconds and caps huge hints at 60s', () => {
    expect(parseRetryAfterMs(headers('2'))).toBe(2000);
    expect(parseRetryAfterMs(headers('0'))).toBe(0);
    expect(parseRetryAfterMs(headers('3600'))).toBe(60_000);
  });

  it('resolves HTTP-dates against now (past → 0, near future → delta)', () => {
    const now = Date.parse('2026-09-14T00:00:00.000Z');
    expect(parseRetryAfterMs(headers('Sun, 06 Nov 1994 08:49:37 GMT'), now)).toBe(0);
    const future = new Date(now + 5000).toUTCString();
    const delta = parseRetryAfterMs(headers(future), now)!;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(5000);
  });

  it('returns undefined only when the header is absent', () => {
    expect(parseRetryAfterMs(headers(null))).toBeUndefined();
  });

  it('throws on present-but-unparseable values (fail-closed, no guessing)', () => {
    expect(() => parseRetryAfterMs(headers('soon'))).toThrow(/invalid retry-after/);
    expect(() => parseRetryAfterMs(headers('-5'))).toThrow(/invalid retry-after/);
    expect(() => parseRetryAfterMs(headers(''))).toThrow(/invalid retry-after/);
  });
});

describe('listModels', () => {
  it('fetches GET /models, de-duplicates and sorts ids', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'z-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl,
    });
    await expect(client.listModels()).resolves.toEqual(['a-model', 'z-model']);
    expect(capturedUrl).toBe('https://example.test/v1/models');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-test');
  });

  it('throws HttpError with the body excerpt on failure', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('forbidden', { status: 401, headers: {} }));
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl,
    });
    await expect(client.listModels()).rejects.toThrow('HTTP 401');
  });
});

describe('stream protocol hardening', () => {
  it('surfaces a malformed non-JSON data payload instead of silently dropping it', async () => {
    // Killing test: the old `catch { continue }` swallowed the corruption and
    // let the surrounding text look like a complete answer.
    const body = [
      'data: {"choices":[{"delta":{"content":"par"}}]}',
      '',
      'data: this-is-not-json',
      '',
      'data: {"choices":[{"delta":{"content":"tial"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const client = clientWith(() => Promise.resolve(sseResponse(body)));
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow(/malformed SSE payload/);
  });

  it('skips an empty data field without failing the stream', async () => {
    const body = [
      'data:',
      '',
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const client = clientWith(() => Promise.resolve(sseResponse(body)));
    const events = await drain(client.stream({ messages: [] }));
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'ok')).toBe(true);
  });

  it('freezes the endpoint for the whole stream so a mid-retry switch cannot re-point it', async () => {
    // Killing test: reading baseURL/apiKey/model from the live config on every
    // attempt let a provider switch during the backoff send the OLD body to the
    // NEW endpoint.
    const urls: string[] = [];
    const models: unknown[] = [];
    let calls = 0;
    let client!: OpenAICompatClient;
    const fetchImpl: typeof fetch = (input, init) => {
      urls.push(String(input));
      models.push((JSON.parse(String(init?.body)) as { model?: unknown }).model);
      calls += 1;
      if (calls === 1) {
        client.setEndpoint({ baseURL: 'https://other.test/v2', apiKey: 'sk-2', model: 'other-model' });
        return Promise.resolve(new Response('busy', { status: 503 }));
      }
      return Promise.resolve(sseResponse('data: [DONE]\n\n'));
    };
    client = clientWith(fetchImpl);
    await drain(client.stream({ messages: [] }));

    expect(urls).toEqual([
      'https://example.test/v1/chat/completions',
      'https://example.test/v1/chat/completions',
    ]);
    expect(models).toEqual(['test-model', 'test-model']);
    // The switch itself took effect for the NEXT stream.
    expect(client.model).toBe('other-model');
  });

  it('re-arms a full idle budget once the headers arrive', async () => {
    // Killing test: without the re-arm the body inherited whatever was left of
    // the header wait, so a slow TTFT starved the stream that followed. The
    // fake fetch HONOURS the abort signal — otherwise the idle timer would have
    // nothing to cut and the test would pass either way.
    const timeoutMs = 200;
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      timeoutMs,
      maxRetries: 0,
      fetchImpl: (_input, init) =>
        new Promise<Response>((resolve) => {
          let controller!: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              // Headers take most of the attempt budget…
              setTimeout(() => {
                resolve(
                  new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
                );
                // …and the first body byte lands after the ORIGINAL deadline
                // but well within a freshly armed one.
                setTimeout(() => {
                  if (init?.signal?.aborted) return;
                  controller.enqueue(
                    new TextEncoder().encode(
                      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    ),
                  );
                  controller.close();
                }, 110);
              }, 150);
            },
          });
          init?.signal?.addEventListener(
            'abort',
            () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            { once: true },
          );
        }),
    });
    const events = await drain(client.stream({ messages: [] }));
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'ok')).toBe(true);
  });

  it('bounds a never-ending error body instead of hanging the client', async () => {
    // Killing test: `response.text()` with the attempt timer already disarmed
    // waits forever on a gateway that opens a 500 and never closes it.
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":'));
              // Never close: the read must be cut by the deadline, not by EOF.
            },
          }),
          { status: 500, headers: {} },
        ),
      );
    const client = new OpenAICompatClient({
      baseURL: 'https://example.test/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      fetchImpl,
      timeoutMs: 40,
      maxRetries: 0,
    });
    const started = Date.now();
    await expect(drain(client.stream({ messages: [] }))).rejects.toThrow('HTTP 500');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

