/**
 * 工具调度（M9.6 阶段 G 拆分）：分段并行、preflight 门、嵌套分发缝
 * （PTC dispatcher）、超时/中断宽限执行、结果落盘溢出。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../ids.js';
import { errMessage } from '../errors.js';
import { toolOutputsDir } from '../paths.js';
import { truncateUtf8Head, truncateUtf8Tail } from '../utf8.js';
import { validateToolCallVerdict } from '../types.js';
import type {
  AgentEvent,
  ToolCall,
  ToolCallScope,
  ToolDefinition,
  ToolResultMessage,
} from '../types.js';
import {
  ABORT_GRACE_MS,
  SKIPPED_BY_ABORT,
  type AgentOptions,
  type ToolDispatcher,
} from './options.js';

interface ToolSegment {
  calls: ToolCall[];
  parallel: boolean;
}

/**
 * Split the batch into maximal runs of adjacent calls that all opted into
 * concurrent dispatch (dsh's isConcurrencySafe classifier). A batch with no
 * opt-ins produces one serial segment per call — identical to the old
 * strictly serial behavior.
 */
function splitToolSegments(calls: ToolCall[], toolByName: Map<string, ToolDefinition>): ToolSegment[] {
  const segments: ToolSegment[] = [];
  for (const call of calls) {
    const safe = toolByName.get(call.name)?.isConcurrencySafe?.(call.args) === true;
    const last = segments[segments.length - 1];
    if (last !== undefined && last.parallel === safe) {
      last.calls.push(call);
    } else {
      segments.push({ calls: [call], parallel: safe });
    }
  }
  return segments;
}

/**
 * Execute one batch of tool calls. Segments whose calls all declare
 * `isConcurrencySafe` execute concurrently (after serial pre-flight of
 * approval/hooks), but results are appended to the log and yielded in
 * original call order so the message log stays deterministic. Serial
 * segments keep strict per-call pre-flight → execute ordering so an abort
 * fired by an earlier tool still skips the queued ones.
 */
export async function* runToolCalls(
  toolCalls: ToolCall[],
  toolByName: Map<string, ToolDefinition>,
  turn: number,
  opts: AgentOptions,
  maxBytes: number,
  dispatch: ToolDispatcher,
): AsyncGenerator<AgentEvent> {
  for (const segment of splitToolSegments(toolCalls, toolByName)) {
    if (!segment.parallel) {
      for (const call of segment.calls) {
        yield { type: 'tool_call_start', turn, call };
        const verdict = await preflightToolCall(call, opts);
        if (verdict.kind === 'skip') {
          yield abortedSkipResult(opts, call, turn);
          continue;
        }
        if (verdict.kind === 'deny') {
          yield {
            type: 'tool_call_result',
            turn,
            call,
            result: deniedResult(opts, call, verdict.content),
          };
          continue;
        }
        const result = await settleToolCall(verdict.effective, opts, maxBytes, toolByName, dispatch);
        opts.messages.push(result);
        yield { type: 'tool_call_result', turn, call: verdict.effective, result };
      }
      continue;
    }

    const approved: { call: ToolCall; effective: ToolCall }[] = [];
    for (const call of segment.calls) {
      yield { type: 'tool_call_start', turn, call };
      const verdict = await preflightToolCall(call, opts);
      if (verdict.kind === 'skip') {
        yield abortedSkipResult(opts, call, turn);
        continue;
      }
      if (verdict.kind === 'deny') {
        yield {
          type: 'tool_call_result',
          turn,
          call,
          result: deniedResult(opts, call, verdict.content),
        };
        continue;
      }
      approved.push({ call, effective: verdict.effective });
    }

    if (approved.length === 0) continue;
    // An abort during the LAST approval must not start earlier-approved calls:
    // executeTool's per-call race fires only after the tool has begun.
    if (opts.signal?.aborted) {
      for (const entry of approved) yield abortedSkipResult(opts, entry.call, turn);
      continue;
    }
    // settleToolCall never rejects, so one result per call lands in call order.
    const settled = await Promise.all(
      approved.map((entry) => settleToolCall(entry.effective, opts, maxBytes, toolByName, dispatch)),
    );
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i]!;
      const call = approved[i]!.effective;
      opts.messages.push(result);
      yield { type: 'tool_call_result', turn, call, result };
    }
  }
}

