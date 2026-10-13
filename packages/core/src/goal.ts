/**
 * The goal domain: one long-running objective a session keeps working toward
 * across rounds, and the pure rules that move it between states.
 *
 * Trimmed from deepseek-harness `goal/src/types.ts` + `domain.ts`: dsh carries a
 * compare-and-set `revision` because several writers (model tool, slash command,
 * host UI) race over the same durable record through a service. Nova has ONE
 * writer per mutation path and reads the current value before writing, so the
 * revision CAS is dropped rather than stubbed — a counter nobody checks is
 * worse than no counter. What is kept is the part that carries meaning: the
 * four-state lifecycle, the admitted-round budget, and the rule that a blocked
 * goal must name the condition that blocks it.
 *
 * Pure functions, zero IO, no imports beyond the id generator: the goal can be
 * unit-tested from a value and replayed from the session log (see
 * `Session.latestGoal`), which is what makes the durable snapshot and the live
 * panel two readings of one fact.
 */
import { newId } from './ids.js';

/** Lifecycle state of a goal. `paused` and `blocked` are resumable; `complete` is terminal. */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';

/**
 * One durable goal. Every mutation produces a whole new value (the tool writes
 * the complete snapshot, last-write-wins — the same rule `todo_write` follows),
 * so a reader never has to replay deltas to know where the goal stands.
 */
export interface Goal {
  /** Stable identity, minted once at creation. */
  id: string;
  /** The completion objective, as the operator or the model stated it. */
  objective: string;
  status: GoalStatus;
  /**
   * Continuation rounds already admitted for this goal — one per run started
   * while the goal was active. Counted, not inferred: a resumed session reads
   * its real progress back from this field.
   */
  rounds: number;
  /** Hard cap on `rounds`. Reaching it blocks the goal instead of extending it. */
  maxRounds: number;
  createdAt: number;
  updatedAt: number;
  /** Present exactly while `status === 'blocked'`: the condition that blocks progress. */
  blockedReason?: string;
}

/**
 * Rounds a goal gets when the caller names none. dsh defaults to 256, which is
 * sized for an unattended harness; a session here is one person watching, and a
 * goal that silently kept starting runs 200 times would be a runaway, not
 * persistence.
 */
export const DEFAULT_MAX_GOAL_ROUNDS = 10;

/** Upper bound a caller may ask for. Beyond this the budget stops being a budget. */
export const MAX_GOAL_ROUNDS = 100;

export interface CreateGoalOptions {
  /** Injected by callers that own a clock (tests); defaults to `Date.now()`. */
  now?: number;
  /** Injected by callers that own the id space (tests); defaults to a fresh `goal_…` id. */
  id?: string;
  /** Overrides {@link DEFAULT_MAX_GOAL_ROUNDS}. */
  maxRounds?: number;
}

/**
 * Resolve a round cap, rejecting anything that could not be enforced.
 * @param value - the requested cap, or undefined for the default.
 * @returns the cap to store.
 */
export function resolveMaxRounds(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_GOAL_ROUNDS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GOAL_ROUNDS) {
    throw new Error(`goal maxRounds must be a positive integer no greater than ${String(MAX_GOAL_ROUNDS)}`);
  }
  return value;
}

/**
 * Validate and normalize an objective.
 * @param objective - the raw text.
 * @returns the trimmed objective.
 */
export function normalizeObjective(objective: string): string {
  const trimmed = objective.trim();
  if (trimmed.length === 0) throw new Error('goal objective must be a non-empty string');
  return trimmed;
}

/**
 * Create a goal. The creation is the operator's (or the model's) statement of
 * intent, never a continuation: `rounds` starts at 0.
 * @param objective - the completion objective.
 * @param opts - clock/id/round-cap overrides (see {@link CreateGoalOptions}).
 * @returns the new goal, with `status: 'active'`.
 */
export function createGoal(objective: string, opts: CreateGoalOptions = {}): Goal {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? newGoalId(),
    objective: normalizeObjective(objective),
    status: 'active',
    rounds: 0,
    maxRounds: resolveMaxRounds(opts.maxRounds),
    createdAt: now,
    updatedAt: now,
  };
}

/** Whether this goal may still receive automatic continuation rounds. */
export function goalIsActive(goal: Goal): boolean {
  return goal.status === 'active';
}

/** Whether the goal has spent its round budget. */
export function goalExhausted(goal: Goal): boolean {
  return goal.rounds >= goal.maxRounds;
}

