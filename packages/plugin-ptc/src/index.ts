/**
 * PTC mode (Cloudflare Code Mode, dsh run_code simplified): the model writes
 * a TypeScript program against the tool registry instead of emitting one
 * native tool call per step. `run_code` is the transport; every binding call
 * inside the program is routed through `ctx.dispatch` — the loop's full
 * pipeline, so the approval gate and hooks apply to sub-calls exactly as they
 * do to native calls. Only what the program prints or returns re-enters the
 * conversation; each settled sub-dispatch is kept as a log-only
 * `code-dispatch` audit event.
 *
 * Presentation lives here too: under mode `'ptc'` the beforeLLMCall projection
 * hides every native schema except `run_code` and appends the generated SDK
 * to the system prompt; under `'both'` native calls stay available beside the
 * program transport. The projection is deterministic, so the appended section
 * is byte-stable and the prefix cache survives.
 *
 * The mode itself is the ROW's config, not a host projection: the plugin reads
 * its own settings (`settings.ts` owns the shape, the page and the budgets), so
 * `native` is a statement about this row and nothing else in the product has to
 * know what a code mode is.
 */

import { errMessage } from '@noa/core';
import {
  beforeLlmCall,
  pluginConfig as pluginConfigKey,
  pluginRpc as pluginRpcKey,
  tools as toolsKey,
  type Context,
  type Plugin,
  type ToolDefinition,
  type ToolDispatchResult,
  type ToolExecuteContext,
} from '@noa/core';
import { registerCommand, registerTool, typeStrippingAvailable } from '@noa/core';
import { snapshotJson } from './json.js';
import type { JsonValue } from './json.js';
import { runCode } from './code-runtime.js';
import type { CodeRunResult, CodeRuntimeConfig } from './code-runtime.js';
import { renderToolsSdk, RUN_CODE_NAME } from './sdk.js';
import {
  Config,
  DEFAULT_MAX_PARALLEL_SUB_CALLS,
  PTC_PLUGIN_NAME,
  type PtcMode,
  ptcModeReport,
  ptcPage,
  ptcRuntimeConfig,
  ptcSavePatch,
  ptcSaveSettings,
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
 * PTC as a standard plugin.
 *
 * The mode lives in THIS row's config (`plugins.entries[].config`), not in a
 * host-side `tools.code` projection: the host no longer knows what a code mode
 * is, it only knows the row and hands the plugin its settings. `native` means
 * "this row is off" — nothing is registered — but the settings namespace still
 * answers, because that page is the only way the mode comes back.
 */
export const plugin: Plugin<PtcPluginConfig> = {
  name: PTC_PLUGIN_NAME,
  manifest: {
    title: 'PTC 代码模式',
    description: '让模型写一段 TypeScript 程序批量调工具（run_code），程序在受限 worker 里运行。',
    tier: 'advanced',
    // Declared because the row answers a settings `page` (registered below, even
    // for `native` rows — that page is the only way the mode comes back). The
    // navigation is derived from the live roster, so an undeclared page is an
    // unreachable page.
    page: true,
  },
  Config,
  inject: [toolsKey, pluginRpcKey, pluginConfigKey],
  apply: (ctx: Context, config: PtcPluginConfig): void => {
    const mode: PtcMode = config.mode ?? 'both';
    const maxParallel = Math.max(1, Math.trunc(config.maxParallelSubCalls ?? DEFAULT_MAX_PARALLEL_SUB_CALLS));
    const outcome = ptcRuntimeAvailability(config);

    // `/mode` belongs to THIS plugin: the mode is its own vocabulary, so the
    // command that explains it is registered here and lives exactly as long as
    // this row does. The host used to own it (a `codeModeInForce` that looked
    // this package up BY NAME and a copy of the three mode labels in a
    // `lines.ts`) — that is the "add a plugin, edit the core" pattern the
    // refactor deletes. Registered for every mode, including `native`: the
    // readout is the most useful thing a switched-off row can still say.
    registerCommand(ctx, {
      name: 'mode',
      description: '查看三种执行模式的区别与当前模式（本行 plugins.entries 的 mode）',
      run: (_args, runCtx) => {
        for (const line of ptcModeReport(mode)) runCtx.log(line);
      },
    });

    // Registered BEFORE the mode check: `native` rows and rows the environment
    // cannot run still have a page, and that page is where the operator fixes
    // exactly that. Failing activation instead would take the page down with it.
    ctx.effect(
      () =>
        ctx.must(pluginRpcKey).register(PTC_PLUGIN_NAME, async (op, payload) => {
          switch (op) {
            case 'page':
              return ptcPage(config, outcome);
            case 'save': {
              const fields = submittedFields(payload);
              const merged = ptcSaveSettings(config, fields);
              // The port merges PER KEY into the stored RAW row, so the save
              // submits only the fields the form actually changed — handing it
              // the whole in-force (expanded) config would replace an operator's
              // hand-written `{env:NAME}` reference with its expanded value
              // (the exact loss `PluginConfigPort.setEntry` exists to prevent).
              await ctx.must(pluginConfigKey).setEntry(PTC_PLUGIN_NAME, { enabled: true, config: ptcSavePatch(fields) });
              // The saved descriptor is the same page as before the save, only
              // recomputed against the merged settings: the confirmation the
              // operator sees is the generic one every plugin page gets.
              return ptcPage(merged, ptcRuntimeAvailability(merged));
            }
            default:
              throw new Error(`ptc: unknown operation "${op}"`);
          }
        }),
      `rpc(${PTC_PLUGIN_NAME})`,
    );

    if (mode === 'native') return;
    if (!outcome.ok) {
      // Unusable budgets or a Node without type stripping: the model gets no
      // run_code at all rather than a tool that fails every call — a `ptc` row
      // whose only tool always refuses would leave the model with nothing.
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
      const fingerprint = `${mode}\u0000${all.map((tool) => tool.name).join('\u0001')}`;
      if (sdkSection === undefined || fingerprint !== sdkFingerprint) {
        // `both` mode: native schemas already carry full parameter types,
        // so the SDK binding only lists names + one-line summaries (slim).
        // `ptc` mode: the SDK is the only tool surface, so full types.
        const sdk = renderToolsSdk(all, { slim: mode === 'both' });
        sdkSection = mode === 'ptc' ? `${PTC_ONLY_NOTE}\n\n${sdk}` : sdk;
        sdkFingerprint = fingerprint;
      }
      const tools = mode === 'ptc' ? all.filter((tool) => tool.name === RUN_CODE_NAME) : all;
      // `next(rewritten)`: the projection composes instead of winning the
      // chain outright — a later hook still sees (and may adjust) the
      // projected request, and its answer is what returns.
      return next({ ...req, tools, systemPrompt: `${req.systemPrompt ?? ''}\n\n${sdkSection}` });
    });
  },
};

