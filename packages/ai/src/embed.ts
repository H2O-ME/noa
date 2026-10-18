/**
 * Embeddings over an OpenAI-compatible endpoint (`POST {baseURL}/embeddings`).
 *
 * A SEPARATE client from `OpenAICompatClient`, not a method on it. The reason is
 * one sentence long: the embedding model is a DIFFERENT model id from the chat
 * model. A client carrying both would need to be told which id to use per call,
 * which is exactly the ambiguity `setModel` already fights on the chat side. Two
 * clients, one model each, no ambiguity — and a caller that has no embedding
 * model simply never constructs this one.
 *
 * The retry/error/abort policy is the chat client's on purpose: 429/5xx and
 * transport failures retry inside a bounded budget, a server `retry-after` wins
 * over our own backoff, an UNPARSEABLE `retry-after` fails the attempt loudly
 * (the server asked for a wait we cannot honor), and a non-429 4xx is terminal.
 * A malformed success body is a `ProviderProtocolError`. All of it matters here
 * for one reason: the caller degrades to keyword scoring when embeddings are
 * unavailable, and it can only degrade on a failure it is actually told about —
 * a silently truncated vector would poison every later ranking instead.
 */
import type { EmbeddingClient } from '@noa/core';
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
import { readBoundedText } from './transport.js';

export interface OpenAICompatEmbedConfig {
  baseURL: string;
  apiKey: string;
  /** The embedding model id, as the endpoint spells it. */
  model: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Retries for 429/5xx/network errors. Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default 500. */
  retryBaseDelayMs?: number;
  /** Wall-clock budget for one request (headers AND body). Default 30s. */
  timeoutMs?: number;
  /**
   * Inputs per request. Default 64: comfortably under every provider's
   * inputs-per-request cap while keeping the response body small enough to read
   * in one shot. Larger batches buy little — the round trip dominates.
   */
  maxInputsPerRequest?: number;
}

/** Default per-request wall clock: an embedding is one short round trip. */
export const EMBED_DEFAULT_TIMEOUT_MS = 30_000;
/** Default inputs per request. */
export const EMBED_MAX_INPUTS = 64;
/**
 * Response body cap. A 64 × 1536-dim batch is ~2 MB of JSON numbers; this
 * leaves headroom for wider models without letting a broken gateway stream
 * gigabytes into memory.
 */
export const EMBED_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
/** Error body cap, matching the chat client's discipline. */
const EMBED_ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * Build an embedding client against one OpenAI-compatible endpoint.
 *
 * @param config - endpoint, key and embedding model id.
 * @returns the client the `embeddings` capability is provided under.
 */
export function createEmbedClient(config: OpenAICompatEmbedConfig): EmbeddingClient {
  return new OpenAICompatEmbedder(config);
}

