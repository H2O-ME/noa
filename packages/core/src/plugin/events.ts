/**
 * Typed events, with the dispatch mode as part of the event's contract.
 *
 * A listener is registered the same way whatever the mode; what differs is how
 * the emitter delivers. Naming the mode in the call site keeps the classic
 * plugin-system bug out — a policy plugin that silently swallows a chain —
 * because "observe" and "wrap" are visibly different calls.
 *
 *   emit       observe; nobody's return value matters, errors are contained
 *   waterfall  wrap or veto; `next()` delegates, returning without it wins
 *   parallel   fan out and wait for all; failures aggregate
 *   serial     first non-empty answer wins, in order
 *   bail       `serial` without the awaiting (for sync predicates)
 */
import type { Awaitable } from './types.js';
import { errMessage } from '../errors.js';

export interface EventKey<Args extends unknown[] = unknown[], Result = void> {
  readonly name: string;
  readonly __args?: Args;
  readonly __result?: Result;
}

export function event<Args extends unknown[] = unknown[], Result = void>(
  name: string,
): EventKey<Args, Result> {
  return { name };
}

/**
 * Registered listener shape: plain listeners simply ignore the trailing `next`.
 *
 * `next` takes the same arguments the listener received, because delegation may
 * REWRITE them (`next({ ...req, systemPrompt: hardened })`) — the runtime has
 * always accepted a replacement array, and the waterfall doc below is written in
 * terms of it. Leaving it zero-arg forced every transforming listener to cast.
 */
export type Listener<Args extends unknown[], Result> = (
  ...args: [...Args, next: (...replacement: Args | []) => Promise<Result>]
) => unknown;

export interface OnOptions {
  /** Run before listeners of equal priority. */
  prepend?: boolean;
  /** Higher runs first; default 0. */
  priority?: number;
}

