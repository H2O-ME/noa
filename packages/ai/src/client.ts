/**
 * Hand-rolled OpenAI-compatible streaming client.
 *
 * This module is the STATE MACHINE: it addresses an endpoint, runs the retry
 * loop over attempts, and drives the SSE decoder. What the bytes MEAN lives in
 * `wire.ts` (IR ↔ vendor JSON), what a failure MEANS in `retry.ts`, and the
 * reader/timer plumbing in `transport.ts` — so this file only has to be
 * correct about ordering: when the target is frozen, when the idle timer is
 * armed, which failures retry, and what a partial reply leaves behind.
 *
 * - Internal AgentMessage/ToolDefinition IR is mapped to the wire format by
 *   `wire.ts`, so core stays provider-agnostic.
 * - Every retry policy lives in stream(): 429/5xx/network errors before the
 *   stream starts, and mid-stream failures (dropped connections, provider
 *   error chunks, streams that end without a finish reason) retry within the
 *   same budget — after partial output a `reset` event lets consumers discard
 *   their in-flight state before the retry replays from scratch.
 * - The SAME `reset` contract covers the second axis of failure, the ENDPOINT:
 *   when one host cannot serve the request at all (a terminal 401/403/404, or a
 *   retry budget spent on a 429) the stream moves to the next configured
 *   fallback and replays there, inside the one request.
 */
import type { ChatProvider, ChatRequest, StreamEvent, ToolDefinition } from '@noa/core';
import {
  HttpError,
  ProviderProtocolError,
  RETRY_BACKOFF_MAX_MS,
  abortError,
  errMessage,
  isAbortError,
  isRetryableError,
  parseRetryAfterMs,
  sleep,
} from './retry.js';
import { parseSse } from './sse.js';
import { keepAlive, readBoundedText } from './transport.js';
import { translateChunk, toProviderMessage, toProviderTool, type ProviderChunk } from './wire.js';

/**
 * A second endpoint to try when the primary one is unusable.
 *
 * Deliberately just an endpoint: same protocol, same request body shape, same
 * tool wire format — so a fallback is not "another provider", it is another
 * address for the same conversation. `model` is optional because the common case
 * is "the same model served by a different host or account"; name it only when
 * the two endpoints spell the id differently.
 */
export interface ProviderFallback {
  baseURL: string;
  apiKey: string;
  /** Model id as THIS endpoint spells it; defaults to the primary's. */
  model?: string;
}

export interface OpenAICompatConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /**
   * Endpoints to fall back to, in order, when the primary fails terminally
   * (401/403/404 — the request itself is rejected, so re-asking the same host
   * cannot help) or spends its whole retry budget (rate limit, quota, a host
   * that is simply down). See {@link OpenAICompatClient.stream}.
   */
  fallbacks?: readonly ProviderFallback[];
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Retries for 429/5xx/network errors before the stream starts. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default 500. */
  retryBaseDelayMs?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Passed through as `max_tokens` when set. */
  maxTokens?: number;
  /**
   * Stable per-session id (pi-style cache routing): sent as the OpenAI
   * `prompt_cache_key` body field and as `x-session-id` /
   * `x-client-request-id` / `x-session-affinity` headers so gateways route
   * all turns of one session to the same cache-affine backend. Unknown body
   * fields and x-headers are ignored by providers that do not support them.
   */
  sessionId?: string;
}

/**
 * The endpoint identity frozen for the lifetime of ONE stream. Sampling knobs
 * and the retry budget stay on the client (they describe the client, not the
 * endpoint); this is only what a request addresses, so a mid-flight
 * `setEndpoint` / `setModel` cannot desync the URL from the body.
 */
interface RequestTarget {
  baseURL: string;
  apiKey: string;
  model: string;
  sessionId: string | undefined;
}

/** Cap for an error response body read into a message (a bad gateway may not end). */
const ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * How long a failed primary keeps losing the FIRST attempt to the fallbacks.
 *
 * A terminal rejection (401) or an exhausted retry budget says the endpoint is
 * bad NOW; making every subsequent request rediscover that costs a full attempt
 * plus its backoff, and on a rate limit it costs another rejection. The window
 * is short because it is a guess about a transient condition, not a verdict:
 * once it lapses the primary is tried first again, so a recovered endpoint is
 * picked back up without a restart.
 */
const PRIMARY_COOLDOWN_MS = 60_000;

/** One endpoint in the order a single request will try them. */
interface PlannedTarget {
  target: RequestTarget;
  primary: boolean;
}

