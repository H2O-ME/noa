/**
 * Fibers — one live plugin instance and everything it registered.
 *
 * A fiber is the unit of activation and teardown. Every registration a plugin
 * makes goes through `ctx.effect(...)`, so unloading is correct by
 * construction rather than by discipline: there is no registry a plugin can
 * forget to clean up. Reloading is driven by the *identity of the providers*
 * a plugin declared in `inject`, so replacing a backend re-points its
 * dependents instead of stranding them on a dead reference.
 *
 * A fiber is deliberately **not** a thenable: awaiting a fiber would have to
 * resolve with the fiber itself, and a thenable that resolves with itself
 * recurses forever instead of settling. Activation is awaited through
 * `fiber.ready`, and the synchronous case (the usual one — a plugin body that
 * returns nothing) is already settled by the time `ctx.plugin()` returns.
 */
import type { Context } from './context.js';
import type { Logger } from './events.js';
import type { ServiceStore } from './store.js';
import type { Dispose, ResolvedPlugin } from './types.js';
import { errMessage } from '../errors.js';
import { normalize, runReverse } from './effects.js';

export type FiberState = 'pending' | 'loading' | 'active' | 'failed' | 'disposed';

/** What every fiber reaches back into: the shared store, events and log. */
export interface Runtime {
  readonly store: ServiceStore;
  readonly events: import('./events.js').EventRegistry;
  readonly log: Logger;
  /** Every live fiber — the roster the store notifies on provider churn. */
  readonly fibers: Set<Fiber>;
}

type ContextFactory = (fiber: Fiber) => Context;

interface EffectRecord {
  label: string;
  dispose: () => Promise<void>;
}

let nextUid = 1;

export class Fiber {
  readonly uid = nextUid++;
  readonly ctx: Context;
  readonly children = new Set<Fiber>();
  state: FiberState = 'pending';
  error: unknown;
  /** The validated config handed to the plugin body. */
  config: unknown;
  /** Settles with the current activation attempt; already settled when sync. */
  ready: Promise<void> = Promise.resolve();
  /**
   * Installed by the loader: reports every SETTLED activation (`undefined`
   * clears, a message reports) so a reload that fails at RUNTIME lands on the
   * roster row the panel reads. Without it a plugin that only breaks on a
   * provider swap keeps showing as healthy.
   */
  onSettled: ((error: string | undefined) => void) | undefined;

  private readonly effects: EffectRecord[] = [];
  private epoch: string | undefined;
  /** Serializes activations: one teardown+load at a time, per fiber. */
  private tail: Promise<void> | undefined;
  /** Monotonic attempt id; a superseded attempt must not commit its outcome. */
  private attempt = 0;

  constructor(
    readonly runtime: Runtime,
    readonly resolved: ResolvedPlugin,
    readonly symbols: Record<string, symbol>,
    readonly parent: Fiber | undefined,
    makeContext: ContextFactory,
    private readonly raw: unknown = {},
  ) {
    this.ctx = makeContext(this);
    this.parent?.children.add(this);
    runtime.fibers.add(this);
  }

  get name(): string {
    return this.resolved.name;
  }

  /** Services this plugin declared as required. */
  get inject(): readonly string[] {
    return this.resolved.inject;
  }

  /** Register a disposable: `body()` runs now and returns its own undo. */
  addEffect(body: () => Dispose | readonly Dispose[] | undefined, label: string): Dispose {
    if (this.state === 'disposed') {
      throw new Error(`plugin "${this.name}" tried to register "${label}" while disposed`);
    }
    const disposers = normalize(body());
    const report = this.reporter(label);
    const record: EffectRecord = { label, dispose: () => runReverse(disposers, report) };
    this.effects.push(record);
    return () => {
      const index = this.effects.indexOf(record);
      if (index >= 0) this.effects.splice(index, 1);
      return runReverse(disposers, report);
    };
  }

  /**
   * Report an undo that threw, naming the plugin and the registration.
   *
   * A teardown failure is reported rather than raised: it must not stop the
   * remaining undos or fail the unload that triggered it, but it also must not
   * disappear — see `effects.ts`.
   */
  private reporter(label: string): (error: unknown) => void {
    return (error) => {
      this.runtime.log('warn', `plugin "${this.name}" failed to undo ${label}: ${errMessage(error)}`);
    };
  }

  /**
   * Activate now (synchronously when the plugin body does not await anything)
   * and remember the attempt. `ready` is the awaitable form.
   */
  start(): Promise<void> {
    return this.refresh();
  }

  /**
   * Bring the fiber up — or back up after a provider swap.
   *
   * Activations are SERIALIZED per fiber and carry an attempt id: provider churn
   * can request a reload while an earlier one is still tearing down or running,
   * and without both properties the second request tears down alongside the first
   * (double teardown) and then applies a second time (double registration), with
   * whichever finished last silently winning.
   *
   * A missing declared service does not silently skip the plugin: the body still
   * runs, and the first access to the absent service raises a named error, so a
   * mis-wired roster fails at boot instead of at the first tool call.
   */
  refresh(): Promise<void> {
    if (this.state === 'disposed') return this.ready;
    const epoch = this.currentEpoch();
    if (this.state === 'active' && epoch === this.epoch) return Promise.resolve();
    return this.enqueue(epoch);
  }