/** A non-empty answer from a `serial`/`bail` chain stops it. */
export function isBailed(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

interface Entry {
  listener: (...args: unknown[]) => unknown;
  priority: number;
  seq: number;
}

export type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export class EventRegistry {
  private readonly entries = new Map<string, Entry[]>();
  private seq = 0;

  constructor(private readonly log: Logger) {}

  on(
    key: EventKey<never[], unknown> | string,
    listener: (...args: unknown[]) => unknown,
    opts?: OnOptions,
  ): () => void {
    const name = typeof key === 'string' ? key : key.name;
    const list = this.entries.get(name) ?? [];
    const entry: Entry = {
      listener,
      priority: opts?.priority ?? 0,
      seq: opts?.prepend === true ? -(this.seq++) : this.seq++,
    };
    list.push(entry);
    list.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    this.entries.set(name, list);
    return () => {
      const current = this.entries.get(name);
      if (current === undefined) return;
      const index = current.indexOf(entry);
      if (index >= 0) current.splice(index, 1);
    };
  }

  /** Listeners for a key, as a snapshot — `on` sorts the live list in place. */
  private listOf(key: EventKey<never[], unknown> | string): Entry[] {
    return [...(this.entries.get(typeof key === 'string' ? key : key.name) ?? [])];
  }

  /** Observe: every listener runs, in order; a throwing listener is contained. */
  emit(key: EventKey<never[], unknown> | string, ...args: unknown[]): void {
    // `listOf` is already a snapshot (a listener may unregister another mid-dispatch).
    for (const entry of this.listOf(key)) {
      try {
        const out = entry.listener(...args, noop);
        // "errors are contained" must cover ASYNC listeners too: a rejected
        // promise used to escape as an unhandledRejection.
        if (isThenable(out)) {
          void Promise.resolve(out).catch((err: unknown) => {
            this.log('error', `listener for "${name(key)}" rejected: ${errMessage(err)}`);
          });
        }
      } catch (err) {
        this.log('error', `listener for "${name(key)}" threw: ${errMessage(err)}`);
      }
    }
  }

  /**
   * Wrap: each listener may rewrite the arguments or veto by returning without
   * delegating. A listener's own returned value wins (that is what makes a
   * wrapper a wrapper — `a(b(x))`, not `b(x)`); a listener that returns
   * `undefined` either passes the delegation's answer through, or, if it never
   * delegated, declines the request by ending the chain with `undefined`.
   *
   * `next(...args)` delegates — optionally with rewritten arguments, which is
   * how a plain transformer composes without re-implementing the chain:
   * `async (req, next) => next({ ...req, systemPrompt: hardened })`.
   *
   * Running OFF THE END of the chain yields the value in flight (the last
   * argument), not `undefined`. Without that rule a delegating transformer is a
   * silent no-op: `next(rewritten)` reaches the end, "nobody answered", the
   * caller's `?? original` puts the ORIGINAL back, and the rewrite vanishes with
   * no error — the exact failure the hook facade used to hide. An explicit
   * abstention still abstains: a listener that returns `undefined` WITHOUT
   * delegating ends the chain with `undefined` as before.
   */
  async waterfall<Result>(key: EventKey<never[], Result> | string, ...args: unknown[]): Promise<Result> {
    const list = this.listOf(key);
    const step = async (index: number, input: unknown[]): Promise<Result> => {
      const entry = list[index];
      if (entry === undefined) {
        // Value in flight is the trailing argument: `[req]` for llm/before,
        // `[call, result]` for tool/after.
        return (input.length === 0 ? undefined : input[input.length - 1]) as Result;
      }
      let delegation: Promise<Result> | undefined;
      // `next` is SPREAD, matching its declared type and every documented use
      // (`next({ ...req, systemPrompt })`): the arguments are the event's own
      // argument tuple, so no replacement and one replacement are both natural.
      // It used to read a single array argument while the type and the docs said
      // spread — so the documented call silently passed a bare object where an
      // array was expected, and every rewrite was dropped.
      const next = (...replacement: unknown[]): Promise<Result> =>
        (delegation ??= step(index + 1, replacement.length > 0 ? replacement : input));
      const out = (await entry.listener(...input, next as () => Promise<unknown>)) as Result;
      if (out !== undefined) return out;
      return delegation === undefined ? (undefined as Result) : await delegation;
    };
    return step(0, args);
  }

  /** Fan out: all listeners run concurrently; failures aggregate after all settle. */
  async parallel(key: EventKey<never[], unknown> | string, ...args: unknown[]): Promise<void> {
    const results = await Promise.allSettled(
      this.listOf(key).map((entry) => entry.listener(...args, noop)),
    );
    const failures = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => r.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `"${name(key)}" listeners failed`);
  }

  /** First non-empty answer wins, in order. */
  async serial<Result>(
    key: EventKey<never[], Result> | string,
    ...args: unknown[]
  ): Promise<Result | undefined> {
    for (const entry of this.listOf(key)) {
      const out = (await entry.listener(...args, noop)) as Result;
      if (isBailed(out)) return out;
    }
    return undefined;
  }

  /** `serial` for synchronous predicates — no awaiting, same first-wins rule. */
  bail<Result>(key: EventKey<never[], Result> | string, ...args: unknown[]): Result | undefined {
    for (const entry of this.listOf(key)) {
      const out = entry.listener(...args, noop) as Result;
      // A promise is always truthy, so an async listener would be returned as
      // the "decisive" answer — a silent wrong verdict. `bail` is sync-only.
      if (isThenable(out)) {
        throw new Error(`"${name(key)}" bail listener returned a promise; bail is synchronous-only`);
      }
      if (isBailed(out)) return out;
    }
    return undefined;
  }

  /** Registered names (diagnostics and tests). */
  names(): string[] {
    return [...this.entries.keys()];
  }
}

function noop(): Promise<never> {
  return Promise.resolve(undefined as never);
}

function name(key: EventKey<never[], unknown> | string): string {
  return typeof key === 'string' ? key : key.name;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}


/**
 * Convenience wrapper so callers can await a listener's result uniformly.
 * `[]` is admitted so a listener that rewrites nothing delegates as `next()`.
 */
export type Next<Args extends unknown[], Result> = (...replacement: Args | []) => Promise<Result>;
export type { Awaitable };
