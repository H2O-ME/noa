/**
 * The "one result per call" repair rule. The pairing is per assistant turn, not
 * by a global id set: a provider that reuses a call id in a later turn must
 * still get that later call repaired, or the next request carries an unanswered
 * tool call and a strict provider rejects it.
 *
 * The second half is about SCOPE: the durable pass reads its candidates from the
 * log but only repairs calls the live surface still carries, which is what keeps
 * a shadowed turn (compacted away, or taken back by `/undo`) from producing an
 * orphan tool result on the current surface.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOT_EXECUTED_GUIDANCE } from '../src/agent/options.js';
import { missingToolResults, persistMissingToolResults } from '../src/session/session-repair.js';
import { Session } from '../src/session.js';
import type { AgentMessage } from '../src/types.js';

const assistantCall = (id: string, callId: string): AgentMessage => ({
  id,
  ts: 0,
  role: 'assistant',
  content: '',
  toolCalls: [{ id: callId, name: 't', args: {}, rawArgs: '{}' }],
});

const toolResult = (id: string, callId: string, content = 'r'): AgentMessage => ({
  id,
  ts: 0,
  role: 'tool',
  toolCallId: callId,
  name: 't',
  content,
});

describe('missingToolResults', () => {
  it('scopes pairing per assistant turn so a reused call id is still repaired', () => {
    // Killing test: a global "answered" set let turn 1's result satisfy turn 2's
    // call with the same id, so the repair returned nothing.
    const messages: AgentMessage[] = [
      assistantCall('a1', 'call_1'),
      toolResult('t1', 'call_1', 'first'),
      assistantCall('a2', 'call_1'),
    ];
    const missing = missingToolResults(messages);
    expect(missing.map((m) => m.toolCallId)).toEqual(['call_1']);
    expect(missing[0]?.content).toBe(NOT_EXECUTED_GUIDANCE);
  });

  it('reports nothing when every call is answered', () => {
    const messages: AgentMessage[] = [assistantCall('a1', 'c'), toolResult('t1', 'c')];
    expect(missingToolResults(messages)).toEqual([]);
  });

  it('emits one result per id even when one message repeats it', () => {
    const messages: AgentMessage[] = [
      {
        id: 'a1',
        ts: 0,
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'dup', name: 't', args: {}, rawArgs: '{}' },
          { id: 'dup', name: 't', args: {}, rawArgs: '{}' },
        ],
      },
    ];
    expect(missingToolResults(messages)).toHaveLength(1);
  });
});

describe('persistMissingToolResults', () => {
  async function sessionWith(messages: AgentMessage[]): Promise<Session> {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-repair-'));
    const session = await Session.create(dir, 'sess_repair');
    for (const msg of messages) await session.append(msg);
    return session;
  }

  it('writes a result to the LOG even when the surface already has one in memory', async () => {
    // The run loop's own cleanup fills the surface; this pass is what makes the
    // durable file agree. Taking the candidates from the surface instead would
    // leave the log dangling forever, and a resume projects from the log.
    const call = assistantCall('a1', 'c1');
    const session = await sessionWith([call]);
    const surface = [call, toolResult('t1', 'c1')];
    expect(await persistMissingToolResults(session, surface)).toBe(1);
    expect(session.allMessages().some((m) => m.role === 'tool' && m.toolCallId === 'c1')).toBe(true);
  });

  it('leaves a shadowed turn alone, so its result cannot become an orphan', async () => {
    // After a compaction or a `/undo` the surface is a strict SUBSET of the log. A
    // dangling call in the shadowed part needs no result — appending one would
    // land an orphan tool message on the CURRENT surface, which is the unbalanced
    // shape this module exists to prevent.
    const shadowed = assistantCall('a_shadowed', 'c_shadowed');
    const live = assistantCall('a_live', 'c_live');
    const session = await sessionWith([shadowed, live]);
    const surface = [live, toolResult('t_live', 'c_live')];
    // The live call's result is still written (the log never received the one the
    // run loop synthesized); the shadowed one is NOT, and that is the assertion.
    expect(await persistMissingToolResults(session, surface)).toBe(1);
    expect(session.allMessages().some((m) => m.toolCallId === 'c_shadowed')).toBe(false);
  });
});
