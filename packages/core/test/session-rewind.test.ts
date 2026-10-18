/**
 * 会话回退：切点在哪（纯函数），以及回退之后**活的模型面**与**重放的投影**是否一致。
 *
 * 这个文件真正在钉的是一条不变量：回退是**遮蔽**而不是删除。日志留着一轮，模型
 * 不再看到它；两者一旦不一致，重启就会把刚被收回的轮次悄悄复活——所以每条用例都
 * 同时读 `agent.messages`（活的那份）与 `session.deriveMessages()`（重放出来的那份）。
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentSession,
  ApprovalBroker,
  COMPACT_SUMMARY_PREFIX,
  JobRegistry,
  QuestionBroker,
  Session,
  TURN_ABORTED_GUIDANCE,
  planTurnRewind,
  type AgentMessage,
  type ChatProvider,
  type StreamEvent,
} from '../src/index.js';
import { scriptedProvider } from './helpers/scripted-provider.js';

const user = (id: string, content: string): AgentMessage => ({ id, ts: 0, role: 'user', content });
const assistant = (id: string, content: string): AgentMessage => ({ id, ts: 0, role: 'assistant', content });
const call = (id: string, callId: string): AgentMessage => ({
  id,
  ts: 0,
  role: 'assistant',
  content: '',
  toolCalls: [{ id: callId, name: 't', args: {}, rawArgs: '{}' }],
});
const result = (id: string, callId: string): AgentMessage => ({
  id,
  ts: 0,
  role: 'tool',
  toolCallId: callId,
  name: 't',
  content: 'r',
});

describe('planTurnRewind', () => {
  it('cuts at the opening user message of the last n turns', () => {
    const messages = [user('u1', 'a'), assistant('a1', 'A'), user('u2', 'b'), assistant('a2', 'B')];
    const plan = planTurnRewind(messages, 1);
    expect(plan?.keepIds).toEqual(['u1', 'a1']);
    expect(plan?.dropped).toBe(1);
    // The dropped turn's prompt is what `/retry` says again.
    expect(plan?.prompt.id).toBe('u2');
    expect(plan?.prompt.content).toBe('b');
  });

  it('takes the whole response subtree with the turn, never an orphan tool result', () => {
    // The balanced-subtree rule: a tool result must not outlive the assistant
    // message that asked for it, or a strict provider rejects the surface.
    const messages = [user('u1', 'go'), call('a1', 'c1'), result('t1', 'c1'), assistant('a2', 'done')];
    const plan = planTurnRewind(messages, 1);
    expect(plan?.keepIds).toEqual([]);
    expect(plan?.prompt.id).toBe('u1');
  });

  it('counts turns by USER prompts, not by messages', () => {
    const messages = [user('u1', 'a'), call('a1', 'c1'), result('t1', 'c1'), user('u2', 'b'), assistant('a2', 'B')];
    expect(planTurnRewind(messages, 1)?.keepIds).toEqual(['u1', 'a1', 't1']);
    expect(planTurnRewind(messages, 2)?.keepIds).toEqual([]);
  });

  it('never treats scaffolding as a turn boundary', () => {
    // A context fragment, a compaction summary and an abort marker are all
    // `user`-role messages that do NOT open a turn: cutting at one would slice
    // through the subtree that has to move with the real turn.
    const messages: AgentMessage[] = [
      { id: 'msg_ctx_1', ts: 0, role: 'user', content: '<environment>project</environment>' },
      user('u1', 'a'),
      assistant('a1', 'A'),
      { id: 'abort', ts: 0, role: 'user', content: TURN_ABORTED_GUIDANCE },
    ];
    const plan = planTurnRewind(messages, 1);
    // The cut lands at u1 (the only real turn), so the fragment survives.
    expect(plan?.keepIds).toEqual(['msg_ctx_1']);
    expect(plan?.prompt.id).toBe('u1');
  });

  it('treats a compaction summary as scaffolding, not as a turn', () => {
    const messages: AgentMessage[] = [
      { id: 'msg_compact_1', ts: 0, role: 'user', content: `${COMPACT_SUMMARY_PREFIX}\nold` },
      user('u1', 'a'),
      assistant('a1', 'A'),
    ];
    const plan = planTurnRewind(messages, 1);
    expect(plan?.keepIds).toEqual(['msg_compact_1']);
    expect(plan?.dropped).toBe(1);
  });

  it('clamps to what exists instead of refusing', () => {
    const messages = [user('u1', 'a'), assistant('a1', 'A'), user('u2', 'b'), assistant('a2', 'B')];
    const plan = planTurnRewind(messages, 99);
    expect(plan?.keepIds).toEqual([]);
    expect(plan?.dropped).toBe(2);
  });

  it('reports nothing to drop when there is no turn', () => {
    expect(planTurnRewind([], 1)).toBeUndefined();
    expect(planTurnRewind([assistant('a1', 'A')], 1)).toBeUndefined();
    expect(planTurnRewind([user('u1', 'a')], 0)).toBeUndefined();
    expect(planTurnRewind([user('u1', 'a')], 1.5)).toBeUndefined();
  });
});

const REPLY = (text: string): StreamEvent[] => [
  { type: 'text_delta', text },
  { type: 'finish', finishReason: 'stop' },
];

async function makeAgent(scripts: StreamEvent[][]): Promise<AgentSession> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-rewind-'));
  const session = await Session.create(dir, 'sess_rewind');
  const messages: AgentMessage[] = [];
  const agent = new AgentSession({
    session,
    messages,
    provider: scriptedProvider(scripts) as ChatProvider,
    rootDir: () => tmpdir(),
    tools: () => [],
    hooks: () => ({}),
    jobs: new JobRegistry(),
    approvals: new ApprovalBroker(() => ({ card: 'generic', kind: 'other', title: 't' })),
    questions: new QuestionBroker(),
    maxTurns: 3,
    cacheDir: () => tmpdir(),
  });
  return agent;
}

async function untilIdle(agent: AgentSession): Promise<void> {
  for (let i = 0; i < 3000 && agent.running; i += 1) await new Promise((r) => setTimeout(r, 1));
  expect(agent.running).toBe(false);
}

describe('AgentSession.rewindTurns', () => {
  it('drops the turns from the live surface and the replay projection alike', async () => {
    const agent = await makeAgent([REPLY('first'), REPLY('second')]);
    await agent.prompt('one');
    await untilIdle(agent);
    await agent.prompt('two');
    await untilIdle(agent);
    expect(agent.messages.map((m) => m.content)).toEqual(['one', 'first', 'two', 'second']);

    const plan = await agent.rewindTurns(1);
    expect(plan?.dropped).toBe(1);
    expect(agent.messages.map((m) => m.content)).toEqual(['one', 'first']);
    // The invariant that makes this a rewind and not a deletion: a resume
    // rebuilds the SAME surface, because the log still holds the dropped turn.
    expect(agent.session.deriveMessages().map((m) => m.id)).toEqual(agent.messages.map((m) => m.id));
    expect(agent.session.allMessages().map((m) => m.content)).toEqual(['one', 'first', 'two', 'second']);
  });

  it('is durable: the event is what the projection reads, not the in-memory splice', async () => {
    const agent = await makeAgent([REPLY('first'), REPLY('second')]);
    await agent.prompt('one');
    await untilIdle(agent);
    await agent.prompt('two');
    await untilIdle(agent);
    await agent.rewindTurns(2);
    expect(agent.session.deriveMessages()).toEqual([]);

    // Reopen the file: the surface comes from the log alone.
    const reopened = await Session.open(agent.session.file);
    expect(reopened.deriveMessages()).toEqual([]);
    // ...and the dropped turns are still auditable.
    expect(reopened.allMessages()).toHaveLength(4);
  });

  it('returns undefined when there is no turn to drop', async () => {
    const agent = await makeAgent([REPLY('x')]);
    expect(await agent.rewindTurns(1)).toBeUndefined();
  });

  it('refuses while a run is in flight rather than splicing under it', async () => {
    const agent = await makeAgent([REPLY('first'), REPLY('second')]);
    await agent.prompt('one');
    await untilIdle(agent);
    await agent.prompt('two');
    // No await: the run is now in flight.
    await expect(agent.rewindTurns(1)).rejects.toThrow('正在跑一轮');
    await untilIdle(agent);
    expect(agent.messages).toHaveLength(4);
  });

  it('keeps a synthesized compaction summary on the surface across a later rewind', async () => {
    // The reason `applyRewind` resolves against the SURFACE and not the message
    // stream: the summary message is synthesized at projection time and no
    // `message` event carries its id, so a log-resolved rewind would drop it.
    const agent = await makeAgent([REPLY('first'), REPLY('second')]);
    await agent.prompt('one');
    await untilIdle(agent);
    await agent.session.appendEvent({
      type: 'compaction/summary',
      summary: 'earlier stuff',
      keep: [],
      keepIds: [],
      shadowedTokenCount: 0,
      at: Date.now(),
    });
    // The turn AFTER the compaction: only messages logged after the summary event
    // are on its surface, which is how a compaction actually behaves.
    await agent.prompt('two');
    await untilIdle(agent);
    const projected = agent.session.deriveMessages();
    agent.messages.splice(0, agent.messages.length, ...projected);
    expect(agent.messages.map((m) => m.content)).toEqual([
      `${COMPACT_SUMMARY_PREFIX}\nearlier stuff`,
      'two',
      'second',
    ]);

    const plan = await agent.rewindTurns(1);
    expect(plan?.dropped).toBe(1);
    expect(agent.messages.map((m) => m.content)).toEqual([`${COMPACT_SUMMARY_PREFIX}\nearlier stuff`]);
    expect(agent.session.deriveMessages().map((m) => m.id)).toEqual(agent.messages.map((m) => m.id));
  });

  it('rewinds twice, each cut landing on the surface in force', async () => {
    const agent = await makeAgent([REPLY('A'), REPLY('B'), REPLY('C')]);
    for (const text of ['one', 'two', 'three']) {
      await agent.prompt(text);
      await untilIdle(agent);
    }
    await agent.rewindTurns(1);
    await agent.rewindTurns(1);
    expect(agent.messages.map((m) => m.content)).toEqual(['one', 'A']);
    expect(agent.session.deriveMessages().map((m) => m.id)).toEqual(agent.messages.map((m) => m.id));
  });
});