  /** Chain one activation behind the previous; the newest attempt supersedes. */
  private enqueue(epoch: string): Promise<void> {
    const id = ++this.attempt;
    const previous = this.tail;
    const start = (): Promise<void> | undefined => this.step(epoch, id);
    const outcome = previous === undefined ? start() : previous.then(start, start);
    if (outcome === undefined) {
      // Completed inline (a synchronous body): the chain stays idle, so the next
      // activation in this tick is inline too — a `.then()` hop would defer every
      // activation by a microtask and break the synchronous contract above.
      this.ready = Promise.resolve();
      return this.ready;
    }
    this.tail = outcome;
    this.ready = outcome;
    const clear = (): void => {
      if (this.tail === outcome) this.tail = undefined;
    };
    outcome.then(clear, clear);
    outcome.catch(noop);
    return outcome;
  }

  /**
   * Reconcile the fiber to `epoch`, or return `undefined` when it already
   * finished synchronously (the common case: a body that awaits nothing).
   */
  private step(epoch: string, id: number): Promise<void> | undefined {
    // Disposed, or superseded while queued: the newer attempt owns the outcome.
    if (this.state === 'disposed' || id !== this.attempt) return undefined;
    if (this.state === 'active' && epoch === this.epoch) return undefined;
    if (this.state === 'pending' || this.state === 'failed') {
      // Nothing live to tear down: a failed activation already unwound itself, so
      // this stays synchronous — the retry the caller triggers must be visible by
      // the time `refresh()` returns (a `.then()` hop would defer it a microtask).
      const run = this.load(epoch, id);
      return this.settled ? undefined : run;
    }
    return this.teardown().then(() => {
      if (!this.live || id !== this.attempt) return;
      return this.load(epoch, id);
    });
  }

  /** Read fresh (a `state` narrowed before an `await` may be stale after it). */
  private get live(): boolean {
    return this.state !== 'disposed';
  }

  /** True once an activation committed or failed — read past any narrowing. */
  private get settled(): boolean {
    return this.state === 'active' || this.state === 'failed';
  }

  /** Dispose every registration, newest first. Children go first. */
  async teardown(): Promise<void> {
    for (const child of [...this.children].reverse()) await child.dispose();
    this.children.clear();
    // Each record's own undo already reports its own failure, so this report is
    // the backstop for the day that stops being true.
    await runReverse(
      this.effects.map((record) => record.dispose),
      (error) => this.runtime.log('warn', `plugin "${this.name}" teardown failed: ${errMessage(error)}`),
    );
    this.effects.length = 0;
    this.epoch = undefined;
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    // Supersede any in-flight activation, so its `finish` cannot resurrect us.
    this.attempt++;
    await this.teardown();
    this.parent?.children.delete(this);
    this.runtime.fibers.delete(this);
  }

  /**
   * Run the plugin body. Synchronous bodies (the common case) leave the fiber
   * `active` before this returns; only an async config schema or an async body
   * defers to a promise.
   */
  private load(epoch: string, id: number): Promise<void> {
    this.state = 'loading';
    const schema = this.resolved.config?.['~standard'];
    if (schema === undefined) return this.runBody(epoch, id, this.raw);
    let outcome: unknown;
    try {
      outcome = schema.validate(this.raw);
    } catch (err) {
      return this.fail(err, id);
    }
    if (isThenable(outcome)) {
      return Promise.resolve(outcome).then(
        (settled) => this.runBody(epoch, id, checked(this.name, settled)),
        (err: unknown) => this.fail(err, id),
      );
    }
    let config: unknown;
    try {
      config = checked(this.name, outcome);
    } catch (err) {
      return this.fail(err, id);
    }
    return this.runBody(epoch, id, config);
  }

  private runBody(epoch: string, id: number, config: unknown): Promise<void> {
    try {
      const result = this.resolved.run(this.ctx, config);
      if (isThenable(result)) {
        return Promise.resolve(result).then(
          () => {
            this.finish(epoch, id, config);
          },
          (err: unknown) => this.fail(err, id),
        );
      }
    } catch (err) {
      return this.fail(err, id);
    }
    this.finish(epoch, id, config);
    return Promise.resolve();
  }

  private finish(epoch: string, id: number, config?: unknown): void {
    // Disposed or superseded — the newer attempt owns the outcome.
    if (this.state === 'disposed' || id !== this.attempt) return;
    this.config = config;
    this.epoch = epoch;
    this.error = undefined;
    this.state = 'active';
    this.onSettled?.(undefined);
  }

  /**
   * Undo whatever half-registered before the failure — a failed plugin must
   * leave no trace, since a partially registered tool set is worse than none.
   */
  private fail(err: unknown, id: number): Promise<never> {
    const current = id === this.attempt && this.state !== 'disposed';
    if (current) this.error = err;
    const settle = (): void => {
      if (!current) return;
      this.state = 'failed';
      this.onSettled?.(errMessage(err));
    };
    return this.teardown().then(
      () => {
        settle();
        throw err;
      },
      () => {
        settle();
        throw err;
      },
    );
  }

  /** The provider-identity fingerprint used to notice a backend swap. */
  private currentEpoch(): string {
    return this.inject
      .map((name) => {
        const impl = this.runtime.store.providerOf(this.symbols, name);
        return `${name}@${impl?.fiber?.uid ?? 0}`;
      })
      .join('|');
  }
}

function checked(name: string, outcome: unknown): unknown {
  const result = outcome as { value?: unknown; issues?: { message: string }[] };
  if (result.issues !== undefined && result.issues.length > 0) {
    const detail = result.issues.map((issue) => issue.message).join('; ');
    throw new Error(`invalid config for plugin "${name}": ${detail}`);
  }
  return result.value;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}

function noop(): void {}