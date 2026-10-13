/**
 * The context — what a plugin body receives. It is the only way a plugin
 * reaches a capability (a *service*, addressed by a typed key and declared
 * up front in `inject`) and the only way it registers one (as an effect, so
 * unloading takes it back automatically).
 *
 * Design notes worth keeping:
 *  - Services are addressed by key, not by property magic: `ctx.must(llm)` is
 *    greppable, typed, and fails with the plugin's own name in the message.
 *  - `inject` is a *requirement* list (see `satisfied()`); optional
 *    capabilities use `ctx.get(...)` instead, which keeps the boot check
 *    meaningful.
 *  - Nothing here knows about agents, tools or terminals. The agent loop is a
 *    plugin like any other; this file is the whole framework.
 */
import { EventRegistry, type EventKey, type Listener, type OnOptions, type Logger } from './events.js';
import { errMessage } from '../errors.js';
import { oneLineText } from '../text.js';
import { Fiber, type Runtime } from './fiber.js';
import { normalize, runReverse } from './effects.js';
import { ServiceStore, ServiceUnavailable, type InterceptMap, type ServiceInterceptor } from './store.js';
import {
  resolvePlugin,
  type AnyPlugin,
  type Dispose,
  type ServiceKey,
} from './types.js';

export interface ContextInit {
  runtime: Runtime;
  fiber?: Fiber | undefined;
  symbols: Record<string, symbol>;
  intercepts?: InterceptMap | undefined;
  root?: Context | undefined;
  entryId?: string | undefined;
}

export class Context {
  readonly root: Context;
  readonly runtime: Runtime;
  readonly fiber: Fiber | undefined;
  readonly symbols: Record<string, symbol>;
  /**
   * The interceptor chain this scope reads through. Inherited by prototype, so
   * the NEAREST scope that declares one for a name decides for its subtree.
   */
  readonly intercepts: InterceptMap | undefined;
  /**
   * Which plugin row owns this context, when one does.
   *
   * A plugin that installs or removes other rows names this as the parent, so
   * what it contributes lands under its own row (and under its own isolation)
   * rather than beside it at the root.
   */
  readonly entryId: string | undefined;

  private constructor(init: ContextInit) {
    this.runtime = init.runtime;
    this.fiber = init.fiber;
    this.symbols = init.symbols;
    this.intercepts = init.intercepts;
    this.root = init.root ?? this;
    this.entryId = init.entryId;
  }

  /** The top-level assembly context: no owning plugin, permanent registrations. */
  static createRoot(options?: { log?: Logger }): Context {
    const log = options?.log ?? defaultLog;
    const runtime: Runtime = {
      store: new ServiceStore(),
      events: new EventRegistry(log),
      log,
      fibers: new Set(),
    };
    const root = new Context({ runtime, symbols: {}, root: undefined });
    // A provider appearing or disappearing re-points whoever declared it.
    runtime.store.subscribe((name) => {
      // Snapshot the waiters: a reload can dispose fibers, and disposing
      // mutates the set this loop would otherwise be walking.
      const waiters = [...runtime.fibers].filter((fiber) => fiber.state !== 'disposed' && fiber.inject.includes(name));
      for (const fiber of waiters) {
        void fiber.refresh().catch((err: unknown) => {
          log('error', `plugin "${fiber.name}" failed to reload: ${errMessage(err)}`);
        });
      }
    });
    return root;
  }

  get log(): Logger {
    return this.runtime.log;
  }

  /** Read a service; undefined when no live provider supplies it. */
  get<T>(key: ServiceKey<T> | string): T | undefined {
    return this.runtime.store.read(this.symbols, nameOf(key), this.intercepts, this) as T | undefined;
  }

  /** Read a required service; a miss names both the service and the reader. */
  must<T>(key: ServiceKey<T> | string): T {
    const name = nameOf(key);
    const value = this.runtime.store.read(this.symbols, name, this.intercepts, this);
    if (value === undefined) {
      const who = this.fiber === undefined ? 'the assembly' : `plugin "${this.fiber.name}"`;
      throw new ServiceUnavailable(name, who);
    }
    return value as T;
  }

  /** Register a service for as long as the owning plugin lives. */
  provide<T>(key: ServiceKey<T> | string, value: T, check?: () => boolean): Dispose {
    const name = nameOf(key);
    const symbol = this.runtime.store.keyFor(this.symbols, name);
    return this.effect(() => {
      this.runtime.store.register(symbol, {
        name,
        value,
        fiber: this.fiber,
        check,
      });
      return () => this.runtime.store.unregister(symbol);
    }, `provide(${name})`);
  }

