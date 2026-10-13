/**
 * The worker-thread code runtime (dsh `code-runtime-worker-thread` simplified):
 * each run spawns a FRESH `node:worker_threads` Worker over the host-side
 * type-stripped program, with an empty environment, a heap cap, a measured
 * busy-time (event-loop utilization) budget plus a wall-clock ceiling, an
 * outer-output byte cap, and hard termination — a hot synchronous loop cannot
 * outrun it. Bindings bridge over the message port; the port peer runs MODEL
 * CODE, so every inbound message is shape-gated and rebuilt field by field.
 *
 * This is containment, not a security boundary: like the bash tool it can
 * reach Node APIs, which is why run_code shares the bash approval gate.
 * No pooling and no cross-run state — the program's world dies with its
 * worker, keeping every run reconstructable from the log alone.
 */

import { errMessage } from '@noa/core';
import { typeStrippingAvailable } from '@noa/core';
import nodeModule from 'node:module';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { jsonByteLength, snapshotJson } from './json.js';
import type { JsonValue } from './json.js';

/** Failure taxonomy — orthogonal outcomes reported independently (dsh seam). */
export type CodeRunFailureKind =
  | 'exception'
  | 'timeout'
  | 'abort'
  | 'worker-exit'
  | 'invalid-output'
  | 'output-limit';

export interface CodeRunFailure {
  kind: CodeRunFailureKind;
  /** Human-readable detail, suitable for feeding back to a model to self-correct. */
  message: string;
}

/** A failed program is a FIELD on a resolved result, never a rejection of runCode. */
export interface CodeRunResult {
  /** The program's top-level `return`, when it completed with a lossless-JSON value. */
  value?: JsonValue;
  /** Text the program emitted (console.log etc.), in order. */
  logs: string[];
  error?: CodeRunFailure;
}

/** One host function exposed to the program; args and result must be lossless JSON. */
export type CodeBindingFunction = (args: unknown) => Promise<JsonValue>;

export interface CodeBindingErrorClass {
  /** Constructor global injected into the program, e.g. `ToolCallError`. */
  name: string;
  /** Property carrying the rejected member's name, e.g. `toolName`. */
  memberNameProperty: string;
}

export interface CodeBindingNamespace {
  /** Program-visible global identifier, `[A-Za-z_][A-Za-z0-9_]*`, e.g. `tools`. */
  global: string;
  /** Callable members keyed by exact name; `__proto__` etc. must stay ordinary keys. */
  functions: Record<string, CodeBindingFunction>;
  /** Program-visible typed rejection for failed binding calls. */
  errorClass?: CodeBindingErrorClass;
}

export interface CodeRunRequest {
  /** Body of an async function, erasable TypeScript (top-level `await`/`return`). */
  program: string;
  bindings: CodeBindingNamespace[];
  signal?: AbortSignal;
  /** Live stream of admitted log lines, as they cross the port. */
  onLog?: (text: string) => void;
}

export interface CodeRuntimeConfig {
  computeMs: number;
  maxWallMs: number;
  maxOutputBytes: number;
  maxOldGenerationSizeMb: number;
}

export const DEFAULT_CODE_RUNTIME_CONFIG: CodeRuntimeConfig = {
  computeMs: 60_000,
  maxWallMs: 600_000,
  maxOutputBytes: 1_048_576,
  maxOldGenerationSizeMb: 512,
};

/** setTimeout clamps delays above this to 1ms — a longer ceiling would time out instantly. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How often the host samples the worker's busy time for the computeMs budget. */
const ELU_POLL_INTERVAL_MS = 25;

/** The stripping handle; availability itself is `typeStrippingAvailable` — the ONE predicate every type-stripping seam shares. */
const stripTypes = (
  nodeModule as {
    stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string;
  }
).stripTypeScriptTypes;

/** Merge overrides and validate positivity caps up front — misconfiguration fails loud. */
export function resolveCodeRuntimeConfig(overrides?: Partial<CodeRuntimeConfig>): CodeRuntimeConfig {
  const merged: CodeRuntimeConfig = { ...DEFAULT_CODE_RUNTIME_CONFIG, ...stripUndefined(overrides) };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`code runtime config ${key} must be a positive number, got ${String(value)}`);
    }
  }
  if (merged.maxWallMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`code runtime config maxWallMs must be at most ${MAX_TIMER_DELAY_MS} (Node clamps longer setTimeout delays to 1ms)`);
  }
  if (!Number.isSafeInteger(merged.maxOutputBytes) || merged.maxOutputBytes < 128) {
    throw new Error(`code runtime config maxOutputBytes must be a safe integer of at least 128, got ${String(merged.maxOutputBytes)}`);
  }
  return merged;
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (value === undefined) return out;
  for (const [key, entry] of Object.entries(value) as [keyof T, T[keyof T]][]) {
    if (entry !== undefined) out[key] = entry;
  }
  return out;
}

/**
 * The wrapper a program is type-stripped inside: the grammatical context it
 * really executes in (an async function body, where top-level `return`/`await`
 * are legal). Strip mode is position-preserving, so the wrapper survives
 * byte-identical and the body slices back out with the model's own line/column
 * positions intact.
 */
