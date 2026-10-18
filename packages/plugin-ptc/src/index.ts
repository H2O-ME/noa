/**
 * `run_code` (Cloudflare Code Mode, dsh run_code simplified): the model writes
 * a TypeScript program against the tool registry instead of emitting one
 * native tool call per step. `run_code` is the transport; every binding call
 * inside the program is routed through `ctx.dispatch` — the loop's full
 * pipeline, so the approval gate and hooks apply to sub-calls exactly as they
 * do to native calls. Only what the program prints or returns re-enters the
 * conversation; each settled sub-dispatch is kept as a log-only
 * `code-dispatch` audit event.
 *
 * It is an ORDINARY tool: there is no code-mode switch anywhere in the product.
 * Native tool calls stay available beside it, and the only presentation this
 * plugin contributes is the generated SDK appended to the system prompt (so the
 * model knows the bindings it may call), never a narrowed tool list. The
 * projection is deterministic, so the appended section is byte-stable and the
 * prefix cache survives.
 *
 * The budgets are the ROW's config, not a host projection: the plugin reads its
 * own settings (`settings.ts` owns the shape and the budgets), and nothing else
 * in the product has to know what a code tool is.
 */

import { errMessage } from '@noa/core';
import {
  beforeLlmCall,
  tools as toolsKey,
  type Context,
  type Plugin,
  type ToolDefinition,
  type ToolDispatchResult,
  type ToolExecuteContext,
} from '@noa/core';
import { registerTool, typeStrippingAvailable } from '@noa/core';
import { snapshotJson } from './json.js';
import type { JsonValue } from './json.js';
import { runCode } from './code-runtime.js';
import type { CodeRunResult, CodeRuntimeConfig } from './code-runtime.js';
import { renderToolsSdk, RUN_CODE_NAME } from './sdk.js';
import {
  Config,
  DEFAULT_MAX_PARALLEL_SUB_CALLS,
  PTC_PLUGIN_NAME,
  ptcRuntimeConfig,
  type PtcPluginConfig,
  type PtcRuntimeOutcome,
} from './settings.js';

// The package's own modules are public here, mirroring what the plugins
// package re-exported before the plugin moved out: the JSON helpers, the SDK
// renderer and the code runtime are the pieces a test (or an implementation
// swap) reaches for.
export * from './json.js';
export * from './sdk.js';
export * from './code-runtime.js';
export * from './settings.js';

/**
 * `run_code` as a standard plugin.
 *
 * The budgets live in THIS row's config (`plugins.entries[].config`), not in a
 * host-side `tools.code` projection: the host does not know what a code tool is,
 * it only knows the row and hands the plugin its settings. Switching the row off
 * is the only way to remove the tool — there is no in-row mode to say "register
 * nothing", because a mode is exactly the concept this plugin no longer has.
 */