  /**
   * Run `body` now and keep its undo. Everything a plugin registers — tools,
   * commands, events, timers, service providers — goes through here.
   */
  effect(body: () => Dispose | readonly Dispose[] | undefined, label = 'effect'): Dispose {
    const fiber = this.fiber;
    if (fiber === undefined) {
      const disposers = normalize(body());
      return () => runReverse(disposers, this.reporter(label));
    }
    return fiber.addEffect(body, label);
  }

  /**
   * Report an undo that threw on the ROOT scope, where there is no plugin name
   * to blame and the label is all there is. Reported rather than raised for the
   * same reason a fiber's is: the remaining undos must still run, and the
   * failure must still be visible (see `effects.ts`).
   */
  private reporter(label: string): (error: unknown) => void {
    return (error) => {
      this.runtime.log('warn', `assembly effect "${label}" failed to undo: ${errMessage(error)}`);
    };
  }

  /**
   * Load a plugin. Returns its fiber; a body that awaits nothing has already
   * activated, and `fiber.ready` settles the attempt either way (rejecting
   * with the plugin's own error).
   *
   * `entryId` names the ROW this plugin belongs to when a loader is creating
   * one, so the plugin can address its own row (install sub-rows under it,
   * read its own settings) without the host passing a handle around.
   */
  plugin<T>(plugin: AnyPlugin | AnyPlugin[], config?: T, name?: string, entryId?: string): Fiber {
    // A single-element array is admitted as a convenience; anything else is a
    // caller mistake and is REFUSED, because the old behaviour — silently
    // loading only the head — is the exact defect shape this kernel refuses
    // elsewhere: members beyond the first would vanish with no error anywhere.
    if (Array.isArray(plugin)) {
      if (plugin.length !== 1) {
        throw new Error(
          `ctx.plugin() takes one plugin, got an array of ${String(plugin.length)} — load each row separately`,
        );
      }
      plugin = plugin[0] as AnyPlugin;
    }
    const resolved = resolvePlugin(plugin as AnyPlugin, name ?? 'anonymous');
    const fiber = new Fiber(
      this.runtime,
      resolved,
      this.symbols,
      this.fiber,
      (f) => new Context({
        runtime: this.runtime,
        fiber: f,
        symbols: this.symbols,
        intercepts: this.intercepts,
        root: this.root,
        entryId,
      }),
      config ?? {},
    );
    fiber.start();
    return fiber;
  }

  /** Subscribe to an event for as long as the owning plugin lives. */
  on<Args extends unknown[], Result>(
    key: EventKey<Args, Result> | string,
    listener: Listener<Args, Result>,
    opts?: OnOptions,
  ): Dispose {
    return this.effect(
      () => this.runtime.events.on(key as never, listener as never, opts),
      `on(${nameOf(key)})`,
    );
  }

  emit<Args extends unknown[]>(key: EventKey<Args, void> | string, ...args: Args): void {
    this.runtime.events.emit(key as never, ...args);
  }

  waterfall<Result>(key: EventKey<unknown[], Result> | string, ...args: unknown[]): Promise<Result> {
    return this.runtime.events.waterfall(key as never, ...args) as Promise<Result>;
  }

  parallel(key: EventKey<unknown[], void> | string, ...args: unknown[]): Promise<void> {
    return this.runtime.events.parallel(key as never, ...args);
  }

  serial<Result>(
    key: EventKey<unknown[], Result> | string,
    ...args: unknown[]
  ): Promise<Result | undefined> {
    return this.runtime.events.serial(key as never, ...args) as Promise<Result | undefined>;
  }

  bail<Result>(key: EventKey<unknown[], Result> | string, ...args: unknown[]): Result | undefined {
    return this.runtime.events.bail(key as never, ...args) as Result | undefined;
  }

  /** A child scope where `name` resolves to its own provider (per-agent trees). */
  isolate(name: string): Context {
    const symbols: Record<string, symbol> = Object.create(this.symbols);
    symbols[name] = Symbol(name);
    return new Context({
      runtime: this.runtime,
      fiber: this.fiber,
      symbols,
      intercepts: this.intercepts,
      root: this.root,
      entryId: this.entryId,
    });
  }