type PreflightVerdict =
  | { kind: 'skip' }
  | { kind: 'deny'; content: string }
  | { kind: 'run'; effective: ToolCall };

/**
 * Hook/permission/abort gate for one call, before any execution.
 *
 * The chain runs to a FIXPOINT: the approval gate judges inside it, so a single
 * pass would judge the original args while a later `rewrite` decided what
 * executes. A non-converging rewriter is denied rather than looped.
 */
async function preflightToolCall(call: ToolCall, opts: AgentOptions): Promise<PreflightVerdict> {
  // Queued-but-unstarted tools are recorded as skipped so the assistant
  // tool_calls keep their required result messages.
  if (opts.signal?.aborted) return { kind: 'skip' };

  // WHICH run this call belongs to, handed to every hook round. A hook that
  // decides something session-specific (the approval gate reading a permission
  // tier) must read it from here: one kernel runs several sessions concurrently,
  // so "the current session" is a UI selection and would let one conversation's
  // tier decide another's call. The run froze this object when it was created
  // (`Run.scope`), so it is read, never re-derived.
  const scope: ToolCallScope = opts.scope ?? {};

  let effective = call;
  for (let round = 0; ; round++) {
    if (opts.hooks?.beforeToolCall === undefined) break;
    const verdict = await opts.hooks.beforeToolCall(effective, scope);
    // Defense in depth: the composed host already validates, but AgentHooks
    // is a public interface — a hand-rolled implementation bypasses the host.
    // A malformed verdict fails closed (deny), never guessed into execution.
    const malformed = validateToolCallVerdict(verdict);
    if (malformed !== undefined) {
      return { kind: 'deny', content: `Permission denied: malformed hook verdict (${malformed})` };
    }
    if (verdict.action === 'deny') {
      const reason = verdict.reason !== undefined && verdict.reason.length > 0 ? `: ${verdict.reason}` : '';
      return { kind: 'deny', content: `Permission denied${reason}` };
    }
    if (verdict.action === 'allow') break;
    // `rewrite`: the gate inside the chain judged the arguments it was handed,
    // so the NEW arguments must be judged again. Settle when they no longer
    // change (an idempotent rewriter is normal); give up, fail-closed, when
    // they keep changing.
    if (canonicalJson(effective.args) === canonicalJson(verdict.args)) break;
    if (round >= MAX_TOOL_REWRITE_ROUNDS) {
      return {
        kind: 'deny',
        content: 'Permission denied: tool arguments were rewritten without settling (possible rewrite loop)',
      };
    }
    effective = { ...effective, args: verdict.args, rawArgs: JSON.stringify(verdict.args) };
  }

  // An abort that arrived while waiting on the approval prompt must not
  // run the just-approved tool.
  if (opts.signal?.aborted) return { kind: 'skip' };
  return { kind: 'run', effective };
}

/** How many times a call's arguments may change before the gate gives up. */
const MAX_TOOL_REWRITE_ROUNDS = 4;

/**
 * Order-independent JSON for the rewrite fixpoint test: a rewriter that hands
 * back the same object with its keys in a different order has not changed
 * anything and must settle, not loop.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function deniedResult(opts: AgentOptions, call: ToolCall, content: string): ToolResultMessage {
  const result: ToolResultMessage = {
    id: newId('msg'),
    ts: Date.now(),
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content,
  };
  opts.messages.push(result);
  return result;
}

function abortedSkipResult(
  opts: AgentOptions,
  call: ToolCall,
  turn: number,
): { type: 'tool_call_result'; turn: number; call: ToolCall; result: ToolResultMessage } {
  const result: ToolResultMessage = {
    id: newId('msg'),
    ts: Date.now(),
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content: SKIPPED_BY_ABORT,
  };
  opts.messages.push(result);
  return { type: 'tool_call_result', turn, call, result };
}

/**
 * Tool-call arguments arrive as a streamed raw JSON string. Returns the parsed
 * object plus an ok flag: a failed parse must NOT silently run as {} (a
 * fabricated empty plan) — the caller turns !ok into an explicit error result
 * so the model re-issues the call. An empty string stays ok (some gateways
 * emit zero-argument calls as an empty delta).
 */