export class OpenAICompatClient implements ChatProvider {
  private readonly config: OpenAICompatConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fallbacks: readonly ProviderFallback[];
  /** Epoch ms until which later requests try the fallbacks before the primary. */
  private primaryCooldownUntil = 0;
  private requestSeq = 0;
  /**
   * Wire-format tool array cached by the input array's identity. The caller
   * (PluginHost.tools) returns a stable reference across turns until a tool
   * is registered/deregistered, so the sort+map work — which produces a
   * content-identical array every turn — only runs once per toolset. The
   * cache is per-client because the output is deterministic given the input;
   * a different toolset arrives as a different array reference and misses.
   */
  private readonly toolWireCache = new WeakMap<ToolDefinition[], Record<string, unknown>[]>();

  constructor(config: OpenAICompatConfig) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    // A fallback that repeats the primary is not a fallback: it would spend the
    // same failing address twice and report the failure as if it had tried
    // something else. Dropped here rather than at the config schema because the
    // comparison is on the RESOLVED endpoint (env refs expanded, `model`
    // defaulted), which only this constructor sees.
    this.fallbacks = (config.fallbacks ?? []).filter(
      (f) => f.baseURL !== config.baseURL || f.apiKey !== config.apiKey || (f.model ?? config.model) !== config.model,
    );
  }

  get model(): string {
    return this.config.model;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  /** The endpoint this client currently talks to (baseURL as configured). */
  get baseURL(): string {
    return this.config.baseURL;
  }

  /**
   * Re-point this client at another OpenAI-compatible endpoint, IN PLACE.
   *
   * In place rather than "build a second client" because everything downstream
   * holds a reference to THIS instance: the kernel's `llm` service, the session
   * handles, the subagent tool's nested provider, and the cache-affinity binding.
   * Swapping the object would leave all of them talking to the previous endpoint
   * while the UI claimed the new one.
   *
   * Sampling knobs (`temperature` / `maxTokens`) move WITH the endpoint when
   * the caller names them: each BYOK provider row carries its own sampling
   * settings, so switching rows must follow the row's values — and an ABSENT
   * knob means "this endpoint has none", i.e. cleared, not "keep the previous
   * row's". The retry budget and the injectable `fetchImpl` stay client-level.
   * @param endpoint - the new baseURL, api key, default model id and sampling overrides.
   */
  setEndpoint(endpoint: { baseURL: string; apiKey: string; model: string; temperature?: number; maxTokens?: number }): void {
    this.config.baseURL = endpoint.baseURL;
    this.config.apiKey = endpoint.apiKey;
    this.config.model = endpoint.model;
    // A different endpoint has no failure history yet, so the previous
    // endpoint's cooldown must not bias the first request to this one.
    this.primaryCooldownUntil = 0;
    if (endpoint.temperature !== undefined) this.config.temperature = endpoint.temperature;
    else delete this.config.temperature;
    if (endpoint.maxTokens !== undefined) this.config.maxTokens = endpoint.maxTokens;
    else delete this.config.maxTokens;
  }

  /**
   * Rebind the session identity (e.g. /new starts a fresh session): the
   * `prompt_cache_key` body field and the x-session-affinity headers follow
   * the new id from the next request on.
   */
  setSessionId(sessionId: string): void {
    this.config.sessionId = sessionId;
  }

  /**
   * The endpoints ONE request will try, in order.
   *
   * The primary comes first, except inside the cooldown window left by its own
   * recent failure — then the fallbacks go first and the primary is still in the
   * list, LAST. Keeping it in the list is what makes the cooldown a preference
   * rather than a verdict: if every fallback fails too, the request still ends
   * with the primary's error rather than "no endpoints", and the moment the
   * window lapses the primary leads again.
   */
  private targetPlan(): PlannedTarget[] {
    const primary: RequestTarget = {
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      model: this.config.model,
      sessionId: this.config.sessionId,
    };
    const plan: PlannedTarget[] = [{ target: primary, primary: true }];
    for (const fallback of this.fallbacks) {
      plan.push({
        target: {
          baseURL: fallback.baseURL,
          apiKey: fallback.apiKey,
          model: fallback.model ?? this.config.model,
          sessionId: this.config.sessionId,
        },
        primary: false,
      });
    }
    if (plan.length > 1 && Date.now() < this.primaryCooldownUntil) {
      const [head, ...rest] = plan;
      return [...rest, head!];
    }
    return plan;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const plan = this.targetPlan();
    let lastError: unknown;
    // Whether the CURRENT target produced anything before it failed. A target
    // that fails before its first event is invisible to the consumer (the next
    // one replays from an identical clean slate); after partial output the
    // consumer must be told to drop it — the same `reset` contract as an
    // in-target retry, because it is the same situation.
    let yielded = false;
    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i]!;
      const next = plan[i + 1];
      try {
        for await (const ev of this.streamVia(step.target, req)) {
          yielded = true;
          yield ev;
        }
        // Served. A primary that works clears the cooldown — that is the whole
        // "come back to the primary" path.
        if (step.primary) this.primaryCooldownUntil = 0;
        return;
      } catch (err) {
        if (isAbortError(err) || req.signal?.aborted) throw abortError();
        lastError = err;
        if (next === undefined) break;
        if (yielded) {
          yield {
            type: 'reset',
            attempt: i + 2,
            maxRetries: this.maxRetries,
            // Naming the failed endpoint is the point: without it an operator
            // reading `llm_retry` cannot tell a bad host from a bad request.
            error: `${step.target.baseURL}: ${errMessage(err)}`,
          };
          yielded = false;
        }
        // Only the primary has a fallback to be preferred over, so only the
        // primary earns a cooldown. A failed fallback is just the next entry.
        if (step.primary) this.primaryCooldownUntil = Date.now() + PRIMARY_COOLDOWN_MS;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * ONE endpoint's whole retry budget: every attempt against `target`, retrying
   * in place, until it serves the stream or gives up (throws). Giving up is what
   * moves {@link stream} to the next endpoint — so a terminal failure (which
   * `isRetryableError` refuses to retry) hands over immediately, while a rate
   * limit spends the budget here first, because the SAME host is the most likely
   * place for the next attempt to succeed.
   */
  private async *streamVia(target: RequestTarget, req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body = this.buildBody(req, target);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (req.signal?.aborted) throw abortError();
      // Whether any event of THIS attempt reached the consumer. A retry after
      // that must announce itself (reset) so partial state can be discarded;
      // before the first event a retry is transparent.
      let yielded = false;
      try {
        const { response, armIdleTimeout, disarm } = await this.fetchOnce(target, body, req.signal);
        try {
          const responseBody = response.body;
          if (!responseBody) throw new Error('response has no body');
          let sawFinish = false;
          // Every byte from the wire re-arms the idle timer, so a healthy
          // stream may run arbitrarily long — only a stalled one is cut.
          for await (const sse of parseSse(keepAlive(responseBody, armIdleTimeout))) {
            // `[DONE]` is the transport terminator: it means the SSE stream is
            // complete, which is distinct from "a finish reason arrived". An
            // empty `[DONE]` (no content, no finish reason) is therefore still
            // possible, and core treats that as an empty completion and retries
            // (see `streamCompletion`) rather than committing a phantom turn.
            const payload = sse.data.trim();
            if (payload.toUpperCase() === '[DONE]') {
              sawFinish = true;
              return;
            }
            // An empty `data:` field carries no information (some servers pad);
            // anything else that is not JSON is upstream corruption and must
            // surface as a protocol error rather than silently vanishing from
            // the middle of a reply.
            if (payload.length === 0) continue;
            let chunk: ProviderChunk;
            try {
              chunk = JSON.parse(payload) as ProviderChunk;
            } catch {
              throw new ProviderProtocolError(`malformed SSE payload from upstream: ${payload.slice(0, 200)}`);
            }
            if (chunk.error) throw new Error(chunk.error.message ?? 'provider returned an error');
            const events = [...translateChunk(chunk)];
            if (events.length === 0) continue;
            yielded = true;
            for (const ev of events) {
              if (ev.type === 'finish') sawFinish = true;
              yield ev;
            }
          }
          // A stream that ends cleanly without a finish reason was cut off by
          // the gateway (dsh/codex "stream terminated before completion"):
          // treat it as a failure so it retries instead of silently
          // truncating the reply and reporting a complete turn.
          if (!sawFinish) throw new Error('upstream stream ended before completion (no finish reason)');
          return;
        } finally {
          disarm();
          await response.body?.cancel().catch(() => undefined);
        }
      } catch (err) {
        if (isAbortError(err)) {
          // A plain AbortError is only the user's signal — the idle timer
          // aborts with a named TimeoutError reason. Some runtimes drop the
          // reason, so classify by the request signal: if it never fired,
          // this was the stall timeout and the attempt is retryable.
          if (req.signal?.aborted) throw abortError();
          throw new Error('upstream stream stalled (idle timeout)');
        }
        if (req.signal?.aborted) throw abortError();
        lastError = err;
        if (!isRetryableError(err) || attempt === this.maxRetries) {
          throw lastError instanceof Error ? lastError : new Error(String(lastError));
        }
        if (yielded) {
          yield {
            type: 'reset',
            attempt: attempt + 1,
            maxRetries: this.maxRetries,
            error: errMessage(err),
          };
        }
        const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined;
        await sleep(retryAfterMs ?? this.backoffDelay(attempt), req.signal);
      }
    }
  }

  /**
   * ONE request attempt — every retry policy lives in stream(). The attempt's
   * own AbortController drives TWO bounded waits: the timeout covers the wait
   * for response headers (TTFT), and `armIdleTimeout` re-arms it while the
   * body streams. A generation that keeps producing bytes is never cut for
   * being slow; a stalled stream aborts into the retry path above.
   */
  private async fetchOnce(
    target: RequestTarget,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    response: Response;
    armIdleTimeout: () => void;
    disarm: () => void;
  }> {
    const url = `${target.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const attemptController = new AbortController();
    const attemptSignal = attemptController.signal;
    const timeoutError = (): Error => {
      const err = new Error(`upstream stream stalled for ${this.timeoutMs}ms`);
      err.name = 'TimeoutError';
      return err;
    };
    let timer: NodeJS.Timeout | undefined = setTimeout(() => attemptController.abort(timeoutError()), this.timeoutMs);
    const armIdleTimeout = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => attemptController.abort(timeoutError()), this.timeoutMs);
    };
    const disarm = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const combined = signal ? AbortSignal.any([signal, attemptSignal]) : attemptSignal;
    const sessionHeaders =
      target.sessionId !== undefined
        ? {
            'x-session-id': target.sessionId,
            // Request-scoped id (the header's semantics): unique per attempt.
            'x-client-request-id': `${target.sessionId}-${++this.requestSeq}`,
            'x-session-affinity': target.sessionId,
          }
        : {};
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${target.apiKey}`,
          ...sessionHeaders,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      disarm();
      throw err;
    }
    if (!response.ok) {
      disarm();
      // The error body is untrusted and may be huge or never end, so it is read
      // under a byte cap and its own deadline — `response.text()` with the
      // attempt's timer already disarmed could hang the client on a bad gateway.
      const text = await readBoundedText(response, ERROR_BODY_MAX_BYTES, this.timeoutMs, signal);
      // An unparseable retry-after fails the attempt loudly (fail-closed):
      // the server asked for a wait we cannot honor, and silently guessing
      // either hammers a throttling endpoint or parks the run. Surface it as
      // the attempt's error (no retryAfterMs: the backoff falls back to ours)
      // rather than swallowing it into undefined.
      let retryAfterMs: number | undefined;
      try {
        retryAfterMs = parseRetryAfterMs(response.headers);
      } catch (err) {
        throw new HttpError(
          response.status,
          `HTTP ${response.status}: ${text.slice(0, 500)} (${errMessage(err)})`,
        );
      }
      throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 500)}`, retryAfterMs);
    }
    // Headers arrived: the TTFT phase is over, so the idle timer is re-armed
    // with a FULL budget. Without this the body inherited whatever remained of
    // the header wait (a 119s TTFT left a 1s body budget on a 120s timeout).
    armIdleTimeout();
    return { response, armIdleTimeout, disarm };
  }

  /**
   * GET {baseURL}/models (OpenAI-compatible catalog endpoint); returns
   * de-duplicated model ids in stable alphabetical order. Used by /model to
   * offer the endpoint's actual model list instead of manual names.
   */
  async listModels(timeoutMs?: number): Promise<string[]> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}/models`;
    const response = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const json = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (json.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  private buildBody(req: ChatRequest, target: RequestTarget): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (req.systemPrompt && req.systemPrompt.length > 0) {
      messages.push({ role: 'system', content: req.systemPrompt });
    }
    for (const msg of req.messages) messages.push(toProviderMessage(msg));
    const body: Record<string, unknown> = {
      model: target.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    // Sampling knobs are CLIENT properties (see `setEndpoint`), so they are read
    // live; the endpoint identity comes from the frozen target above.
    if (this.config.temperature !== undefined) body['temperature'] = this.config.temperature;
    if (this.config.maxTokens !== undefined) body['max_tokens'] = this.config.maxTokens;
    if (target.sessionId !== undefined) {
      // OpenAI documents 64 chars as the prompt_cache_key budget.
      body['prompt_cache_key'] = [...target.sessionId].slice(0, 64).join('');
    }
    if (req.tools && req.tools.length > 0) {
      body['tools'] = this.serializeTools(req.tools);
    }
    return body;
  }

  /**
   * Map internal tool definitions to the OpenAI wire format with a stable
   * dictionary sort by name. Cached by the input array's identity — callers
   * hand us the same reference turn after turn (PluginHost.tools), so the
   * sort + map only runs the first time. A different toolset arrives as a
   * fresh array and misses. The cached array is treated as immutable from
   * the caller's side: it flows into {@link buildBody}'s output and then to
   * JSON.stringify, never mutated in place.
   */
  private serializeTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    const cached = this.toolWireCache.get(tools);
    if (cached !== undefined) return cached;
    const wire = [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(toProviderTool);
    this.toolWireCache.set(tools, wire);
    return wire;
  }

  private backoffDelay(attempt: number): number {
    return Math.min(
      this.retryBaseDelayMs * 2 ** attempt + Math.random() * (this.retryBaseDelayMs / 2),
      RETRY_BACKOFF_MAX_MS,
    );
  }
}