/**
 * Admit one continuation round. Idempotence is the caller's: the admitted count
 * is what the next round prompt reports, so it must move exactly once per run.
 * @param goal - the goal as stored.
 * @param now - mutation timestamp.
 * @returns a new goal with one more admitted round.
 */
export function advanceGoal(goal: Goal, now: number = Date.now()): Goal {
  return { ...goal, rounds: goal.rounds + 1, updatedAt: now };
}

/**
 * Mark the objective achieved. Terminal: a later round must create a new goal.
 * @param goal - the goal as stored.
 * @param now - mutation timestamp.
 * @returns a new goal with `status: 'complete'`.
 */
export function completeGoal(goal: Goal, now: number = Date.now()): Goal {
  const { blockedReason: _dropped, ...rest } = goal;
  return { ...rest, status: 'complete', updatedAt: now };
}

/**
 * Mark the goal blocked. The reason is mandatory and must name the concrete
 * condition: "difficulty" is not a blocker, it is work.
 * @param goal - the goal as stored.
 * @param reason - the condition that persists across rounds and blocks progress.
 * @param now - mutation timestamp.
 * @returns a new goal with `status: 'blocked'` and its reason.
 */
export function blockGoal(goal: Goal, reason: string, now: number = Date.now()): Goal {
  const trimmed = reason.trim();
  if (trimmed.length === 0) throw new Error('a blocked goal must state the condition that blocks it');
  return { ...goal, status: 'blocked', blockedReason: trimmed, updatedAt: now };
}

/**
 * Suspend automatic continuation without losing progress or intent.
 * @param goal - the goal as stored.
 * @param now - mutation timestamp.
 * @returns a new goal with `status: 'paused'`.
 */
export function pauseGoal(goal: Goal, now: number = Date.now()): Goal {
  const { blockedReason: _dropped, ...rest } = goal;
  return { ...rest, status: 'paused', updatedAt: now };
}

/**
 * Re-arm a paused or blocked goal. A completed goal is NOT resumable: its
 * objective was achieved, and reviving it would make `complete` meaningless.
 * @param goal - the goal as stored.
 * @param now - mutation timestamp.
 * @returns a new goal with `status: 'active'`.
 */
export function resumeGoal(goal: Goal, now: number = Date.now()): Goal {
  if (goal.status === 'complete') throw new Error('a completed goal cannot be resumed; create a new goal instead');
  const { blockedReason: _dropped, ...rest } = goal;
  return { ...rest, status: 'active', updatedAt: now };
}

/**
 * Replace the objective in place. A completed goal is replaced by a new goal
 * instead (see `update_goal`), because its round counter describes the old work.
 * @param goal - the goal as stored.
 * @param objective - the replacement objective.
 * @param now - mutation timestamp.
 * @returns a new goal with the replacement objective.
 */
export function editGoal(goal: Goal, objective: string, now: number = Date.now()): Goal {
  return { ...goal, objective: normalizeObjective(objective), updatedAt: now };
}

/**
 * The model-visible continuation prompt for one admitted round.
 *
 * Rendered from the goal value alone (no host state), so the round the model
 * reads is exactly the round the log recorded. Wording follows dsh's
 * `goal-round-driver/src/prompt.ts`: state the objective and the budget, tell
 * the model to re-inspect reality instead of trusting its earlier narration,
 * and make completion an evidence question rather than a tone of voice.
 * @param goal - the active goal being continued.
 * @param round - the positive round number this prompt admits.
 * @returns the prompt text.
 */
export function goalRoundPrompt(goal: Goal, round: number): string {
  return [
    '<goal_round>',
    `Objective: ${JSON.stringify(goal.objective)}`,
    `Round: ${String(round)}/${String(goal.maxRounds)}`,
    '',
    'Continue working toward the objective in this same session. Treat the current workspace, tool',
    'results and durable session state as authoritative; inspect them instead of assuming earlier',
    'narration is still current. Make concrete progress and verify the result. Before claiming',
    'completion, gather evidence that the whole objective is achieved and mark the goal complete with',
    'update_goal. If work remains, keep going — the goal stays active for the next round. Report a',
    'blocker only when the same concrete condition has persisted and you cannot work around it.',
    '</goal_round>',
  ].join('\n');
}

/**
 * Mint a goal id. Prefixed (not a bare uuid) so a log reader can tell a goal id
 * from a message or call id at a glance.
 * @returns the new id.
 */
export function newGoalId(): string {
  return newId('goal');
}
