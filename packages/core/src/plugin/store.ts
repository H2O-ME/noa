/**
 * Service registry — one map of live implementations, keyed by a symbol that
 * scope isolation can fork. Registration and removal both notify the fibers
 * that declared the name, which is what turns "swap the provider" into
 * "dependents reload" without any boot-order bookkeeping.
 *
 * ## Interception
 *
 * A scope may also WRAP a service instead of replacing it: the nearest scope
 * that declares an interceptor for a name decides what its subtree reads, and
 * the interceptor receives the value it is wrapping. Replacement (`isolate`)
 * and wrapping (`intercept`) are the two halves of one power — a plugin can
 * substitute another plugin's implementation, or sit in front of it and change
 * what callers see. There is no privileged list of "interceptable" services:
 * every key in the store can be wrapped, tools and the agent loop's own seams
 * included, because they are ordinary services.
 */
import type { Fiber } from './fiber.js';

export interface ServiceImpl {
  name: string;
  value: unknown;
  /** The fiber that provided it; undefined for values registered by the root. */
  fiber: Fiber | undefined;
  /** Availability predicate: a false/throwing check reads as "not ready". */
  check: (() => boolean) | undefined;
  /**
   * Memoized wrappers, keyed by the interceptor function.
   *
   * The interceptor object belongs to a scope and is stable for that scope's
   * lifetime, so a consumer that resolved a wrapped service keeps the SAME
   * object across reads. Rebuilding one per read would break the identity
   * comparisons plenty of callers legitimately make.
   */
  wrapped?: Map<unknown, unknown>;
}

/**
 * Wraps one service for the scope that declared it.
 *
 * `inner` is what the scope would otherwise read (the parent's implementation,
 * or another interceptor further out), and the reading context is passed so a
 * wrapper can read other services — the usual reason to wrap one is to consult
 * another.
 */
export type ServiceInterceptor = (inner: unknown, ctx: unknown) => unknown;

/** The interceptor map a scope inherits and may override. */
export type InterceptMap = Record<string, ServiceInterceptor>;

export class ServiceStore {
  private readonly impls = new Map<symbol, ServiceImpl>();
  /** Root symbol per service name (the key used when no scope isolates it). */
  private readonly globals = new Map<string, symbol>();
  private readonly listeners = new Set<(name: string) => void>();

  /** The store key for `name` in a given isolate scope. */
  keyFor(symbols: Record<string, symbol>, name: string): symbol {
    const isolated = symbols[name];
    if (isolated !== undefined) return isolated;
    let global = this.globals.get(name);
    if (global === undefined) {
      global = Symbol(name);
      this.globals.set(name, global);
    }
    return global;
  }

  register(key: symbol, impl: ServiceImpl): void {
    const existing = this.impls.get(key);
    if (existing !== undefined) {
      throw new Error(
        `service "${impl.name}" is already provided by ${describe(existing.fiber)}`,
      );
    }
    this.impls.set(key, impl);
    this.notify(impl.name);
  }

  unregister(key: symbol): void {
    const impl = this.impls.get(key);
    if (impl === undefined) return;
    this.impls.delete(key);
    this.notify(impl.name);
  }

  /** The live implementation, or undefined when absent or not available. */
  resolve(symbols: Record<string, symbol>, name: string): ServiceImpl | undefined {
    const impl = this.impls.get(this.keyFor(symbols, name));
    if (impl === undefined) return undefined;
    if (impl.check !== undefined) {
      try {
        if (!impl.check()) return undefined;
      } catch {
        return undefined;
      }
    }
    return impl;
  }

  /**
   * The value a scope actually reads: the implementation, wrapped by the nearest
   * interceptor its chain declares for that name.
   *
   * A wrapper that throws is not a service outage — the caller gets the
   * unwrapped implementation rather than a hole where a capability used to be.
   * A plugin that breaks an API it chose to wrap must not take that API away
   * from everyone else.
   * @param symbols - the reading scope's symbol map.
   * @param name - the service name.
   * @param intercepts - the reading scope's interceptor chain, when it has one.
   * @param ctx - the reading context, handed to the interceptor.
   * @returns the resolved value, or undefined when no provider supplies it.
   */
  read(
    symbols: Record<string, symbol>,
    name: string,
    intercepts: InterceptMap | undefined,
    ctx: unknown,
  ): unknown {
    const impl = this.resolve(symbols, name);
    if (impl === undefined) return undefined;
    const wrap = intercepts?.[name];
    if (wrap === undefined) return impl.value;
    const memo = (impl.wrapped ??= new Map<unknown, unknown>());
    if (memo.has(wrap)) return memo.get(wrap);
    let value: unknown;
    try {
      value = wrap(impl.value, ctx);
    } catch {
      value = impl.value;
    }
    memo.set(wrap, value);
    return value;
  }

  /** Provider identity for one name — the epoch component of dependents. */
  providerOf(symbols: Record<string, symbol>, name: string): ServiceImpl | undefined {
    return this.impls.get(this.keyFor(symbols, name));
  }

  /** Subscribe to register/unregister churn (dependents refresh through this). */
  subscribe(listener: (name: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(name: string): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(name);
      } catch {
        // A broken dependent must not stop the others from refreshing.
      }
    }
  }
}

function describe(fiber: Fiber | undefined): string {
  return fiber === undefined ? 'the root scope' : `plugin "${fiber.name}"`;
}

/** Raised when a plugin reads a service that no live provider supplies. */
export class ServiceUnavailable extends Error {
  constructor(
    readonly service: string,
    readonly requester?: string,
  ) {
    super(
      `service "${service}" is not available — no provider is loaded` +
        (requester === undefined ? '' : ` (required by ${requester})`),
    );
    this.name = 'ServiceUnavailable';
  }
}
