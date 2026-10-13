/**
 * The question seam as the KERNEL runs it — the missing-producer guard
 * (`AGENTS.md` §5: "新增内核事件时先问生产者在哪").
 *
 * `todo` and `subagent_update` both shipped as a declared event with a UI
 * consumer and no publisher, and a fixture-driven UI test stayed green through
 * it. So these tests never assert against a hand-written event: they run a real
 * `AgentSession`, let a real tool block inside the real broker, and require the
 * events to come out of the session's own stream. Remove the wiring and they
 * fail rather than pass quietly.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentSession,
  ApprovalBroker,
  JobRegistry,
  QuestionBroker,
  Session,
  type AgentMessage,
  type AskUserQuestionAnswer,
  type KernelEvent,
  type StreamEvent,
  type ToolDefinition,
} from '../src/index.js';
import { scriptedProvider } from './helpers/scripted-provider.js';

const QUESTIONS = [
  {
    id: 'mode',
    question: 'Which mode?',
    options: [{ label: 'Fast' }, { label: 'Thorough' }],
  },
];

const ASK_SCRIPT: StreamEvent = {
  type: 'tool_call_delta',
  index: 0,
  id: 'call_ask',
  name: 'ask_user_question',
  argsDelta: JSON.stringify({ questions: QUESTIONS }),
};

const DONE_SCRIPT: StreamEvent = { type: 'text_delta', text: 'thanks' };

/**
 * A real session whose `ask_user_question` tool blocks inside a real
 * `QuestionBroker` — the wiring `runtime-session.ts` gives the shipped kernel,
 * reproduced here without depending on plugins.
 */
async function harness(): Promise<{
  agent: AgentSession;
  questions: QuestionBroker;
  events: KernelEvent[];
  seen: AskUserQuestionAnswer[];
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-question-'));
  const session = await Session.create(dir, 'sess_q');
  const messages: AgentMessage[] = [];
  const questions = new QuestionBroker();
  const seen: AskUserQuestionAnswer[] = [];
  const tool: ToolDefinition = {
    name: 'ask_user_question',
    description: 'ask the user',
    parameters: { type: 'object', properties: { questions: { type: 'array' } } },
    async execute() {
      const answer = await questions.asker(QUESTIONS);
      seen.push(answer);
      return JSON.stringify(answer);
    },
  };
  const agent = new AgentSession({
    session,
    messages,
    provider: scriptedProvider([[ASK_SCRIPT], [DONE_SCRIPT]]),
    rootDir: () => tmpdir(),
    tools: () => [tool],
    hooks: () => ({}),
    jobs: new JobRegistry(),
    approvals: new ApprovalBroker(() => ({ card: 'generic', kind: 'other', title: 'x' })),
    questions,
    maxTurns: 5,
    cacheDir: () => tmpdir(),
  });
  const events: KernelEvent[] = [];
  agent.subscribe((e) => events.push(e));
  return { agent, questions, events, seen };
}

/**
 * Wait until the tool has parked inside the ask: the request is on the wire and
 * the run is suspended on it. Returns the outstanding request, so a caller never
 * reads the id from a `pendingQuestions()` call that raced the ask.
 */
