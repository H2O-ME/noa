/**
 * runAgent 主体（M9.6 阶段 G 拆分）：轮次循环、assistant 提交、length/畸形
 * 参数防御、stale-todo 计账、弃用路径清理。装配在 request.ts、流式在
 * stream.ts、工具调度在 tools.ts。
 */
import { newId } from '../ids.js';
import type {
  AgentEvent,
  AssistantMessage,
  ExecutionScope,
  ToolCall,
} from '../types.js';
import {
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  DEFAULT_MAX_TURNS,
  LENGTH_CUTOFF_TOOL_GUIDANCE,
  emptyStats,
  type AgentOptions,
} from './options.js';
import { STALE_TODO_TURNS, requeueUnaccounted, type NoticeState } from './notices.js';
import { assembleRequest } from './request.js';
import { finishAborted, streamCompletion } from './stream.js';
import { refuseCall, synthesizeMissingToolResults } from './refuse.js';
import { makeDispatcher, parseArgs, runToolCalls } from './tools.js';

/**
 * The agent loop as an async generator of standardized events.
 * REPL, browser and non-interactive runners all consume the same stream.
 */
export async function* runAgent(opts: AgentOptions): AsyncGenerator<AgentEvent> {
  // One id per invocation, stable across the run's tool calls: hooks and audit
  // records read it off the scope to correlate "the calls of THIS run" — and a
  // subagent's nested loop, being its own invocation, gets a different runId
  // under the same sessionId. A caller that pinned a runId (a resumed run
  // replaying under one identity) wins; a caller that brought no scope at all
  // (an embedder driving the loop bare) gets a scope holding only the minted id.
  const scope: ExecutionScope = opts.scope?.runId !== undefined
    ? opts.scope
    : { ...opts.scope, runId: newId('run') };
  opts = { ...opts, scope };
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxBytes = opts.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
  const stats = emptyStats();
  // Hoisted so the abandonment finally (consumer threw mid-event → the
  // for-await unwound this iterator) can still honor the notice contract.
  const notices: NoticeState = { unaccounted: [], consumed: true, nag: false, carriedNag: false };

  try {
    // Stale-plan tracking lives on the per-run closure (NOT the messages):
    // how many assistant tool turns have passed without a persisted todo
    // snapshot. Pure qa turns (no tool calls) never count; a `todo/write`
    // session event observed through emit resets to zero. The shape mirrors
    // NoticeState — ephemeral, request-scoped, re-armed on abandonment — so
    // a nag that never reached the model is never lost.
    const staleTodo = { turns: 0, armed: false, pendingWrite: false };
    // One assistant tool turn = one count, no matter how many calls the batch
    // held. Firing arms the NEXT request's nudge and clears the counter so
    // the reminder cannot nag every turn.
    const countStaleTurn = (): void => {
      staleTodo.turns += 1;
      if (staleTodo.turns >= STALE_TODO_TURNS) {
        staleTodo.armed = true;
        staleTodo.turns = 0;
      }
    };
    // Per-run emit wrapper: forwards every event to the runner's real emit
    // unchanged, while watching for the durable plan snapshot. Keyed on the
    // SESSION EVENT (todo/write), never on the tool name — core stays
    // agnostic of which tool persists the plan, and a denied call or a
    // parse failure that writes nothing correctly counts as stale. Created
    // ONCE per run: executeTool reads opts.emit off the options object at
    // call time, so one stable wrapper covers every turn, and the per-turn
    // reset of pendingWrite below keeps each turn's observation window tight.
    const watchTodoWrite: NonNullable<AgentOptions['emit']> = async (evt) => {
      if (evt.type === 'todo/write') staleTodo.pendingWrite = true;
      await opts.emit?.(evt);
    };
    const watchedOpts = opts.emit === undefined ? opts : { ...opts, emit: watchTodoWrite };
    for (let turn = 1; turn <= maxTurns; turn++) {
      if (opts.signal?.aborted) {
        yield* finishAborted(opts);
        return;
      }
      stats.turns = turn;
      yield { type: 'turn_start', turn };

      const messageId = newId('msg');
      // Merge (never clobber): requeueUnaccounted may have re-armed a nag
      // whose request died mid-flight; the counter below may arm a fresh one.
      // Either way assembleRequest consumes nag per carry (one announcement).
      notices.nag = notices.nag || staleTodo.armed;
      staleTodo.armed = false;
      // Fresh observation window for this turn's tool executions: a
      // `todo/write` event emitted by any tool lands here (not on the tool
      // name — see the accounting below). Reset per turn so only the CURRENT
      // turn's snapshot clears the counter.
      staleTodo.pendingWrite = false;
      const request = await assembleRequest(watchedOpts, notices);
      const outcome = yield* streamCompletion(opts, request, messageId, stats, notices);
      if (outcome.interrupted) return;

      const toolCalls: Array<ToolCall & { argsOk: boolean }> = [...outcome.partialCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, partial]) => {
          const { args, ok } = parseArgs(partial.args);
          return {
            id: partial.id ?? newId('call'),
            name: partial.name ?? 'unknown',
            args,
            rawArgs: partial.args,
            argsOk: ok,
          };
        });

      const assistant: AssistantMessage = {
        id: messageId,
        ts: Date.now(),
        role: 'assistant',
        content: outcome.content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        ...(outcome.finishReason !== undefined ? { finishReason: outcome.finishReason } : {}),
      };
      opts.messages.push(assistant);
      // The model answered — announcements have landed and stay consumed.
      notices.consumed = true;
      notices.carriedNag = false;
      yield { type: 'message', message: assistant };

      if (toolCalls.length === 0) {
        // The natural end boundary: the model answered without taking action.
        // `beforeTurnEnd` is fired here and ONLY here — not on `max_turns`, on
        // abort, or after a programmatic stop — so a plugin that wants to
        // repair the model's output (a genui fence the host rejected, a spec
        // that failed validation) gets exactly one chance per natural end to
        // steer the loop into another turn. The first plugin in the chain
        // that returns `{ action: 'steer' }` wins; the loop pushes its
        // message, broadcasts it, and continues. A quota guard prevents run
        // away: `beforeTurnEnd` cannot push the run past `maxTurns`.
        const verdict = await opts.hooks?.beforeTurnEnd?.({ turn, messages: opts.messages });
        if (verdict !== undefined && verdict !== null && verdict.action === 'steer' && turn < maxTurns) {
          opts.messages.push(verdict.message);
          yield { type: 'message', message: verdict.message };
          continue;
        }
        yield { type: 'done', stopReason: 'complete' };
        return;
      }

      // A "length" stop means the output was cut off by the token limit, so
      // every tool call in the batch may carry silently-truncated arguments.
      // Fail them all (the loop continues, so the model can re-issue them).
      // Nothing executed here either, so the turn counts as stale too (the
      // batch still tried to act without landing a fresh snapshot).
      if (outcome.finishReason === 'length') {
        for (const call of toolCalls) {
          yield* refuseCall(opts, call, turn, `Tool call "${call.name}" ${LENGTH_CUTOFF_TOOL_GUIDANCE}`);
        }
        countStaleTurn();
        continue;
      }

      // Malformed-argument defense: arguments that never parsed as JSON would
      // silently execute with {} (a fabricated empty plan). Fail just those
      // calls with an explicit result; the well-formed rest run on.
      const malformed = toolCalls.filter((call) => !call.argsOk);
      for (const call of malformed) {
        yield* refuseCall(
          opts,
          call,
          turn,
          `Tool call "${call.name}" was not executed: the streamed arguments were not valid JSON. Re-issue the tool call with well-formed JSON arguments.`,
        );
      }
      const executable = toolCalls.filter((call) => call.argsOk);
      if (executable.length === 0) {
        // NOTHING RAN — no tool executed, so no snapshot could have landed
        // (pendingWrite is necessarily false). The batch was still a tool
        // turn (the model is acting, not asking): an all-malformed batch
        // with no fresh snapshot counts as stale.
        countStaleTurn();
        continue;
      }

      const toolByName = new Map((opts.tools ?? []).map((tool) => [tool.name, tool]));
      yield* runToolCalls(executable, toolByName, turn, watchedOpts, maxBytes, makeDispatcher(opts, toolByName));

      // Stale-plan accounting: a persisted todo snapshot anywhere in this
      // turn resets to zero, pure-qa turns return earlier so they never
      // count. Detection keys on the durable `todo/write` session event
      // observed through emit — never on the tool name (layering: core stays
      // agnostic of which tool persists the plan, and a deny/parse-failure
      // that writes nothing counts as stale).
      if (staleTodo.pendingWrite) {
        staleTodo.turns = 0;
      } else {
        countStaleTurn();
      }
    }

    yield { type: 'done', stopReason: 'max_turns' };
  } finally {
    // Abandonment cleanup: when the consumer throws mid-event, the for-await
    // closes this generator via .return() and unwinds here — no in-band error
    // handler runs. Two contracts to honor: (1) drained-but-unannounced job
    // notices go back on the queue so a later run re-announces them;
    // (2) an assistant message already pushed with unanswered tool_calls gets
    // its missing results synthesized (NOT_EXECUTED_GUIDANCE), keeping the
    // one-result-per-call surface contract even when the run died in the
    // consumer, not the loop. On every in-band exit the surface is already
    // balanced, so the synthesis is a no-op there.
    requeueUnaccounted(opts, notices);
    synthesizeMissingToolResults(opts.messages);
  }
}
