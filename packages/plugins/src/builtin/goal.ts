import {
  advanceGoal,
  blockGoal,
  completeGoal,
  createGoal,
  editGoal,
  goalExhausted,
  goalIsActive,
  goalRoundPrompt,
  pauseGoal,
  resumeGoal,
  resolveMaxRounds,
  newId,
} from '@noa/core';
import type { Goal, GoalStatus, Plugin, ToolExecuteContext } from '@noa/core';
import { beforeLlmCall, errMessage, tools as toolsKey } from '@noa/core';
import { registerTool } from '../toolbox.js';

/**
 * The durable goal: a completion objective the session keeps working toward
 * across runs.
 *
 * Three disciplines, each inherited from a mechanism that already exists here:
 *
 *  1. **Whole-value snapshots, log-only.** The tool writes one `goal/change`
 *     session event carrying the COMPLETE goal (last-write-wins), exactly as
 *     `todo_write` does. The log is the truth, so a resume restores the goal
 *     without a separate store, and the model never pays context for it.
 *  2. **Continuation rides the existing ephemeral-tail channel.** There is no new
 *     core mechanism: the `beforeLLMCall` hook appends one temporary user message
 *     to the request under construction, which is the same request-level tail the
 *     job-finished notice and the stale-plan nag already use (not logged, not in
 *     `opts.messages`, recomputed per request ⇒ at-least-once). Producing it from
 *     the PLUGIN side is deliberate: core would otherwise have to learn what a
 *     goal is in order to hard-code a third producer.
 *  3. **Round admission is the hook's job, not the tool's.** `rounds` counts
 *     continuation runs, so it advances where the continuation prompt is built —
 *     otherwise "how many rounds have run" and "how many times were we asked to
 *     continue" would be two different numbers.
 *
 * The goal is resumable state, not an instruction to keep spending: the loop stops
 * asking once the round budget is spent, and `blocked`/`complete` end it outright.
 */

/** The statuses a caller may set through `update_goal`. */
const STATUSES: readonly GoalStatus[] = ['active', 'paused', 'blocked', 'complete'];

/** Read the goal currently in force, as the assembly supplies it. */
export interface GoalPluginOptions {
  /**
   * The live goal, read from the session log at request time.
   *
   * A getter rather than a value: the hook runs on every request, and a captured
   * snapshot would keep re-continuing the goal the session started with even after
   * the model completed or replaced it.
   */
  current: () => Goal | null;
  /**
   * Write the new goal to the session log. Absent on a surface with no open
   * session; the tools then report that they cannot persist rather than pretending.
   */
  write: (goal: Goal | null) => void | Promise<void>;
}

/** One `update_goal` field, as the wire may spell it. */
interface GoalPatch {
  objective?: string;
  status?: GoalStatus;
  blockedReason?: string;
  maxRounds?: number;
}

/**
 * Read a status off untrusted arguments.
 * @param raw - the raw value.
 * @returns the status, or a message saying why it is not one.
 */
function parseStatus(raw: unknown): GoalStatus | undefined {
  return typeof raw === 'string' && STATUSES.includes(raw as GoalStatus) ? (raw as GoalStatus) : undefined;
}

/**
 * Apply one patch to the stored goal, or explain the refusal.
 *
 * Status transitions go through the domain functions rather than being assigned,
 * so the invariants they hold (a `blocked` goal must carry a reason, a `complete`
 * goal is terminal) cannot be bypassed by a hand-written field.
 * @param goal - the goal in force.
 * @param patch - the requested changes.
 * @returns the new goal, or a message for the model.
 */