export function parseArgs(raw: string): { args: Record<string, unknown>; ok: boolean } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { args: {}, ok: true };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, ok: true };
    }
    return { args: {}, ok: false };
  } catch {
    return { args: {}, ok: false };
  }
}

/**
 * Build the loop's nested-dispatch dispatcher (the PTC seam, dsh
 * run_code-bridge style): a sub-call runs the SAME pipeline as a native one —
 * abort checks, the beforeToolCall gate (permission service + plugin hooks),
 * tool execution with per-tool timeout and abort grace, and the
 * afterToolResult chain — but never touches the message log; the settled text
 * is handed back to the calling tool. The optional signal overrides the run
 * signal so run_code can tie sub-calls to its own run-scoped controller
 * (budget expiry or settlement aborts in-flight work instead of orphaning it).
 */
export function makeDispatcher(opts: AgentOptions, toolByName: Map<string, ToolDefinition>): ToolDispatcher {
  return async (call, signal) => {
    const subOpts = signal !== undefined ? { ...opts, signal } : opts;
    const tool = toolByName.get(call.name);
    if (tool === undefined) return { ok: false, error: `unknown tool "${call.name}"` };
    if (subOpts.signal?.aborted) return { ok: false, error: 'run is over; the call was not dispatched' };
    const sub: ToolCall = {
      id: newId('call'),
      name: call.name,
      args: call.args,
      rawArgs: JSON.stringify(call.args),
    };
    const verdict = await preflightToolCall(sub, subOpts);
    if (verdict.kind === 'skip') return { ok: false, error: 'run is over; the call was not dispatched' };
    if (verdict.kind === 'deny') return { ok: false, error: verdict.content };
    const raw = await executeTool(tool, verdict.effective, subOpts);
    const result = opts.hooks?.afterToolResult
      ? await opts.hooks.afterToolResult(verdict.effective, raw)
      : raw;
    return { ok: true, result };
  };
}

async function executeTool(
  tool: ToolDefinition | undefined,
  call: ToolCall,
  opts: AgentOptions,
  dispatch?: ToolDispatcher,
): Promise<string> {
  if (!tool) return `Error: unknown tool "${call.name}"`;

  const parent = opts.signal;
  let signal = parent;
  let timeoutController: AbortController | undefined;
  if (tool.timeoutMs !== undefined) {
    timeoutController = new AbortController();
    signal = parent ? AbortSignal.any([parent, timeoutController.signal]) : timeoutController.signal;
  }

  const run = (async () => {
    try {
      return await tool.execute(call.args, {
        rootDir: opts.rootDir,
        signal,
        ...(opts.jobs !== undefined ? { jobs: opts.jobs } : {}),
        ...(opts.scope?.sessionId !== undefined ? { sessionId: opts.scope.sessionId } : {}),
        ...(opts.emit !== undefined ? { emit: opts.emit } : {}),
        ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
        ...(opts.onToolProgress !== undefined
          ? { onProgress: (text: string) => opts.onToolProgress?.(call, text) }
          : {}),
        ...(dispatch !== undefined ? { dispatch } : {}),
      });
    } catch (err) {
      return `Error: ${errMessage(err)}`;
    }
  })();

  /**
   * The tool result is decided by whichever comes first: the run settles, the
   * per-tool timeout fires, or — after a short abort grace — the parent
   * signal (user interrupt) cuts it off. The grace lets a tool that finishes
   * right around the abort record its real result; one that ignores its
   * cancellation signal gets cut off, so Esc/Ctrl+C always ends the run
   * promptly (codex interrupt guarantee). The abandoned run keeps going in
   * the background; its value is dropped.
   */
  return new Promise<string>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let abortGrace: NodeJS.Timeout | undefined;
    const settle = (value: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (abortGrace !== undefined) clearTimeout(abortGrace);
      if (onAbort !== undefined) parent?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort =
      parent === undefined
        ? undefined
        : () => {
            abortGrace ??= setTimeout(
              () => settle(`Error: tool "${call.name}" aborted by user interrupt`),
              ABORT_GRACE_MS,
            );
          };
    if (tool.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timeoutController?.abort();
        settle(`Error: tool "${call.name}" timed out after ${tool.timeoutMs}ms (cancellation was requested; work that ignores the signal may still be running)`);
      }, tool.timeoutMs);
    }
    if (parent !== undefined && onAbort !== undefined) {
      if (parent.aborted) {
        onAbort();
      } else {
        parent.addEventListener('abort', onAbort, { once: true });
      }
    }
    void run.then((value) => settle(value));
  });
}