class OpenAICompatEmbedder implements EmbeddingClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maxInputs: number;

  constructor(private readonly config: OpenAICompatEmbedConfig) {
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    this.timeoutMs = config.timeoutMs ?? EMBED_DEFAULT_TIMEOUT_MS;
    this.maxInputs = Math.max(1, Math.trunc(config.maxInputsPerRequest ?? EMBED_MAX_INPUTS));
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    // Batched by INPUT COUNT, not by bytes: the count is what every provider
    // caps, and it is the part we can honor without knowing the tokenizer.
    for (let start = 0; start < texts.length; start += this.maxInputs) {
      const batch = texts.slice(start, start + this.maxInputs);
      out.push(...(await this.embedBatch(batch)));
    }
    return out;
  }

  private async embedBatch(inputs: readonly string[]): Promise<number[][]> {
    const body = { model: this.model, input: inputs };
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.requestOnce(body, inputs.length);
      } catch (err) {
        if (isAbortError(err)) throw abortError();
        lastError = err;
        if (!isRetryableError(err) || attempt === this.maxRetries) {
          throw lastError instanceof Error ? lastError : new Error(String(lastError));
        }
        const retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined;
        await sleep(retryAfterMs ?? this.backoffDelay(attempt));
      }
    }
    // Unreachable: the loop either returns or throws.
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * One attempt, with its own deadline covering headers AND body. The timeout
   * aborts the controller rather than merely racing the promise, so a stalled
   * body read is actually cancelled instead of leaking.
   */
  private async requestOnce(body: Record<string, unknown>, expected: number): Promise<number[][]> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}/embeddings`;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const err = new Error(`embedding request timed out after ${this.timeoutMs}ms`);
      err.name = 'TimeoutError';
      controller.abort(err);
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await readBoundedText(response, EMBED_ERROR_BODY_MAX_BYTES, this.timeoutMs);
        let retryAfterMs: number | undefined;
        try {
          retryAfterMs = parseRetryAfterMs(response.headers);
        } catch (err) {
          // Fail closed, exactly as the chat client does: an unparseable wait we
          // cannot honor must not be guessed at (0 hammers, 60s parks).
          throw new HttpError(
            response.status,
            `HTTP ${response.status}: ${text.slice(0, 500)} (${errMessage(err)})`,
          );
        }
        throw new HttpError(response.status, `HTTP ${response.status}: ${text.slice(0, 500)}`, retryAfterMs);
      }
      // Read under a byte cap and the same deadline: `response.json()` on a
      // broken gateway is unbounded in both size and time.
      const text = await readBoundedText(response, EMBED_RESPONSE_MAX_BYTES, this.timeoutMs);
      return parseEmbeddingBody(text, expected);
    } finally {
      clearTimeout(timer);
    }
  }

  private backoffDelay(attempt: number): number {
    return Math.min(
      this.retryBaseDelayMs * 2 ** attempt + Math.random() * (this.retryBaseDelayMs / 2),
      RETRY_BACKOFF_MAX_MS,
    );
  }
}

/**
 * Parse `{ data: [{ embedding, index }] }` into vectors ordered like the input.
 *
 * Ordered BY INDEX, not by array position: the field exists precisely because a
 * provider may return entries in any order, and a positional read would silently
 * attach the wrong vector to the wrong text — a corruption that would only show
 * up as inexplicably bad retrieval much later.
 *
 * @param text - the response body.
 * @param expected - how many vectors the request asked for.
 * @returns the vectors, in input order.
 */
function parseEmbeddingBody(text: string, expected: number): number[][] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderProtocolError(`embedding response is not JSON: ${text.slice(0, 200)}`);
  }
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new ProviderProtocolError('embedding response has no "data" array');
  if (data.length !== expected) {
    throw new ProviderProtocolError(`embedding response has ${data.length} vectors for ${expected} inputs`);
  }
  // Indexed by the provider's own `index`, so a reply that arrives out of order
  // still lines up with the request. Every slot must be filled by the end.
  const out: (number[] | undefined)[] = Array.from({ length: expected }, () => undefined);
  let dims = -1;
  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as { embedding?: unknown; index?: unknown } | null | undefined;
    if (entry === null || typeof entry !== 'object') {
      throw new ProviderProtocolError(`embedding response entry ${i} is not an object`);
    }
    const vector = entry.embedding;
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new ProviderProtocolError(`embedding response entry ${i} carries no vector`);
    }
    if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new ProviderProtocolError(`embedding response entry ${i} has non-finite values`);
    }
    // Mixed dimensions within one reply mean the endpoint is broken; catching it
    // here keeps a ragged index out of the store (cosine over ragged vectors
    // reads as garbage, not as an error).
    if (dims === -1) dims = vector.length;
    else if (vector.length !== dims) {
      throw new ProviderProtocolError(`embedding response mixes dimensions (${dims} and ${vector.length})`);
    }
    const at = typeof entry.index === 'number' && Number.isInteger(entry.index) ? entry.index : i;
    if (at < 0 || at >= expected) {
      throw new ProviderProtocolError(`embedding response index ${at} is out of range`);
    }
    out[at] = vector as number[];
  }
  if (out.some((v) => v === undefined)) throw new ProviderProtocolError('embedding response is missing entries');
  return out as number[][];
}
