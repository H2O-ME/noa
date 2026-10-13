/**
 * Spawn-only PTC worker entry. DELIBERATELY SELF-CONTAINED (node builtins
 * only, erasable TypeScript): in the source world Node loads this file
 * directly through native type stripping, and in the built world tsdown
 * bundles it standalone to `worker.mjs` — no shared module graph either way.
 *
 * It runs the host-type-stripped program body as a strict async function,
 * exposes declared binding namespaces as null-prototype globals (so `__proto__`
 * or `toString` tool names are ordinary keys, never prototype collisions),
 * injects the declared rejection class, captures console + stream writes into
 * a byte-capped ordered log, and posts exactly one terminal `done` message.
 * The host re-validates everything it receives: the peer runs model code.
 */

import { inspect } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';

// ---------------------------------------------------------------- wire types

interface ErrorClassDecl {
  name: string;
  memberNameProperty: string;
}
interface NamespaceDecl {
  global: string;
  names: string[];
  errorClass?: ErrorClassDecl;
}
interface BootData {
  code: string;
  namespaces: NamespaceDecl[];
  maxOutputBytes: number;
}
type DoneFailure = { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string };
type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; value: unknown }
  | { type: 'reply'; id: number; ok: false; message: string };

if (!parentPort) throw new Error('nova ptc worker loaded outside a worker thread');
const port = parentPort;
const boot = workerData as BootData;

// -------------------------------------------------------- lossless JSON gate

function snapshotJson(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value as number) ? value : undefined;
  if (kind !== 'object') return undefined;
  const obj = value as object;
  if (seen.has(obj) || depth <= 0) return undefined;
  seen.add(obj);
  if (Array.isArray(obj)) {
    const out: unknown[] = [];
    for (const item of obj) {
      const snapped = snapshotJson(item, depth - 1, seen);
      if (snapped === undefined) return undefined;
      out.push(snapped);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(obj)) {
    const snapped = snapshotJson(item, depth - 1, seen);
    if (snapped === undefined) return undefined;
    // Same `__proto__` contract as ptc/json.ts: keep it an own enumerable
    // property instead of silently re-pointing the prototype.
    if (key === '__proto__') {
      Object.defineProperty(out, key, { enumerable: true, writable: true, configurable: true, value: snapped });
    } else {
      out[key] = snapped;
    }
  }
  return out;
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

// ------------------------------------------------------------------ log path

/**
 * Ordered byte-capped capture charged with the exact JSON-log-array cost. On
 * overflow it emits the fitting prefix, reports the limit once, and drops the
 * rest — the host turns that into an explicit `output-limit` run failure.
 */
class LogBuffer {
  private bytes = 2; // "[]"
  private entries = 0;
  private truncated = false;
  private readonly sink: (text: string) => void;
  private readonly onLimit: () => void;
  readonly maxBytes: number;

  constructor(maxBytes: number, sink: (text: string) => void, onLimit: () => void) {
    this.maxBytes = maxBytes;
    this.sink = sink;
    this.onLimit = onLimit;
  }

  push(text: string): void {
    if (this.truncated) return;
    const separator = this.entries > 0 ? 1 : 0;
    const cost = jsonBytes(text) + separator;
    if (this.bytes + cost <= this.maxBytes) {
      this.bytes += cost;
      this.entries += 1;
      this.sink(text);
      return;
    }
    this.truncated = true;
    this.onLimit();
  }

  remaining(): number {
    return this.maxBytes - this.bytes;
  }
}

const logs = new LogBuffer(
  boot.maxOutputBytes,
  (text) => port.postMessage({ type: 'log', text }),
  () => port.postMessage({ type: 'output-limit' }),
);

const INSPECT_OPTIONS = { depth: 4, maxArrayLength: 100, maxStringLength: 10_000 } as const;

const consoleShim = Object.create(null) as Record<string, (...args: unknown[]) => void>;
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  consoleShim[level] = (...args: unknown[]): void => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg, INSPECT_OPTIONS))).join(' '));
  };
}

/** Route a stream's JS-level writes into the ordered buffer alongside console output. */
function captureStreamWrites(stream: { write(chunk: unknown, ...rest: unknown[]): boolean }): void {
  stream.write = (chunk: unknown): boolean => {
    logs.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  };
}
captureStreamWrites(process.stdout);
captureStreamWrites(process.stderr);

