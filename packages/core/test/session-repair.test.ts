/**
 * The "one result per call" repair rule. The pairing is per assistant turn, not
 * by a global id set: a provider that reuses a call id in a later turn must
 * still get that later call repaired, or the next request carries an unanswered
 * tool call and a strict provider rejects it.
 */
import { describe, expect, it } from 'vitest';
import { NOT_EXECUTED_GUIDANCE } from '../src/agent/options.js';
import { missingToolResults } from '../src/session/session-repair.js';
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
