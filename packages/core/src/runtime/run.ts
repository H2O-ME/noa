/**
 * A Run: ONE invocation of the agent loop inside a session.
 *
 * Session ≠ Run (`NOVA-GENERALIST.md` §2.1). A session is the durable
 * conversation; a run is one execution of it. The distinction used to be
 * implicit — the session held an `AbortController` and callers asked
 * `agent.running`, a boolean that forgot a run the moment it ended. A Run keeps
 * its identity and its terminal state, so a consumer can tell "never ran",
 * "running" and "the last run failed" apart — three questions the boolean could
 * not answer.
 *
 * `id` is minted HERE rather than inside `runAgent`, so the loop no longer
 * invents a run the session does not know about (`agent/loop.ts` used to cast a
 * fresh `runId` on every entry). The run also OWNS its `ExecutionScope`: built
 * once from this identity, read by every tool call, never re-derived. The
 * protocol frame that carries the id downstream lands with G1d.
 */
import { newId } from '../ids.js';
import type { ExecutionScope } from '../types.js';

/** Where a run is in its lifecycle. Terminal states never transition again. */
export type RunState = 'created' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

/** The outcomes {@link Run.settle} accepts. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled';

const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>(['completed', 'failed', 'cancelled']);

/** Whether a run in this state is still in flight (not yet terminal). */
export function isRunActive(state: RunState): boolean {
  return !TERMINAL_STATES.has(state);
}

/**
 * One execution of the agent loop.
 *
 * Mutable by design: the run IS a state machine, and the loop drives it in
 * place. Transitions are guarded so a mis-sequenced call is a loud error rather
 * than a silently relabelled outcome — `settle` is the one exception, because
 * the loop's `finally` may run after an earlier settle and a failure must never
 * be downgraded to a plain cancellation by the order of those two.
 */
export class Run {
  /** The run's identity (`runId`), stable across every tool call it issues. */
  readonly id: string;
  /** The session this run belongs to. */
  readonly sessionId: string;
  /**
   * WHO and WHICH RUN this execution belongs to, built once here and handed to
   * the loop verbatim. One owner because the alternative — three loose fields on
   * `AgentOptions`, re-projected into a scope object at each tool call — put the
   * same fact in two shapes and gave the next field a fourth place to be added.
   */
  readonly scope: ExecutionScope;
  private current: RunState = 'created';

  constructor(sessionId: string, id: string, principal?: string) {
    this.sessionId = sessionId;
    this.id = id;
    this.scope = {
      sessionId,
      runId: id,
      ...(principal !== undefined ? { principal } : {}),
    };
  }

  get state(): RunState {
    return this.current;
  }

  /** Still in flight: `created`, `running` or `cancelling`. */
  get active(): boolean {
    return isRunActive(this.current);
  }

  /** created → running: the loop is about to issue its first request. */
  start(): void {
    this.moveTo('running');
  }

  /** running → cancelling: the abort signal fired; the run is unwinding. */
  cancel(): void {
    if (this.current === 'running') this.moveTo('cancelling');
  }

  /**
   * → a terminal state. Idempotent: a run that already settled keeps its first
   * outcome (see the class note), so a `finally` racing an earlier settle
   * cannot relabel it.
   */
  settle(outcome: RunOutcome): void {
    if (!this.active) return;
    this.current = outcome;
  }

  private moveTo(next: RunState): void {
    if (!this.active) throw new Error(`run ${this.id} already settled as ${this.current}`);
    this.current = next;
  }
}

/** Mint a run for a session and move it to `running` in one step. */
export function beginRun(sessionId: string, principal?: string): Run {
  const run = new Run(sessionId, newId('run'), principal);
  run.start();
  return run;
}