/** `completeToolCall` with a guaranteed result: a failure in execute, the after-hook, spill or meta becomes a recorded error result, so one result per call always lands. */
async function settleToolCall(
  call: ToolCall,
  opts: AgentOptions,
  maxBytes: number,
  toolByName: Map<string, ToolDefinition>,
  dispatch?: ToolDispatcher,
): Promise<ToolResultMessage> {
  try {
    return await completeToolCall(call, opts, maxBytes, toolByName, dispatch);
  } catch (err) {
    return {
      id: newId('msg'),
      ts: Date.now(),
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: `Error: tool result could not be recorded (${errMessage(err)})`,
    };
  }
}

/** Execute one approved call and produce its log-ready result message. */
async function completeToolCall(
  call: ToolCall,
  opts: AgentOptions,
  maxBytes: number,
  toolByName: Map<string, ToolDefinition>,
  dispatch?: ToolDispatcher,
): Promise<ToolResultMessage> {
  let rawResult = await executeTool(toolByName.get(call.name), call, opts, dispatch);
  if (opts.hooks?.afterToolResult) {
    rawResult = await opts.hooks.afterToolResult(call, rawResult);
  }
  const { content, truncatedRef } = await storeToolResult(rawResult, maxBytes, opts);
  const tool = toolByName.get(call.name);
  // Tool-owned metadata is attached AFTER the afterToolResult hook and AFTER
  // truncation, so the meta describes the SETTLED result the surface renders,
  // not the in-flight string. The hook is pure and synchronous; absent or
  // undefined-returning tools add no field and the message ships unchanged.
  const meta = tool?.resultMeta?.(call.args, content);
  return {
    id: newId('msg'),
    ts: Date.now(),
    role: 'tool',
    toolCallId: call.id,
    name: call.name,
    content,
    ...(truncatedRef ? { truncatedRef } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

/**
 * Tool results over the byte budget are written to disk in full and only a
 * truncated head plus tail are kept in the message log (codex-style middle
 * truncation: the head gives the summary, the tail carries the most recent
 * output such as test failure details), so the prompt prefix stays small
 * and existing messages are never rewritten. The on-disk copy is written
 * owner-exclusively (`wx`) and referenced with an explicit retrieval hint,
 * dsh spill-style.
 */
async function storeToolResult(
  raw: string,
  maxBytes: number,
  opts: AgentOptions,
): Promise<{ content: string; truncatedRef?: string }> {
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return { content: raw };
  // The spill never lands in the workspace (zero-write rule): callers pass a
  // cacheDir under ~/.noa, and the fallback keeps that contract too.
  const cacheDir = opts.cacheDir ?? toolOutputsDir();
  await mkdir(cacheDir, { recursive: true });
  const ref = path.join(cacheDir, `${newId('out')}.txt`);
  // 'wx' refuses to overwrite (or follow a planted symlink at) an existing path.
  await writeFile(ref, raw, { encoding: 'utf8', flag: 'wx' });
  // Keep the message body (head + hint line + tail) inside the byte budget:
  // reserve room for the hint line, then split the rest 60/40 head/tail.
  const bodyBudget = Math.max(1024, maxBytes - HINT_LINE_RESERVE_BYTES);
  const head = truncateUtf8Head(raw, Math.floor(bodyBudget * HEAD_TAIL_RATIO));
  const tail = truncateUtf8Tail(raw, bodyBudget - Math.floor(bodyBudget * HEAD_TAIL_RATIO));
  const dropped = Buffer.byteLength(raw, 'utf8') - Buffer.byteLength(head, 'utf8') - Buffer.byteLength(tail, 'utf8');
  const content = `${head}\n[truncated ${dropped} bytes; full output at ${ref} — use the read tool on this path to view it]\n${tail}`;
  return { content, truncatedRef: ref };
}

/** Share of the byte budget kept as the head; the rest keeps the tail. */
const HEAD_TAIL_RATIO = 0.6;
/** Room reserved for the truncation hint line so the body stays in budget. */
const HINT_LINE_RESERVE_BYTES = 200;
