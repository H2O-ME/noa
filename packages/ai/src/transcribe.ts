/**
 * Speech-to-text over an OpenAI-compatible endpoint
 * (`POST {baseURL}/audio/transcriptions`, multipart).
 *
 * A SEPARATE client from `OpenAICompatClient` for the reason `embed.ts` gives for
 * embeddings: the transcription model is a different model id from the chat
 * model, and a chat id sent to `/audio/transcriptions` is a 404. One client, one
 * model, no ambiguity — and a caller with no `sttModel` never constructs this one.
 *
 * The request is multipart (`file` + `model`), which is what the Whisper API shape
 * requires and what GLM/Zhipu's audio endpoint accepts too. Both response shapes
 * are read: `{ text }` (Whisper) and `{ choices: [{ message: { content } }] }`
 * (the chat-completions shape GLM returns). Anything else is a protocol error
 * rather than a silent empty transcript, because an empty string is a legitimate
 * answer ("the engine heard nothing") and the two must not be conflated.
 *
 * No audio decoding and no conversion: the caller hands over bytes it already has,
 * and a SILK clip is the caller's problem (QQ provides a pre-converted WAV URL).
 */
import type { TranscribeHints, TranscriptionClient } from '@noa/core';
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

export interface OpenAICompatTranscribeConfig {
  baseURL: string;
  apiKey: string;
  /** The transcription model id, as the endpoint spells it. */
  model: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Retries for 429/5xx/network errors. Default 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default 500. */
  retryBaseDelayMs?: number;
  /** Wall-clock budget for one request (headers AND body). Default 60s. */
  timeoutMs?: number;
}

/** Default per-request wall clock: uploading audio and waiting on ASR is slower than a chat call. */
export const TRANSCRIBE_DEFAULT_TIMEOUT_MS = 60_000;
/** Error body cap, matching the other clients' discipline. */
const TRANSCRIBE_ERROR_BODY_MAX_BYTES = 64 * 1024;
/** Success body cap: a transcript is short, but a broken gateway is not. */
const TRANSCRIBE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Build a transcription client against one OpenAI-compatible endpoint.
 * @param config - endpoint, key and transcription model id.
 * @returns the client the `transcription` capability is provided under.
 */
export function createTranscribeClient(config: OpenAICompatTranscribeConfig): TranscriptionClient {
  return new OpenAICompatTranscriber(config);
}

class OpenAICompatTranscriber implements TranscriptionClient {
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly config: OpenAICompatTranscribeConfig) {
    this.model = config.model;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.maxRetries = config.maxRetries ?? 2;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    this.timeoutMs = config.timeoutMs ?? TRANSCRIBE_DEFAULT_TIMEOUT_MS;
  }

  async transcribe(bytes: Uint8Array, hints?: TranscribeHints): Promise<string> {
    if (bytes.length === 0) return '';
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.requestOnce(bytes, hints);
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
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async requestOnce(bytes: Uint8Array, hints: TranscribeHints | undefined): Promise<string> {
    const url = `${this.config.baseURL.replace(/\/+$/, '')}/audio/transcriptions`;
    const form = new FormData();
    // A `File` (Blob with a name) rather than a bare Blob: the endpoint keys off
    // the filename's extension for some formats, and an unnamed part is rejected
    // by strict gateways.
    const filename = hints?.filename !== undefined && hints.filename.length > 0
      ? hints.filename
      : defaultFilename(hints?.mediaType);
    // Copy into a standalone ArrayBuffer: `BlobPart` wants one, and slicing also
    // detaches the part from any larger buffer the caller handed us.
    const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    form.append('file', new Blob([audio], { type: hints?.mediaType ?? 'application/octet-stream' }), filename);
    form.append('model', this.model);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      const err = new Error(`transcription request timed out after ${this.timeoutMs}ms`);
      err.name = 'TimeoutError';
      controller.abort(err);
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        // No `content-type`: the multipart boundary must be set by the runtime.
        headers: { authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await readBoundedText(response, TRANSCRIBE_ERROR_BODY_MAX_BYTES, this.timeoutMs);
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
      const text = await readBoundedText(response, TRANSCRIBE_RESPONSE_MAX_BYTES, this.timeoutMs);
      return parseTranscriptBody(text);
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

/** 平台没给文件名时按媒体类型猜一个扩展名，好让端点认得出容器。 */
function defaultFilename(mediaType: string | undefined): string {
  const type = (mediaType ?? '').toLowerCase();
  if (type.includes('wav')) return 'audio.wav';
  if (type.includes('mp3') || type.includes('mpeg')) return 'audio.mp3';
  if (type.includes('ogg')) return 'audio.ogg';
  if (type.includes('m4a') || type.includes('mp4')) return 'audio.m4a';
  if (type.includes('flac')) return 'audio.flac';
  return 'audio.wav';
}

/**
 * Read a transcript out of either response shape.
 *
 * `{ text }` is the Whisper API's; `{ choices[0].message.content }` is what GLM's
 * audio endpoint returns because it is served by the chat completions route.
 * A body that is neither is a protocol error: silently returning '' would make a
 * broken endpoint look like a silent recording.
 * @param text - the response body.
 * @returns the transcript (possibly empty).
 */
export function parseTranscriptBody(text: string): string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderProtocolError(`transcription response is not JSON: ${text.slice(0, 200)}`);
  }
  if (typeof json !== 'object' || json === null) {
    throw new ProviderProtocolError('transcription response is not an object');
  }
  const record = json as Record<string, unknown>;
  if (typeof record['text'] === 'string') return record['text'];
  const choices = record['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const content = first?.message?.content;
    if (typeof content === 'string') return content;
  }
  throw new ProviderProtocolError('transcription response carries neither "text" nor "choices[0].message.content"');
}
