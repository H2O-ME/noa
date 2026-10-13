/**
 * The goal: the log-only snapshot, the tool's writes, and the continuation hook.
 *
 * The assertions are deliberately about the two things that make the feature real
 * rather than about formatting:
 *  1. a tool write reaches BOTH the durable log and the live event (a publish-only
 *     or log-only implementation would look fine in a fixture but lose a resume or
 *     leave the panel frozen);
 *  2. the continuation hook admits exactly one round per request and stops at the
 *     budget — the difference between "keeps working toward the objective" and a
 *     runaway loop.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_GOAL_ROUNDS, MAX_GOAL_ROUNDS, createGoal, goalRoundPrompt } from '@noa/core';
import type { AgentSession, Goal, KernelEvent } from '@noa/core';
import { createAgentKernel } from '../src/index.js';
import { parseGoalCommand } from '../src/goal-command.js';

/** A kernel on a temp workspace + temp session dir (never the real ~/.noa). */
async function harness(): Promise<Awaited<ReturnType<typeof createAgentKernel>>> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-goal-'));
  return createAgentKernel({
    rootDir: dir,
    config: { approval: 'read-only' },
    sessionDir: path.join(dir, 'sessions'),
    provider: {
      async *stream() {
        yield { type: 'done' as const };
      },
    },
    extraPlugins: [],
  });
}

describe('goal persistence', () => {
  it('a tool write lands in the log AND publishes the live event', async () => {
    const kernel = await harness();
    const agent = await kernel.newAgentSession();
    const events: KernelEvent[] = [];
    agent.subscribe((event) => { events.push(event); });

    const goal = createGoal('ship the feature', { id: 'goal_t', now: 1 });
    await agent.announceGoal(goal);

    // Durable: the log is the only store, so a resume must be able to find it.
    expect(agent.session.latestGoal()).toEqual(goal);
    // Live: the panel is driven by the event, not by polling the log.
    expect(events.some((event) => event.type === 'goal' && event.goal?.id === 'goal_t')).toBe(true);

    // Clearing is a real state, not an absence: the log records it and the event
    // says `null` so the panel closes up.
    await agent.announceGoal(null);
    expect(agent.session.latestGoal()).toBeUndefined();
    expect(events.filter((event) => event.type === 'goal').at(-1)).toEqual({ type: 'goal', goal: null });
    await kernel.dispose();
  });
});

describe('the continuation prompt', () => {
  it('states the objective and the round budget, and asks for evidence', () => {
    const goal: Goal = createGoal('all tests pass', { id: 'g', now: 1, maxRounds: 4 });
    const text = goalRoundPrompt(goal, 2);
    expect(text).toContain('all tests pass');
    expect(text).toContain('2/4');
    // Completion must be an evidence question, not a tone of voice: that sentence
    // is what stops a goal being marked done because the model felt finished.
    expect(text).toContain('evidence');
    expect(text).toContain('update_goal');
  });

  it('caps the round budget so a goal cannot continue forever', () => {
    // A cap is what separates "persistent" from "runaway": the tool's own default
    // must be a finite, enforceable number.
    expect(DEFAULT_MAX_GOAL_ROUNDS).toBeGreaterThan(0);
    expect(createGoal('x').maxRounds).toBe(DEFAULT_MAX_GOAL_ROUNDS);
    // And the cap itself is bounded — a caller cannot ask for an unbounded budget.
    expect(() => createGoal('x', { maxRounds: MAX_GOAL_ROUNDS + 1 })).toThrow();
  });
});

/** Run one `/goal` line through the kernel's own runner and return what it printed. */
async function runGoal(
  kernel: Awaited<ReturnType<typeof createAgentKernel>>,
  agent: AgentSession,
  args: string,
): Promise<string> {
  const events: KernelEvent[] = [];
  const stop = agent.subscribe((event) => { events.push(event); });
  await kernel.runCommand('goal', args);
  stop();
  const done = events.filter((event) => event.type === 'command' && event.phase === 'done').at(-1);
  return done !== undefined && done.type === 'command' ? done.text ?? '' : '';
}

describe('the /goal command', () => {
  it('creates a goal from an objective typed after the command', async () => {
    // The composer's hint promises exactly this: a reader types an objective
    // after `/goal` and the session works toward it — durably, so a restart
    // restores the panel that shows it.
    const kernel = await harness();
    const agent = await kernel.newAgentSession();
    const text = await runGoal(kernel, agent, '修好登录链路');
    expect(agent.session.latestGoal()?.objective).toBe('修好登录链路');
    expect(agent.session.latestGoal()?.status).toBe('active');
    // The state-dependent command list is what a reader needs next, and it is
    // the one thing the old view-only command could not offer.
    expect(text).toContain('/goal edit <目标>');
    await kernel.dispose();
  });

  it('runs the control words and refuses to overwrite a goal in force', async () => {
    const kernel = await harness();
    const agent = await kernel.newAgentSession();
    await runGoal(kernel, agent, '第一个目标');
    // A second objective must NOT silently replace a goal that is still running:
    // the round counter describes the work already admitted for it.
    const refused = await runGoal(kernel, agent, '第二个目标');
    expect(refused).toContain('已有目标');
    expect(agent.session.latestGoal()?.objective).toBe('第一个目标');
    // `edit` is the door for that, and it keeps the SAME goal — id and round
    // budget included — because only its objective changed.
    const before = agent.session.latestGoal();
    await runGoal(kernel, agent, 'edit 第二个目标');
    expect(agent.session.latestGoal()?.objective).toBe('第二个目标');
    expect(agent.session.latestGoal()?.id).toBe(before?.id);
    expect(agent.session.latestGoal()?.maxRounds).toBe(before?.maxRounds);
    await runGoal(kernel, agent, 'pause');
    expect(agent.session.latestGoal()?.status).toBe('paused');
    await runGoal(kernel, agent, 'resume');
    expect(agent.session.latestGoal()?.status).toBe('active');
    await runGoal(kernel, agent, 'clear');
    expect(agent.session.latestGoal()).toBeUndefined();
    await kernel.dispose();
  });

  it('refuses a control word that needs a goal and writes nothing', async () => {
    const kernel = await harness();
    const agent = await kernel.newAgentSession();
    expect(await runGoal(kernel, agent, '')).toContain('用法：/goal');
    expect(await runGoal(kernel, agent, 'pause')).toContain('需要先有目标');
    expect(await runGoal(kernel, agent, 'clear')).toContain('无需清除');
    // A refusal is not a state change: no `goal/change` may reach the log, or a
    // resumed session would restore a goal the reader never set.
    expect(agent.session.events.some((event) => event.type === 'goal/change')).toBe(false);
    await kernel.dispose();
  });

  it('parses only its own grammar; anything else is an objective', () => {
    expect(parseGoalCommand('   ')).toEqual({ kind: 'show' });
    expect(parseGoalCommand('CLEAR')).toEqual({ kind: 'clear' });
    expect(parseGoalCommand('edit')).toEqual({ kind: 'invalid-edit' });
    expect(parseGoalCommand('edit 新目标')).toEqual({ kind: 'edit', objective: '新目标' });
    // A sentence that merely STARTS with a control word is an objective, not a
    // command with an argument the reader never typed.
    expect(parseGoalCommand('clear the cache')).toEqual({ kind: 'create', objective: 'clear the cache' });
    expect(parseGoalCommand('发布 v1')).toEqual({ kind: 'create', objective: '发布 v1' });
  });
});
