/**
 * Byte-level plumbing shared by the client's request paths: keeping an idle
 * timer honest while a response streams, and reading an untrusted body under a
 * bound.
 *
 * Extracted from `client.ts` so the retry loop reads as a state machine over
 * attempts rather than being interleaved with reader/lock/timer bookkeeping.
 */

/**
 * Pass-through byte stream that re-arms the attempt's idle timer on every
 * raw chunk — keep-alive comments and partial SSE frames count as liveness
 * even though parseSse emits no event for them.
 */
export async function* keepAlive(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk();
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read at most `maxBytes` of a response body as text, under its own deadline.
 *
 * Used for error responses only: their body is untrusted (a broken gateway can
 * stream forever or hand back gigabytes), and the attempt's idle timer is
 * already disarmed by the time we get here. A cancel-on-timeout closes the
 * pending read; whatever arrived is kept, because the status and partial text
 * are still the most useful diagnostic.
 * @param response - the non-ok response.
 * @param maxBytes - byte cap for the accumulated text.
 * @param timeoutMs - wall-clock budget for the whole read.
 * @param signal - the caller's abort signal, honoured so a user interrupt does
 *   not wait out the error body.
 * @returns the (possibly truncated) body text.
 */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const timer = setTimeout(cancel, timeoutMs);
  const onAbort = (): void => cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (bytes >= maxBytes) break;
      }
    }
    text += decoder.decode();
  } catch {
    // Keep whatever arrived; the status line still describes the failure.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // A read cancelled by the timer may still be settling; the stream is
      // already cancelled, so an unreleased lock costs nothing here.
    }
  }
  return text.slice(0, maxBytes);
}