export default plugin;

/**
 * Can this row run a program right now?
 *
 * Two independent facts, reported the same way because the operator's next step
 * is the same for both (fix the settings or switch the mode): the budgets must
 * resolve, and the runtime must be able to strip types. Neither is allowed to
 * throw — see the `apply` comment.
 * @param config - the row's settings.
 * @returns the usable budgets, or why there are none.
 */
function ptcRuntimeAvailability(config: PtcPluginConfig): PtcRuntimeOutcome {
  if (!typeStrippingAvailable()) {
    return {
      ok: false,
      message: 'PTC 需要 Node.js >= 22.19（node:module stripTypeScriptTypes 不可用）：升级 Node，或把这一行的 mode 设为 native。',
    };
  }
  return ptcRuntimeConfig(config);
}

/** `save` 的 payload → 提交的字段表；缺 `fields` 是契约违背，点名拒绝。 */
function submittedFields(payload: unknown): Record<string, string> {
  const fields = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)['fields']
    : undefined;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('ptc: "save" needs a "fields" object of strings');
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`ptc: setting "${key}" must be a string`);
    out[key] = value;
  }
  return out;
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

/** Statement prepended to the SDK only under pure-PTC presentation. */
const PTC_ONLY_NOTE =
  '## PTC mode: direct tool calls are OFF\n\n'
  + 'In this session the ONLY natively declared tool is `run_code`. Every other tool is '
  + 'reachable exclusively as an SDK binding inside the program you write (see below). '
  + 'Issue `run_code` calls, not native tool calls.';

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
