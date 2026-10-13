/**
 * Deadlines for the QQ channel's outbound requests.
 *
 * Every request this package makes to QQ crosses a network the operator does not
 * control, and a request that never settles is not a slow request — it is a
 * channel that never reports and a settings page stuck on "connecting". So each
 * one carries a wall-clock bound, and the bound is applied where the complete
 * operation is known (the whole request, not one socket write).
 *
 * The abort signal is passed to `fetch` so a real transport cancels the request;
 * the race is the backstop for an injected transport that ignores it (tests, and
 * any host whose fetch drops signals on the floor). A loser that rejects after
 * the race settled is absorbed here so it cannot surface as an unhandled
 * rejection and take the process with it.
 */

/** How long one outbound request may take before it is abandoned. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** Raised when an operation exceeded its wall-clock bound. */
export class QqTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`qqbot: ${what} timed out after ${timeoutMs}ms`);
    this.name = 'QqTimeoutError';
  }
}

/**
 * Run one operation with a wall-clock bound.
 * @param work - the operation, given a signal it should forward to its transport.
 * @param what - what is being waited on, for the error message.
 * @param timeoutMs - the bound; defaults to `DEFAULT_REQUEST_TIMEOUT_MS`.
 * @returns the operation's result.
 * @throws QqTimeoutError when the bound expires first.
 */
export async function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  what: string,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new QqTimeoutError(what, timeoutMs));
    }, timeoutMs);
  });
  // The operation is started ONCE and both racers observe the same promise; the
  // losing branch's rejection is swallowed below so only the race's outcome
  // reaches the caller.
  const pending = work(controller.signal);
  try {
    return await Promise.race([pending, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Attach a handler to the abandoned operation: without this, a transport that
    // rejects AFTER the deadline produced an unhandled rejection.
    void pending.catch(() => undefined);
  }
}
