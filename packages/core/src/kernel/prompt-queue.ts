/**
 * The session's prompt queue: the trigger ledger for prompts committed while a
 * run is in flight. It owns BOTH halves of that question — which prompts are
 * still waiting, and the watermark that tells a waiting prompt from one the
 * current run has already read — so the session only has to report assemblies.
 *
 * THE INVARIANT THAT MAKES THE QUEUE NECESSARY: `AgentSession.prompt()` appends
 * the user message to the durable log and to the live `messages` array
 * IMMEDIATELY, before it knows whether a run is in flight, and a run re-reads
 * that array on every turn (`runAgent` → `assembleRequest(opts.messages)`). A
 * message committed mid-run is therefore ALREADY steerable — the queue does not
 * carry the text to the model. What the queue carries is the promise that the
 * message ALSO gets a run of its own when the in-flight run ends without ever
 * assembling another request.
 *
 * A ledger of committed texts cannot express that promise, because the two cases
 * are indistinguishable by text alone. They are told apart by ONE fact: was a
 * request assembled AFTER this prompt was committed? If yes, that request read
 * the live array and the model has seen the prompt — the run already owns it. If
 * no, nothing has looked, so the prompt needs a run. Each entry therefore
 * remembers the assembly count at enqueue time and is absorbed once that count
 * grows. Both historical defects fall out of this one rule:
 *
 *  - Double answers. The queue used to be cleared only after the whole run loop
 *    ended, so an interjection the in-flight run HAD already picked up and
 *    answered still triggered a second run: the model saw a history ending in
 *    its own reply to that very text and answered it again.
 *  - The stranded row. For the same reason the absorbed trigger kept drawing
 *    itself in the queue lane until the entire run finished — minutes of UI
 *    claiming a prompt was still waiting after the model had read it.
 *
 * WHY A COUNTER AND NOT "WAS THIS MESSAGE ID IN THE REQUEST": `assembleRequest`
 * trims the request (`request-trim.ts`), so a prompt could in principle be elided
 * from EVERY request — the id test would never absorb it and the run loop would
 * never settle (an infinite run loop, the worst failure available here). The
 * counter absorbs at the next assembly unconditionally, so every entry is
 * consumed within one assembly of its commit and the loop provably terminates.
 * The counter's cost is the pathological case (a prompt trimmed out of every
 * request is treated as seen while its text stays in the history), which is
 * bounded and harmless; the alternative's cost is a hung session.
 */

/** One queued trigger: the text for the queue lane, plus its assembly watermark. */
interface QueuedPrompt {
  readonly text: string;
  /** The assembly count when this prompt was committed (see `recordAssembly`). */
  readonly enqueuedAt: number;
}

export class PromptQueue {
  private readonly entries: QueuedPrompt[] = [];
  /**
   * Requests already counted. Identity-keyed because `streamCompletion` retries
   * an empty completion by re-issuing the SAME frozen request, which does not
   * contain a prompt that arrived during the failed attempt: counting that retry
   * would mark the prompt seen and lose it. Weak so a request is not kept alive.
   */
  private readonly counted = new WeakSet<object>();
  private assemblies = 0;

  /** Assemblies so far: the loop's guard against re-running a run that read nothing. */
  get requestCount(): number {
    return this.assemblies;
  }

  get empty(): boolean {
    return this.entries.length === 0;
  }

  /** The pending texts, in commit order — what a surface renders as the queue lane. */
  get items(): string[] {
    return this.entries.map((entry) => entry.text);
  }

  /** Record a committed prompt that still needs a run. */
  enqueue(text: string): void {
    this.entries.push({ text, enqueuedAt: this.assemblies });
  }

  /**
   * Report that a request was assembled and handed to the provider, absorbing the
   * triggers it read. Call this at the instant the request's contents are final:
   * NOT at `turn_start` (`runAgent` yields it just BEFORE `assembleRequest`, so a
   * prompt landing in that gap would be counted as seen while absent from the
   * request about to be built — it would run twice).
   * @param request - the assembled request; its identity distinguishes an
   *   assembly from an empty-completion retry of the same request.
   * @returns whether the queue changed, so the caller publishes only on change.
   */
  recordAssembly(request: object): boolean {
    if (this.counted.has(request)) return false;
    this.counted.add(request);
    this.assemblies += 1;
    return this.absorb();
  }

  /**
   * Drop every entry a later request has read. This is the ONE clear point for
   * absorbed entries: clearing anywhere else either drops a trigger that still
   * needs a run, or keeps drawing one the model has already answered.
   */
  private absorb(): boolean {
    if (this.entries.length === 0) return false;
    const before = this.entries.length;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.enqueuedAt < this.assemblies) this.entries.splice(i, 1);
    }
    return this.entries.length !== before;
  }

  /**
   * Withdraw every trigger without running it (abort / close). The committed TEXT
   * is untouched: the history is append-only, so the message stays in the durable
   * log and in `messages` — and therefore in the model's context on the next run.
   * Only the "start a run for this on its own" claim is withdrawn, which is
   * precisely the claim an abort must not silently reinstate later.
   * @returns whether the queue changed, so the caller publishes only on change.
   */
  clear(): boolean {
    if (this.entries.length === 0) return false;
    this.entries.length = 0;
    return true;
  }
}