const STRIP_WRAP = { prefix: 'async function __nova_program__() {\n', suffix: '\n}' } as const;

/**
 * The worker entry path: source world (vitest/tsx) loads `worker.ts` directly
 * through Node's native type stripping (the file is self-contained and
 * erasable-only); the built package ships the sibling `worker.mjs` bundle.
 */
const WORKER_PATH = fileURLToPath(
  new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? './worker.ts' : './worker.mjs', import.meta.url),
);

function messageOf(error: unknown): string {
  return errMessage(error);
}

// ---------------------------------------------------------------- port wire

interface WorkerCall {
  type: 'call';
  id: number;
  global: string;
  name: string;
  args: unknown;
}
interface WorkerLog {
  type: 'log';
  text: string;
}
interface WorkerOutputLimit {
  type: 'output-limit';
}
interface WorkerDone {
  type: 'done';
  value?: unknown;
  error?: { kind: 'exception' | 'invalid-output' | 'output-limit'; message: string };
}
type WorkerToHost = WorkerCall | WorkerLog | WorkerOutputLimit | WorkerDone;
type ReplyMessage =
  | { type: 'reply'; id: number; ok: true; value: JsonValue }
  | { type: 'reply'; id: number; ok: false; message: string };

/**
 * Shape gate for inbound port traffic. The peer runs MODEL CODE and can post
 * anything, so every message is re-validated and REBUILT field by field —
 * junk returns undefined and is dropped (a throw in the message listener
 * would crash the host process).
 */