// ---------------------------------------------------------------- bindings

const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 1;

interface BindingErrorCtor {
  new (memberName: string, message: string): Error;
}

function makeErrorClass(decl: ErrorClassDecl): BindingErrorCtor {
  return class BindingCallError extends Error {
    constructor(memberName: string, message: string) {
      super(message);
      Object.defineProperty(this, 'name', { enumerable: true, value: decl.name });
      Object.defineProperty(this, decl.memberNameProperty, { enumerable: true, value: memberName });
    }
  };
}

const errorClasses = new Map<string, BindingErrorCtor>();
for (const namespace of boot.namespaces) {
  if (namespace.errorClass !== undefined) {
    errorClasses.set(namespace.global, makeErrorClass(namespace.errorClass));
  }
}

function bindingFailure(namespace: NamespaceDecl, memberName: string, message: string): Error {
  const ctor = errorClasses.get(namespace.global);
  return ctor !== undefined ? new ctor(memberName, message) : new Error(message);
}

const namespaces = boot.namespaces.map((namespace) => {
  const object = Object.create(null) as Record<string, (args: unknown) => Promise<unknown>>;
  for (const name of namespace.names) {
    Object.defineProperty(object, name, {
      enumerable: true,
      value: (args: unknown): Promise<unknown> => {
        const detached = snapshotJson(args, 64, new WeakSet());
        if (detached === undefined) {
          return Promise.reject(bindingFailure(namespace, name, 'tool arguments must be lossless JSON'));
        }
        return new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, {
            resolve,
            reject: (error: Error) => reject(bindingFailure(namespace, name, error.message)),
          });
          try {
            port.postMessage({ type: 'call', id, global: namespace.global, name, args });
          } catch (error: unknown) {
            pending.delete(id);
            reject(
              bindingFailure(
                namespace,
                name,
                `binding arguments must be structured-cloneable: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        });
      },
    });
  }
  return object;
});

port.on('message', (message: ReplyMessage) => {
  if (typeof message !== 'object' || message === null || message.type !== 'reply') return;
  const entry = pending.get(message.id);
  if (entry === undefined) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new Error(message.message));
});

// --------------------------------------------------------------------- main

function prepareDone(value: unknown): { value?: unknown; error?: DoneFailure } {
  if (value === undefined) return {};
  const snapshot = snapshotJson(value, 64, new WeakSet());
  if (snapshot === undefined) {
    return { error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } };
  }
  if (jsonBytes(snapshot) > logs.remaining()) {
    return { error: { kind: 'output-limit', message: `outer output exceeded ${boot.maxOutputBytes} bytes` } };
  }
  return { value: snapshot };
}

function prepareException(error: unknown): { error: DoneFailure } {
  let message: string;
  try {
    const detail = error instanceof Error ? (error.stack ?? error.message) : error;
    message = typeof detail === 'string' ? detail : String(detail);
  } catch {
    message = 'program threw an unrenderable value';
  }
  if (jsonBytes(message) > logs.remaining()) {
    return { error: { kind: 'output-limit', message: `outer output exceeded ${boot.maxOutputBytes} bytes` } };
  }
  return { error: { kind: 'exception', message } };
}

const AsyncFunction = (async () => undefined).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<unknown>;

const errorClassGlobals: unknown[] = [];
for (const namespace of boot.namespaces) {
  if (namespace.errorClass === undefined) continue;
  const ctor = errorClasses.get(namespace.global);
  if (ctor !== undefined) errorClassGlobals.push(ctor);
}

try {
  const fn = new AsyncFunction(
    ...boot.namespaces.map((namespace) => namespace.global),
    ...boot.namespaces.filter((namespace) => namespace.errorClass !== undefined).map((namespace) => namespace.errorClass!.name),
    'console',
    `'use strict';\n${boot.code}`,
  );
  const value = await fn(...namespaces, ...errorClassGlobals, consoleShim);
  port.postMessage({ type: 'done', ...prepareDone(value) });
} catch (error: unknown) {
  port.postMessage({ type: 'done', ...prepareException(error) });
}