export const plugin: Plugin<PtcPluginConfig> = {
  name: PTC_PLUGIN_NAME,
  manifest: {
    title: '代码工具（run_code）',
    description: '给模型一个 run_code 工具：写 TypeScript 程序批量调工具，程序在受限 worker 里运行。',
    tier: 'advanced',
  },
  Config,
  inject: [toolsKey],
  apply: (ctx: Context, config: PtcPluginConfig): void => {
    const maxParallel = Math.max(1, Math.trunc(config.maxParallelSubCalls ?? DEFAULT_MAX_PARALLEL_SUB_CALLS));
    const outcome = ptcRuntimeAvailability(config);

    if (!outcome.ok) {
      // Unusable budgets or a Node without type stripping: the model gets no
      // run_code at all rather than a tool that fails every call — a tool whose
      // every call refuses is worse than an absent one.
      ctx.log('warn', `ptc: run_code is not available: ${outcome.message}`);
      return;
    }
    const runtimeConfig = outcome.config;
    registerTool(
      ctx,
      {
        name: RUN_CODE_NAME,
        description: RUN_CODE_DESCRIPTION,
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: 'The program: the body of an async TypeScript function.' },
            description: { type: 'string', description: DESCRIPTION_PARAM },
          },
          required: ['code', 'description'],
          additionalProperties: false,
        },
        // The approval popup shows what the program actually says, not a
        // truncated args blob (preview(args) contract, edit_file precedent).
        preview: (args) => {
          const description = typeof args['description'] === 'string' ? args['description'] : '';
          const code = typeof args['code'] === 'string' ? args['code'] : '';
          const lines = code.split('\n');
          const shown = lines.slice(0, 12);
          const more = lines.length > shown.length ? [`// … ${lines.length - shown.length} more lines`] : [];
          return [`run_code: ${description}`, '```ts', ...shown, ...more, '```'].join('\n');
        },
        execute: (args, c) => runCodeProgram(() => [...ctx.must(toolsKey).all()], runtimeConfig, maxParallel, args, c),
      },
      // The trust posture is deliberately bash-equal: the worker contains
      // runaway programs but is NOT a security boundary, so the program
      // itself goes through the execute gate, and every sub-call through
      // its own tool's gate via ctx.dispatch.
      'execute',
    );

    let sdkSection: string | undefined;
    let sdkFingerprint = '';
    ctx.on(beforeLlmCall, async (req, next) => {
      const all = req.tools ?? [];
      // No run_code in the outgoing request (e.g. a summarizer call without
      // tools): nothing to project onto — delegate untouched.
      if (!all.some((tool) => tool.name === RUN_CODE_NAME)) return next();
      // Fingerprint the toolset by name: a plugin activating AFTER the first
      // request (skills loading, host rebuild) changes the set, and a
      // one-shot cache would silently serve an SDK that omits the newcomers.
      const fingerprint = all.map((tool) => tool.name).join('\u0001');
      if (sdkSection === undefined || fingerprint !== sdkFingerprint) {
        // Native schemas already carry full parameter types, so the SDK binding
        // only lists names + one-line summaries (slim) — the tool list is never
        // narrowed, so full types here would be a second, drifting copy of what
        // the request already says.
        sdkSection = renderToolsSdk(all, { slim: true });
        sdkFingerprint = fingerprint;
      }
      // `next(rewritten)`: the projection composes instead of winning the
      // chain outright — a later hook still sees (and may adjust) the
      // projected request, and its answer is what returns. Only the SDK is
      // added; `tools` rides through as the caller sent it.
      return next({ ...req, systemPrompt: `${req.systemPrompt ?? ''}\n\n${sdkSection}` });
    });
  },
};

export default plugin;

/**
 * Can this row run a program right now?
 *
 * Two independent facts, reported the same way because the operator's next step
 * is the same for both (fix the budgets or upgrade Node): the budgets must
 * resolve, and the runtime must be able to strip types. Neither is allowed to
 * throw — see the `apply` comment.
 * @param config - the row's settings.
 * @returns the usable budgets, or why there are none.
 */
function ptcRuntimeAvailability(config: PtcPluginConfig): PtcRuntimeOutcome {
  if (!typeStrippingAvailable()) {
    return {
      ok: false,
      message: 'run_code 需要 Node.js >= 22.19（node:module stripTypeScriptTypes 不可用）：升级 Node，或关掉这一行。',
    };
  }
  return ptcRuntimeConfig(config);
}

const RUN_CODE_DESCRIPTION =
  'Execute a TypeScript program against the available tools. Takes two required '
  + 'arguments: `code`, the BODY of an async function (erasable syntax only; top-level '
  + '`await` and `return` work), and `description`, a short summary of what the program '
  + 'does. Call tools as `await tools.name(args)` per the declarations in the system '
  + 'prompt. Only what you print or return is program output — curate it.';

const DESCRIPTION_PARAM =
  'Clear, concise description of what this program does in active voice, 5-10 words '
  + '(shown in the UI). Examples: "Count TODO markers across packages"; '
  + '"Read failing test and its fixture"; "Collect status of all git repos".';

function previewValue(value: unknown, cap: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > cap ? `${text.slice(0, cap)}…[+${text.length - cap} chars]` : text;
}