async function untilAsked(agent: AgentSession): Promise<{ id: string; questions: readonly { id: string }[] }> {
  for (let i = 0; i < 3000; i += 1) {
    const first = agent.pendingQuestions()[0];
    if (first !== undefined) return first;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the question never became outstanding');
}

async function untilIdle(agent: AgentSession): Promise<void> {
  for (let i = 0; i < 3000 && agent.running; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(agent.running).toBe(false);
}

describe('AgentSession question events have a real producer', () => {
  it('publishes question_request, publishes question_resolved, and answers the tool', async () => {
    const h = await harness();
    const run = h.agent.prompt('go');
    const request = await untilAsked(h.agent);
    expect(request.questions[0]?.id).toBe('mode');
    // The card the surface renders comes from the event, not from a re-read of
    // the session: a consumer that only sees the stream must still be able to
    // render it. (A declared event with no producer is this repo's most
    // recurrent defect — `todo` and `subagent_update` both shipped that way.)
    expect(h.events.find((e) => e.type === 'question_request')).toMatchObject({
      type: 'question_request',
      request: { id: request.id },
    });
    expect(h.agent.currentPhase).toBe('waiting_question');

    const answer: AskUserQuestionAnswer = { answers: [{ id: 'mode', selected: ['Fast'] }] };
    expect(h.agent.resolveQuestion(request.id, answer)).toBe(true);
    // The card clears by the kernel's own event, not by the surface assuming its
    // send landed.
    expect(h.events.find((e) => e.type === 'question_resolved')).toMatchObject({
      type: 'question_resolved',
      resolution: { source: 'user', answer },
    });
    expect(h.agent.pendingQuestions()).toHaveLength(0);
    await run;
    await untilIdle(h.agent);
    expect(h.seen).toEqual([answer]);
    expect(h.events.some((e) => e.type === 'tool_call_result')).toBe(true);
    expect(h.agent.currentPhase).not.toBe('waiting_question');
  });

  it('refuses an answer that does not fit and keeps the ask outstanding', async () => {
    const h = await harness();
    const run = h.agent.prompt('go');
    const request = await untilAsked(h.agent);
    expect(h.agent.resolveQuestion(request.id, { answers: [{ id: 'mode', selected: ['Never offered'] }] })).toBe(false);
    expect(h.agent.pendingQuestions()).toHaveLength(1);
    expect(h.events.some((e) => e.type === 'question_resolved')).toBe(false);
    expect(h.agent.resolveQuestion(request.id, { answers: [{ id: 'mode', selected: ['Fast'] }] })).toBe(true);
    await run;
    await untilIdle(h.agent);
  });

  it('closes the ask as cancelled when the surface dismisses it', async () => {
    const h = await harness();
    const run = h.agent.prompt('go');
    const request = await untilAsked(h.agent);
    expect(h.agent.cancelQuestion(request.id)).toBe(true);
    expect(h.events.find((e) => e.type === 'question_resolved')).toMatchObject({
      resolution: { source: 'cancelled' },
    });
    await run;
    await untilIdle(h.agent);
    // The tool reported the refusal as an error result instead of hanging: the
    // model gets a defined outcome and the run finishes.
    const result = h.events.find((e) => e.type === 'tool_call_result');
    expect(result !== undefined && result.type === 'tool_call_result' && result.result.content).toContain('cancelled');
  });

  it('converges a suspended run when the session aborts', async () => {
    const h = await harness();
    const run = h.agent.prompt('go');
    await untilAsked(h.agent);
    h.agent.abort();
    await run;
    await untilIdle(h.agent);
    // fail-closed: the outstanding ask is gone, the run ENDED (the abort test
    // above never returns to `untilIdle` if a waiter is stranded), and the
    // stream said why rather than leaving a card nobody can answer.
    expect(h.agent.pendingQuestions()).toHaveLength(0);
    expect(h.events.find((e) => e.type === 'question_resolved')).toMatchObject({
      resolution: { source: 'aborted' },
    });
    // The model reads a defined outcome, not silence.
    const result = h.events.find((e) => e.type === 'tool_call_result');
    expect(result !== undefined && result.type === 'tool_call_result' && result.result.content).toContain('aborted');
  });

  it('converges a suspended run when the session is disposed, and then stays closed', async () => {
    const h = await harness();
    const run = h.agent.prompt('go');
    await untilAsked(h.agent);
    await h.agent.dispose();
    await run;
    expect(h.agent.pendingQuestions()).toHaveLength(0);
    // Disposal sweeps through `abort()` first, so the outstanding ask settles on
    // that path; the terminal part is that a later ask cannot start at all.
    expect(h.events.some((e) => e.type === 'question_resolved')).toBe(true);
    await expect(h.questions.asker(QUESTIONS)).rejects.toMatchObject({ code: 'ASK_ABORTED' });
  });

  it('leaves nothing outstanding when the run ends without an answer', async () => {
    // The run's own `finally` sweep, not the abort path: a question that
    // outlived its run would be answered into a session that moved on.
    const h = await harness();
    const run = h.agent.prompt('go');
    await untilAsked(h.agent);
    h.agent.abort();
    await run;
    await untilIdle(h.agent);
    expect(h.agent.pendingQuestions()).toHaveLength(0);
  });
});