  /**
   * A child scope that reads a DIFFERENT set of implementations.
   *
   * This is the mechanism behind a plugin row that isolates or wraps services:
   * `isolate` gives the name a fresh key (so the subtree's provider is private
   * to it and replaces what callers see), and `intercept` wraps whatever the
   * name otherwise resolves to (so the subtree reads through the plugin's own
   * code). Both are inherited by prototype, so a nested row can refine its
   * parent's choice rather than restating it.
   * @param options - the names to fork and the wrappers to install.
   * @returns the child scope.
   */
  scope(options: {
    isolate?: readonly string[] | undefined;
    intercept?: Readonly<Record<string, ServiceInterceptor>> | undefined;
  }): Context {
    const symbols: Record<string, symbol> = Object.create(this.symbols);
    for (const name of options.isolate ?? []) symbols[name] = Symbol(`${name}#${this.entryId ?? 'scope'}`);
    const intercepts: InterceptMap = Object.create(this.intercepts ?? null) as InterceptMap;
    for (const [name, wrap] of Object.entries(options.intercept ?? {})) intercepts[name] = wrap;
    return new Context({
      runtime: this.runtime,
      fiber: this.fiber,
      symbols,
      intercepts: Object.keys(intercepts).length > 0 ? intercepts : undefined,
      root: this.root,
      entryId: this.entryId,
    });
  }

  /**
   * This same scope, labelled with the row it serves.
   *
   * The loader stamps a row's context so the plugin can address its own row —
   * install sub-rows under it, read its own settings — without being handed a
   * handle. Nothing about resolution changes.
   * @param id - the owning row's id.
   * @returns a context identical to this one, reporting `id` as its row.
   */
  labelled(id: string): Context {
    return new Context({
      runtime: this.runtime,
      fiber: this.fiber,
      symbols: this.symbols,
      intercepts: this.intercepts,
      root: this.root,
      entryId: id,
    });
  }

  /** Declared services that no live provider supplies — the boot check. */
  unsatisfied(): string[] {
    const missing = new Set<string>();
    for (const fiber of this.runtime.fibers) {
      if (fiber.state === 'disposed') continue;
      for (const name of fiber.inject) {
        if (this.runtime.store.resolve(this.symbols, name) === undefined) missing.add(name);
      }
    }
    return [...missing];
  }

  /** Every live plugin, for diagnostics. */
  roster(): { name: string; state: string; inject: readonly string[] }[] {
    return [...this.runtime.fibers].map((fiber) => ({
      name: fiber.name,
      state: fiber.state,
      inject: fiber.inject,
    }));
  }
}

function nameOf(key: ServiceKey<unknown> | string): string {
  return typeof key === 'string' ? key : key.name;
}

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

/**
 * The core log exit — the ONE place a core log line becomes stderr bytes.
 *
 * The escaping happens HERE, at the exit, not at each call site. `message` is
 * routinely built out of external data: `loader.ts` writes
 * `plugin "<id>" failed to load: <the plugin's own thrown message>`, `events.ts`
 * writes a throwing listener's message, and neither the row id nor that text is
 * the host's to trust. A per-call-site rule is a rule every future call site has
 * to remember, and the sibling path in cli (its startup report) already states
 * the discipline that the upstream is never assumed clean; one exit makes
 * "nothing core prints can rewrite the terminal" a property of the writer
 * instead of a habit.
 *
 * The cost is chosen knowingly: redirected to a FILE — or read by a test — the
 * bytes are now the visible sequence `\x1b` rather than the raw control
 * character. That is the point, not a regression: a log line is displayed by
 * tools and terminals that must not be rewritten by the text they carry, and
 * `\x1b[31m` in a log tells a human exactly what was there (dropping it would
 * hide an injection attempt). Only `message` is escaped — the `[nova:<level>] `
 * prefix is this file's own literal.
 */
const defaultLog: Logger = (level, message) => {
  const threshold = process.env.NOA_LOG === undefined ? LEVELS.warn : thresholdFor(process.env.NOA_LOG);
  if (LEVELS[level] < threshold) return;
  process.stderr.write(`[nova:${level}] ${oneLineText(message)}\n`);
};

function thresholdFor(setting: string): number {
  const level = setting === '1' ? 'info' : setting;
  return level in LEVELS ? LEVELS[level as keyof typeof LEVELS] : LEVELS.warn;
}