function applyPatch(goal: Goal, patch: GoalPatch): Goal | string {
  let next = goal;
  if (patch.objective !== undefined) {
    // A completed goal's round counter describes work that is over, so editing
    // the objective REPLACES it instead of reviving a spent budget.
    next = next.status === 'complete'
      ? createGoal(patch.objective, { maxRounds: patch.maxRounds ?? next.maxRounds })
      : editGoal(next, patch.objective);
  }
  if (patch.maxRounds !== undefined) {
    try {
      next = { ...next, maxRounds: resolveMaxRounds(patch.maxRounds), updatedAt: Date.now() };
    } catch (err) {
      return `Error: ${errMessage(err)}`;
    }
  }
  if (patch.status === undefined) return next;
  if (patch.status === 'blocked') {
    const reason = patch.blockedReason;
    if (reason === undefined) {
      return 'Error: setting status to "blocked" requires blockedReason — name the concrete condition that persists and prevents progress.';
    }
    try {
      return blockGoal(next, reason);
    } catch (err) {
      return `Error: ${errMessage(err)}`;
    }
  }
  if (patch.status === 'complete') return completeGoal(next);
  if (patch.status === 'paused') return pauseGoal(next);
  // `active`: resume, which refuses to revive a completed goal (its objective was
  // achieved; a new goal is the honest answer, not a re-run).
  try {
    return resumeGoal(next);
  } catch (err) {
    return `Error: ${errMessage(err)}`;
  }
}

/**
 * The goal tools. `create_goal` starts one; `update_goal` changes the goal in
 * force (progress, completion, blocking, or editing the objective).
 * @param options - the live-goal reader and the log writer.
 * @returns the plugin.
 */
