/**
 * The Run lifecycle (`runtime/run.ts`).
 *
 * Asserted because the run state machine REPLACED a boolean: `agent.running`
 * used to be `runController !== undefined`, which forgot a run the moment it
 * ended. The contract is "one identity + one terminal state", and these tests
 * pin the transitions that make it so — not the wording of any error.
 */
import { describe, expect, it } from 'vitest';
import { Run, beginRun, isRunActive } from '../src/runtime/run.js';

describe('Run lifecycle', () => {
  it('mints an identity and starts in `created`', () => {
    const run = new Run('sess-1', 'run-1');
    expect(run.id).toBe('run-1');
    expect(run.sessionId).toBe('sess-1');
    expect(run.state).toBe('created');
    expect(run.active).toBe(true);
  });

  it('goes created → running → completed', () => {
    const run = new Run('s', 'r');
    run.start();
    expect(run.state).toBe('running');
    run.settle('completed');
    expect(run.state).toBe('completed');
    expect(run.active).toBe(false);
  });

  it('keeps the FIRST terminal outcome when settle runs twice', () => {
    // The loop's `finally` may settle after an earlier settle; a failure must
    // not be relabelled as a plain cancellation by the order of those two.
    const run = new Run('s', 'r');
    run.start();
    run.settle('failed');
    run.settle('completed');
    expect(run.state).toBe('failed');
  });

  it('cancels only from `running`, and a settled run never moves again', () => {
    const run = new Run('s', 'r');
    run.cancel(); // still `created`: no transition
    expect(run.state).toBe('created');
    run.start();
    run.cancel();
    expect(run.state).toBe('cancelling');
    expect(run.active).toBe(true);
    run.settle('cancelled');
    expect(run.state).toBe('cancelled');
  });

  it('refuses to start a run that already settled', () => {
    const run = new Run('s', 'r');
    run.start();
    run.settle('completed');
    expect(() => run.start()).toThrow();
  });

  it('beginRun mints a fresh id per run and starts it', () => {
    const a = beginRun('sess');
    const b = beginRun('sess');
    expect(a.state).toBe('running');
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('run_')).toBe(true);
  });

  it('isRunActive is false for every terminal state', () => {
    expect(isRunActive('created')).toBe(true);
    expect(isRunActive('running')).toBe(true);
    expect(isRunActive('cancelling')).toBe(true);
    expect(isRunActive('completed')).toBe(false);
    expect(isRunActive('failed')).toBe(false);
    expect(isRunActive('cancelled')).toBe(false);
  });
});