interface PendingDispatch {
  name: string;
  args: Record<string, JsonValue>;
  settle(result: ToolDispatchResult): void;
}

/**
 * (2) The ordered dispatch queue + driver. Strict submission-ordered starts;
 * consecutive concurrency-safe calls overlap up to `maxParallel`, an exclusive
 * call drains the pool, runs alone, and holds the barrier through its own
 * completion (dsh dispatch-queue semantics minus the ordered commit stage —
 * NovaAgent sub-call results never rejoin the log).
 */
function createDispatchQueue(
  dispatch: ToolExecuteContext['dispatch'],
  byName: Map<string, ToolDefinition>,
  maxParallel: number,
  runController: AbortController,
  runOver: () => boolean,
  overReason: () => string,
) {
  const queue: PendingDispatch[] = [];
  const inFlight = new Set<Promise<void>>();
  let exclusiveActive = false;
  let driving = false;
  let driverRun: Promise<void> = Promise.resolve();
  let wake: (() => void) | undefined;
  const wakeup = (): void => {
    const release = wake;
    wake = undefined;
    release?.();
  };

  const abandonQueued = (): void => {
    for (const pending of queue.splice(0)) {
      pending.settle({ ok: false, error: `run_code run is over (${overReason()}); ${pending.name} was not dispatched` });
    }
  };

  const launch = (pending: PendingDispatch, exclusive: boolean): void => {
    const flight = (async () => {
      let outcome: ToolDispatchResult;
      try {
        outcome = await dispatch!({ name: pending.name, args: pending.args }, runController.signal);
      } catch (err) {
        outcome = { ok: false, error: errMessage(err) };
      }
      pending.settle(outcome);
    })().finally(() => {
      inFlight.delete(flight);
      if (exclusive) exclusiveActive = false;
      wakeup();
    });
    inFlight.add(flight);
  };

  const drive = (): Promise<void> => {
    if (driving) return driverRun;
    driving = true;
    driverRun = (async () => {
      for (;;) {
        // Create the wakeup BEFORE inspecting state so a settle or submission
        // arriving between the checks and the await cannot be lost.
        const signal = new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (runOver()) {
          abandonQueued();
          if (inFlight.size === 0) return;
          await signal;
          continue;
        }
        const head = queue[0];
        if (head !== undefined) {
          const parallel = byName.get(head.name)?.isConcurrencySafe?.(head.args) === true;
          const capacity = !exclusiveActive && (parallel ? inFlight.size < maxParallel : inFlight.size === 0);
          if (capacity) {
            queue.shift();
            if (!parallel) exclusiveActive = true;
            launch(head, !parallel);
            continue;
          }
        }
        if (queue.length === 0 && inFlight.size === 0) return;
        await signal;
      }
    })().finally(() => {
      driving = false;
      wake = undefined;
    });
    return driverRun;
  };

  return {
    enqueue(pending: PendingDispatch): void {
      queue.push(pending);
      wakeup();
      void drive();
    },
    settle(runController: AbortController): Promise<void> {
      runController.abort('run_code settled');
      wakeup();
      return drive();
    },
  };
}

/**
 * One run of one program: build bindings for the currently registered tools,
 * drive them through the loop's dispatch seam under a run-scoped abort, then
 * settle only after every sub-dispatch has fully quiesced.
 *
 * Split into four stages — validate / dispatch-queue / bindings+audit / run —
 * extracted so each is independently readable.
 */