export function goalPlugin(options: GoalPluginOptions): Plugin {
  /**
   * Persist a new goal value and answer the model with it.
   *
   * The log write is the WHOLE point: `c.emit` takes a session event, and
   * `goal/change` is the log-only one that carries the complete goal — the same
   * mechanism `todo_write` uses. The kernel's log-watch turns it into the `goal`
   * event every surface listens for, so this single call both durably records the
   * goal and moves the panel.
   */
  const commit = async (goal: Goal | null, emit: ToolExecuteContext['emit']): Promise<string> => {
    if (emit === undefined) return 'Error: 本会话无法持久化目标（没有可写的会话日志）。';
    await emit({ type: 'goal/change', goal, at: Date.now() });
    return goal === null ? 'Goal cleared.' : render(goal);
  };

  return {
    name: 'goal',
    description: '维护跨轮持续的目标，并在预算内自动继续推进。',
    manifest: { title: '长期目标', description: '维护跨轮的持续目标并在预算内自动续做。', tier: 'standard' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(ctx, {
        name: 'create_goal',
        description:
          'Starts a durable goal the session keeps working toward across runs. Use it when the user states an objective that will not fit in one run. Args: objective (required), maxRounds (optional, 1..100, default 10).',
        // Same rule as todo_write: the goal is THIS conversation's; a nested
        // run must not create one on the parent's behalf. See `nestedToolset`.
        ownsSessionState: true,
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: 'The completion condition, stated concretely.' },
            maxRounds: { type: 'integer', description: 'Maximum continuation rounds (1..100).' },
          },
          required: ['objective'],
          additionalProperties: false,
        },
        async execute(args, c) {
          const objective = args['objective'];
          if (typeof objective !== 'string' || objective.trim().length === 0) {
            return 'Error: objective must be a non-empty string';
          }
          const rawMax = args['maxRounds'];
          if (rawMax !== undefined && (typeof rawMax !== 'number' || !Number.isSafeInteger(rawMax))) {
            return 'Error: maxRounds must be an integer';
          }
          try {
            const goal = createGoal(objective, rawMax === undefined ? {} : { maxRounds: rawMax });
            return await commit(goal, c.emit);
          } catch (err) {
            return `Error: ${errMessage(err)}`;
          }
        },
        presentResult() {
          return { card: 'plan', items: [] };
        },
        isConcurrencySafe() {
          return true;
        },
      }, 'read');

      registerTool(ctx, {
        name: 'update_goal',
        description:
          'Updates the current goal: record progress, mark it complete or blocked, pause/resume it, or edit its objective. Args: objective?, status? ("active" | "paused" | "blocked" | "complete"), blockedReason? (required when blocking), maxRounds?. Mark complete only with evidence the whole objective is achieved; mark blocked only when the same concrete condition has persisted.',
        ownsSessionState: true,
        parameters: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: 'Replacement objective (a completed goal is replaced by a new one).' },
            status: { type: 'string', enum: [...STATUSES] },
            blockedReason: { type: 'string', description: 'Required when status is "blocked".' },
            maxRounds: { type: 'integer', description: 'New continuation budget (1..100).' },
          },
          additionalProperties: false,
        },
        async execute(args, c) {
          const goal = options.current();
          if (goal === null) {
            return c.emit === undefined
              ? 'Error: 本会话无法持久化目标（没有可写的会话日志）。'
              : 'Error: there is no goal in force. Create one with create_goal first.';
          }
          const patch: GoalPatch = {};
          if (args['objective'] !== undefined) {
            if (typeof args['objective'] !== 'string') return 'Error: objective must be a string';
            patch.objective = args['objective'];
          }
          if (args['blockedReason'] !== undefined) {
            if (typeof args['blockedReason'] !== 'string') return 'Error: blockedReason must be a string';
            patch.blockedReason = args['blockedReason'];
          }
          if (args['maxRounds'] !== undefined) {
            if (typeof args['maxRounds'] !== 'number' || !Number.isSafeInteger(args['maxRounds'])) {
              return 'Error: maxRounds must be an integer';
            }
            patch.maxRounds = args['maxRounds'];
          }
          if (args['status'] !== undefined) {
            const status = parseStatus(args['status']);
            if (status === undefined) return `Error: status must be one of ${STATUSES.join(', ')}`;
            patch.status = status;
          }
          const next = applyPatch(goal, patch);
          if (typeof next === 'string') return next;
          return commit(next, c.emit);
        },
        presentResult() {
          return { card: 'plan', items: [] };
        },
        isConcurrencySafe() {
          return true;
        },
      }, 'read');

      /**
       * The continuation: one temporary user message on the request being built.
       *
       * Placed BEFORE any other tail the session adds (the hook chain runs in
       * registration order and the job notice is appended later by the session),
       * so a finished-job notice stays the last thing the model reads.
       *
       * `rounds` advances HERE and only here, and the write goes through
       * `options.write` so the log records the admitted round — the prompt the
       * model reads and the count a resumed session restores come from the same
       * value.
       */
      ctx.on(beforeLlmCall, async (req, next) => {
        const goal = options.current();
        if (goal === null || !goalIsActive(goal)) return next();
        if (goalExhausted(goal)) {
          // The budget is spent and the goal is still active: block it once, with
          // the concrete condition, instead of silently continuing forever or
          // silently stopping (which would look like the goal was achieved).
          await options.write(
            blockGoal(goal, `已达到继续轮次上限（${String(goal.maxRounds)} 轮），需要人工确认目标是否完成或调整预算。`),
          );
          return next();
        }
        const round = goal.rounds + 1;
        await options.write(advanceGoal(goal, Date.now()));
        // `next(rewritten)` is how a plain transformer composes in a waterfall:
        // downstream hooks see the request WITH this round's message, and their
        // answer is what comes back. Returning the rewritten request without
        // delegating would silently cut every later hook out of the chain.
        return next({
          ...req,
          messages: [
            ...req.messages,
            // The shape the job notice and the stale-plan nag build
            // (`core/agent/request.ts`): a real message value with its own id and
            // timestamp, so downstream assembly treats it exactly like the other
            // ephemeral tails.
            { id: newId('msg'), ts: Date.now(), role: 'user' as const, content: goalRoundPrompt(goal, round) },
          ],
        });
      });
    },
  };
}

/**
 * Render a goal for the model's tool result.
 * @param goal - the goal just stored.
 * @returns a one-block, readable summary.
 */
function render(goal: Goal): string {
  const lines = [
    `Goal ${goal.id} — ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Rounds: ${String(goal.rounds)}/${String(goal.maxRounds)}`,
  ];
  if (goal.blockedReason !== undefined) lines.push(`Blocked: ${goal.blockedReason}`);
  return lines.join('\n');
}