function parseWorkerMessage(raw: unknown): WorkerToHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  switch (m['type']) {
    case 'call': {
      if (typeof m['id'] !== 'number' || typeof m['global'] !== 'string' || typeof m['name'] !== 'string') {
        return undefined;
      }
      return { type: 'call', id: m['id'], global: m['global'], name: m['name'], args: m['args'] };
    }
    case 'log': {
      if (typeof m['text'] !== 'string') return undefined;
      return { type: 'log', text: m['text'] };
    }
    case 'output-limit':
      return { type: 'output-limit' };
    case 'done': {
      if (m['error'] === undefined) {
        return m['value'] !== undefined ? { type: 'done', value: m['value'] } : { type: 'done' };
      }
      const error = m['error'];
      if (typeof error !== 'object' || error === null) return undefined;
      const { kind, message } = error as Record<string, unknown>;
      if ((kind !== 'exception' && kind !== 'invalid-output' && kind !== 'output-limit') || typeof message !== 'string') {
        return undefined;
      }
      return { type: 'done', error: { kind, message } };
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- host run

/** Validate the binding namespaces as seam-contract misuse (throws, not a failed run). */
function validateBindings(bindings: CodeBindingNamespace[]): void {
  const seen = new Set<string>();
  for (const namespace of bindings) {
    if (!IDENTIFIER.test(namespace.global) || seen.has(namespace.global)) {
      throw new Error(`code runtime: binding global ${JSON.stringify(namespace.global)} is not a usable unique identifier`);
    }
    seen.add(namespace.global);
  }
}

/**
 * Run one program in a fresh worker. Program outcomes — including a
 * type-strip syntax error, which never spawns a worker — resolve through
 * `result.error`; the promise rejects only on contract misuse (missing
 * runtime, malformed bindings).
 */
export async function runCode(request: CodeRunRequest, config: CodeRuntimeConfig): Promise<CodeRunResult> {
  if (!typeStrippingAvailable()) {
    throw new Error('code runtime requires Node.js >= 22.19 (node:module stripTypeScriptTypes is unavailable)');
  }
  validateBindings(request.bindings);
  if (request.signal?.aborted) {
    return { logs: [], error: { kind: 'abort', message: String(request.signal.reason ?? 'aborted') } };
  }
  let code: string;
  try {
    const stripped = stripTypes!(STRIP_WRAP.prefix + request.program + STRIP_WRAP.suffix, { mode: 'strip' });
    code = stripped.slice(STRIP_WRAP.prefix.length, stripped.length - STRIP_WRAP.suffix.length);
  } catch (error: unknown) {
    // A program that does not survive the type strip (syntax error, non-
    // erasable syntax like `enum`) is a program failure — no worker spawns.
    return { logs: [], error: { kind: 'exception', message: messageOf(error) } };
  }
  return await execute(request, code, config);
}

function execute(request: CodeRunRequest, code: string, config: CodeRuntimeConfig): Promise<CodeRunResult> {
  return new Promise<CodeRunResult>((resolvePromise) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: {
        code,
        namespaces: request.bindings.map((namespace) => ({
          global: namespace.global,
          names: Object.keys(namespace.functions),
          ...(namespace.errorClass !== undefined ? { errorClass: namespace.errorClass } : {}),
        })),
        maxOutputBytes: config.maxOutputBytes,
      },
      // Model code gets NO ambient environment — stronger than the scrubbed
      // env spawned shells get; and no inherited execArgv (loader hooks from
      // tsx/vitest would leak into the hermetic isolate).
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: config.maxOldGenerationSizeMb },
      // Backstop pipes: the worker patches JS-level writes into its own log
      // stream, so these normally stay silent; anything that still arrives
      // (native-level writes) is dropped rather than leaking into the UI.
      stdout: true,
      stderr: true,
    });
    worker.stdout?.on('data', () => {});
    worker.stderr?.on('data', () => {});

    let settled = false;
    const logs: string[] = [];
    /** Combined outer-output ledger: logs array syntax counted from 2 bytes ("[]"). */
    let logBytes = 2;
    const answered = new Set<number>();

    /** Admit one exact log entry against the cap; false when the cap is crossed. */
    const admit = (text: string): boolean => {
      const cost = jsonByteLength(text) + (logs.length > 0 ? 1 : 0);
      if (logBytes + cost > config.maxOutputBytes) return false;
      logBytes += cost;
      logs.push(text);
      request.onLog?.(text);
      return true;
    };

    const limitFailure = (): CodeRunResult => ({
      logs,
      error: { kind: 'output-limit', message: `outer output exceeded ${config.maxOutputBytes} bytes` },
    });

    /** Exactly one outcome wins; cleanup, terminate, then resolve. */
    const finish = (result: CodeRunResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(eluTimer);
      clearTimeout(wallTimer);
      request.signal?.removeEventListener('abort', onAbort);
      void worker.terminate().finally(() => resolvePromise(result));
    };

    const onCall = (message: WorkerCall): void => {
      // Hostile-peer rules: a duplicate id is ignored, an unknown name is
      // answered as a failure, and a binding throw becomes the program-side
      // rejection — contained here, never a host crash.
      if (answered.has(message.id)) return;
      answered.add(message.id);
      const reply = (payload: ReplyMessage): void => {
        if (!settled) worker.postMessage(payload);
      };
      const namespace = request.bindings.find((item) => item.global === message.global);
      // Own-property lookup only: a forged `constructor` must not walk a
      // prototype chain and reach a callable nobody declared.
      const fn =
        namespace !== undefined && Object.hasOwn(namespace.functions, message.name)
          ? namespace.functions[message.name]
          : undefined;
      if (typeof fn !== 'function') {
        reply({ type: 'reply', id: message.id, ok: false, message: `unknown binding ${JSON.stringify(`${message.global}.${message.name}`)}` });
        return;
      }
      const args = snapshotJson(message.args);
      if (args === undefined) {
        reply({ type: 'reply', id: message.id, ok: false, message: 'tool arguments must be lossless JSON' });
        return;
      }
      void (async () => {
        try {
          const resolved = await fn(args);
          const value = snapshotJson(resolved);
          if (value === undefined) {
            reply({ type: 'reply', id: message.id, ok: false, message: 'tool result must be lossless JSON' });
          } else {
            reply({ type: 'reply', id: message.id, ok: true, value });
          }
        } catch (error: unknown) {
          reply({ type: 'reply', id: message.id, ok: false, message: messageOf(error) });
        }
      })();
    };

    const onDone = (message: WorkerDone): void => {
      if (message.error !== undefined) {
        finish({ logs, error: message.error });
        return;
      }
      if (message.value === undefined) {
        finish({ logs });
        return;
      }
      const value = snapshotJson(message.value);
      if (value === undefined) {
        finish({ logs, error: { kind: 'invalid-output', message: 'program completion must be lossless JSON' } });
        return;
      }
      if (logBytes + jsonByteLength(value) > config.maxOutputBytes) {
        finish(limitFailure());
        return;
      }
      finish({ logs, value });
    };

    worker.on('message', (raw: unknown) => {
      if (settled) return;
      const message = parseWorkerMessage(raw);
      if (message === undefined) return;
      switch (message.type) {
        case 'log':
          if (!admit(message.text)) finish(limitFailure());
          return;
        case 'output-limit':
          finish(limitFailure());
          return;
        case 'call':
          onCall(message);
          return;
        case 'done':
          onDone(message);
          return;
      }
    });
    worker.on('error', (error: Error) => {
      finish({ logs, error: { kind: 'worker-exit', message: `worker error: ${error.message}` } });
    });
    worker.on('exit', (exitCode: number) => {
      finish({ logs, error: { kind: 'worker-exit', message: `worker exited with code ${exitCode} before completing` } });
    });

    // The compute budget reads the worker's OWN measured busy time: a hot
    // loop exhausts it no matter what is in flight, while a program idling on
    // a slow binding accrues nothing.
    const eluTimer = setInterval(() => {
      const elu = worker.performance.eventLoopUtilization();
      if (elu.active > config.computeMs) {
        finish({ logs, error: { kind: 'timeout', message: `compute budget exhausted (${config.computeMs}ms busy)` } });
      }
    }, ELU_POLL_INTERVAL_MS);
    const wallTimer = setTimeout(() => {
      finish({ logs, error: { kind: 'timeout', message: `wall-clock ceiling reached (${config.maxWallMs}ms)` } });
    }, config.maxWallMs);
    const onAbort = (): void => {
      finish({ logs, error: { kind: 'abort', message: String(request.signal?.reason ?? 'aborted') } });
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