async function runCodeProgram(
  liveTools: () => ToolDefinition[],
  runtimeConfig: CodeRuntimeConfig,
  maxParallel: number,
  args: Record<string, unknown>,
  c: ToolExecuteContext,
): Promise<string> {
  // (1) Argument validation + the run-scoped abort (follows the outer signal
  // in and fires when the run settles for ANY reason, so an in-flight
  // sub-dispatch is aborted instead of orphaned and queued-unstarted ones are
  // abandoned).
  const code = typeof args['code'] === 'string' ? args['code'] : '';
  const description = typeof args['description'] === 'string' ? args['description'] : '';
  if (code.trim().length === 0) return 'Error: code is required — the body of an async TypeScript function';
  if (description.trim().length === 0) return 'Error: description is required — a short summary of what the program does';
  if (c.dispatch === undefined) {
    return 'Error: nested tool dispatch is unavailable here (run_code must execute through the agent loop)';
  }
  const dispatch = c.dispatch;

  const runController = new AbortController();
  const onOuterAbort = (): void => runController.abort(c.signal?.reason);
  c.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const runOver = (): boolean => runController.signal.aborted;
  const overReason = (): string => String(runController.signal.reason ?? 'aborted');

  const visible = liveTools().filter((tool) => tool.name !== RUN_CODE_NAME);
  const byName = new Map(visible.map((tool) => [tool.name, tool]));

  const dq = createDispatchQueue(dispatch, byName, maxParallel, runController, runOver, overReason);

  // (3) Audit emission + bindings exposed to the program. The audit record
  // exists even when the run ended while the call was in flight; the program
  // is then stopped rather than handed a result from a run that is over.
  const emitAudit = (name: string, callArgs: Record<string, JsonValue>, outcome: ToolDispatchResult): void => {
    if (c.emit === undefined) return;
    void Promise.resolve(
      c.emit({
        type: 'code-dispatch',
        toolName: name,
        argsPreview: previewValue(callArgs, 1500),
        isError: !outcome.ok,
        resultPreview: previewValue(outcome.ok ? outcome.result : outcome.error, 3000),
        at: Date.now(),
      }),
    ).catch(() => {});
  };

  const binding = (name: string): ((args: unknown) => Promise<JsonValue>) => async (rawArgs: unknown): Promise<JsonValue> => {
    if (runOver()) throw new Error(`run_code run is over (${overReason()}); ${name} not dispatched`);
    const snapshot = snapshotJson(rawArgs);
    if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
      throw new Error('tool arguments must be a JSON object (call the tool with an object, e.g. {})');
    }
    const callArgs = snapshot as Record<string, JsonValue>;
    const outcome = await new Promise<ToolDispatchResult>((settle) => {
      dq.enqueue({ name, args: callArgs, settle });
    });
    emitAudit(name, callArgs, outcome);
    if (runOver()) throw new Error(`run_code run is over (${overReason()}); ${name} result discarded`);
    if (!outcome.ok) throw new Error(outcome.error);
    return outcome.result;
  };

  // Null-prototype + defineProperty: a registered tool named `__proto__` or
  // `toString` becomes an ordinary own key, never a prototype collision.
  const functions = Object.create(null) as Record<string, (args: unknown) => Promise<JsonValue>>;
  for (const tool of visible) {
    Object.defineProperty(functions, tool.name, { enumerable: true, value: binding(tool.name) });
  }

  try {
    // (4) Run the program through the worker runtime, settle the queue, then
    // render the result. The dispatch seam must be handed the run-scoped
    // signal — sub-calls aborted when the run settles, not the outer one.
    let result: CodeRunResult;
    try {
      result = await runCode(
        {
          program: code,
          bindings: [
            {
              global: 'tools',
              functions,
              errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
            },
          ],
          signal: runController.signal,
          ...(c.onProgress !== undefined ? { onLog: (text: string): void => c.onProgress?.(text) } : {}),
        },
        runtimeConfig,
      );
    } finally {
      // Settle fully: abort in-flight sub-dispatches and drain the queue
      // before run_code itself returns — nothing may append after settlement.
      await dq.settle(runController);
    }
    if (result.error !== undefined) {
      const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join('\n')}` : '';
      return `Error: code run failed (${result.error.kind}): ${result.error.message}${logsText}`;
    }
    const rendered =
      result.value === undefined
        ? ''
        : typeof result.value === 'string'
          ? result.value
          : JSON.stringify(result.value, null, 2);
    const parts = [result.logs.join('\n'), rendered].filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('\n') : '(run_code completed with no output)';
  } finally {
    c.signal?.removeEventListener('abort', onOuterAbort);
  }
}
