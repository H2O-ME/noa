/**
 * The failure taxonomy and retry policy of an OpenAI-compatible endpoint.
 *
 * Split out of `client.ts` because these are pure decisions about ERRORS —
 * what an upstream failure means and whether re-asking can help — while the
 * client is a state machine about BYTES (headers, SSE frames, the retry loop
 * that consumes these verdicts). The two answer different questions, so they
 * are read and changed separately.
 *
 * `ai` keeps `@noa/core` as a types-only dependency to stay a
 * provider-agnostic leaf runtime, so the small error-message idiom lives here
 * rather than forcing the first ai→core runtime edge for one helper.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Parsed `retry-after` hint; authoritative delay for the retry backoff. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * Upstream spoke a stream we could not decode (a non-JSON `data:` payload, an
 * event past the parser's size bound). Distinct from a transport failure so the
 * retry policy can name it, and retryable on purpose: a corrupted chunk means
 * the reply in flight is wrong, and replaying from a clean prefix is the honest
 * recovery.
 */
export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}

/**
 * Upper bound for the client's OWN exponential backoff between attempts. The
 * growth is base * 2^attempt + jitter: without a cap a generous
 * retryBaseDelayMs (or a late attempt) parks the run for minutes on a
 * transient 429/5xx. Server hints are capped separately in
 * parseRetryAfterMs; this caps only our own growth.
 */
export const RETRY_BACKOFF_MAX_MS = 32_000;

/**
 * How long to wait for a 429 that came with NO `retry-after`.
 *
 * The exponential backoff is built for transient blips: it tops out at
 * {@link RETRY_BACKOFF_MAX_MS}, and its whole budget is spent inside ten seconds.
 * A rate-limit rejection is not a blip — it is a quota with a window, and
 * re-asking inside that window cannot succeed. Observed live: the gateway
 * answered `429 {"message":"rpm exhausted"}` with no hint, the client spent four
 * attempts in about seven seconds, and the turn died telling the operator to try
 * again later.
 *
 * A minute is the window the common quotas are counted over (`rpm` is literally
 * requests-per-minute). It is a guess, so it is bounded by
 * {@link DEFAULT_MAX_RATE_LIMIT_WAITS} — and a server that DOES send
 * `retry-after` is still believed instead (see `parseRetryAfterMs`).
 */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * How many times one request may sit out a full {@link RATE_LIMIT_WINDOW_MS}.
 *
 * Bounded because the wait is OUR guess, not the server's instruction, and
 * because the run is holding a chat peer's reply window open while it waits
 * (a QQ group window is minutes, not hours). Two windows is long enough to
 * outlast a per-minute quota and short enough to still answer within one.
 */
export const DEFAULT_MAX_RATE_LIMIT_WAITS = 2;

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * A rate-limit rejection the server gave us NO delay hint for.
 *
 * The distinction is what decides how long to wait: a 429 with `retry-after`
 * names its own delay and is honored as given, while a bare one only says
 * "quota", and the window has to come from {@link RATE_LIMIT_WINDOW_MS}.
 *
 * Only the status is read. The body of a rejection is prose the operator can
 * change at will (`rpm exhausted`, a Chinese sentence, a JSON error object), so
 * matching on it would break the moment the gateway rewords it.
 */
export function isUnhintedRateLimit(err: unknown): boolean {
  return err instanceof HttpError && err.status === 429 && err.retryAfterMs === undefined;
}

/**
 * Retry-worthiness of one failed attempt. HTTP 4xx (except 429) is terminal —
 * the request itself is wrong and retrying cannot fix it. Everything else
 * (network errors, 429/5xx, mid-stream drops, provider error chunks, streams
 * that ended without a finish reason) is retried within the attempt budget.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof HttpError) return isRetryableStatus(err.status);
  return true;
}

/**
 * Server-provided retry delay in ms from the `retry-after` response header.
 * Two RFC forms, both authoritative over our own backoff:
 * - delta-seconds (`120`): wait that many seconds from now — the common form;
 * - HTTP-date (`Sun, 06 Nov 1994 08:49:37 GMT`): wait until that instant
 *   (already past → 0, do not sleep backwards).
 * Returns undefined when the header is absent. Anything else present-but-
 * unparseable (a negative delta, a garbage string, a date that will not
 * parse) throws: the server asked us to wait an amount we cannot honor, and
 * silently guessing (0? 60s?) either hammers a throttled endpoint or parks the
 * run — fail loudly instead.
 */
export function parseRetryAfterMs(headers: Headers, nowMs: number = Date.now()): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) {
    const seconds = Number.parseInt(value, 10);
    if (seconds < 0) throw new Error(`invalid retry-after header: ${JSON.stringify(raw)}`);
    // Cap at the client timeout so a huge server hint cannot stall the run.
    return Math.min(seconds * 1000, 60_000);
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const seconds = Number.parseFloat(value);
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`invalid retry-after header: ${JSON.stringify(raw)}`);
    }
    return Math.min(seconds * 1000, 60_000);
  }
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) throw new Error(`invalid retry-after header: ${JSON.stringify(raw)}`);
  return Math.max(0, Math.min(dateMs - nowMs, 60_000));
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}
