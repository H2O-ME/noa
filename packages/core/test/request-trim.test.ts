import { describe, expect, it } from 'vitest';
import {
  MICRO_RESULT_PLACEHOLDER,
  groupMessages,
  microMessages,
  snipMessages,
  trimRequestMessages,
  type AgentMessage,
  type AssistantMessage,
  type ToolResultMessage,
  type UserMessage,
} from '../src/index.js';

let seq = 0;
function user(content: string): UserMessage {
  seq += 1;
  return { id: `msg_u${seq}`, ts: seq, role: 'user', content };
}
function assistant(content: string): AssistantMessage {
  seq += 1;
  return { id: `msg_a${seq}`, ts: seq, role: 'assistant', content };
}
function toolTurn(name: string, result: string): [AssistantMessage, ToolResultMessage] {
  seq += 1;
  const callId = `call_${seq}`;
  const head: AssistantMessage = {
    id: `msg_a${seq}`,
    ts: seq,
    role: 'assistant',
    content: '',
    toolCalls: [{ id: callId, name, args: {}, rawArgs: '{}' }],
  };
  seq += 1;
  const tail: ToolResultMessage = {
    id: `msg_t${seq}`,
    ts: seq,
    role: 'tool',
    toolCallId: callId,
    name,
    content: result,
  };
  return [head, tail];
}
/** Every tool result still has its assistant call ahead of it (no orphans). */
function pairingHolds(messages: AgentMessage[]): boolean {
  const calls = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls !== undefined) {
      for (const call of msg.toolCalls) calls.add(call.id);
    }
    if (msg.role === 'tool' && !calls.has(msg.toolCallId)) return false;
  }
  return true;
}

describe('groupMessages', () => {
  it('counts assistant(tool_calls) + paired results as one atomic group', () => {
    const [head, r1] = toolTurn('a', 'A');
    // A second result paired to the SAME assistant call joins the same group.
    const r2: ToolResultMessage = { ...r1, id: 'msg_tX', toolCallId: head.toolCalls![0]!.id, name: 'b' };
    const groups = groupMessages([user('hi'), head, r1, r2, assistant('done')]);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toHaveLength(3);
  });

  it('leaves unpaired tool results standing alone (never glues to a stranger)', () => {
    const orphan: ToolResultMessage = {
      id: 'msg_orphan',
      ts: 99,
      role: 'tool',
      toolCallId: 'call_missing',
      name: 'a',
      content: 'x',
    };
    const groups = groupMessages([user('hi'), orphan, assistant('done')]);
    expect(groups).toHaveLength(3);
    expect(groups[1]).toEqual([orphan]);
  });
});

describe('snipMessages', () => {
  it('returns the input untouched under budget (same reference, no marker)', () => {
    const messages: AgentMessage[] = [user('hi'), assistant('hello')];
    expect(snipMessages(messages)).toBe(messages);
  });

  it('drops whole middle groups with head + marker + tail, never orphans', () => {
    const messages: AgentMessage[] = [user('start')];
    for (let i = 0; i < 5; i++) messages.push(...toolTurn('work', `result ${i}`));
    messages.push(assistant('done'));
    // 1 user + 5 tool groups + 1 plain = 7 groups; budget 5 → head 1 +
    // marker + tail 3 groups (last 2 tool groups × 2 msgs + final plain).
    const out = snipMessages(messages, { maxGroups: 5, keepHeadGroups: 1 });
    expect(out).toHaveLength(1 + 1 + 2 * 2 + 1);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.role).toBe('assistant');
    expect(out[1]?.content).toContain('3 message groups omitted');
    expect(pairingHolds(out)).toBe(true);
    // Untouched input: snip never mutates.
    expect(messages).toHaveLength(1 + 5 * 2 + 1);
  });

  it('rejects budgets that leave no room for head + marker + tail', () => {
    expect(() => snipMessages([user('x')], { maxGroups: 2 })).toThrow(RangeError);
    expect(() => snipMessages([user('x')], { maxGroups: 5, keepHeadGroups: 4 })).toThrow(RangeError);
  });
});

describe('microMessages', () => {
  it('keeps the newest N tool groups verbatim, placeholders the older bodies', () => {
    const messages: AgentMessage[] = [user('start')];
    for (let i = 0; i < 4; i++) messages.push(...toolTurn('work', `body ${i}`));
    messages.push(assistant('done'));
    const out = microMessages(messages, { keepRecentToolGroups: 1 });
    // Same count, same pairing; only the 3 older result bodies changed.
    expect(out).toHaveLength(messages.length);
    expect(pairingHolds(out)).toBe(true);
    const results = out.filter((m): m is ToolResultMessage => m.role === 'tool');
    expect(results).toHaveLength(4);
    expect(results.slice(0, 3).every((r) => r.content === MICRO_RESULT_PLACEHOLDER)).toBe(true);
    expect(results[3]?.content).toBe('body 3');
    // Call shape (names, ids) intact — the model can re-run from the record.
    expect(results.map((r) => r.toolCallId)).toEqual(
      messages.filter((m): m is ToolResultMessage => m.role === 'tool').map((r) => r.toolCallId),
    );
  });

  it('replaces even short results (one deterministic rule, no length branch)', () => {
    const messages: AgentMessage[] = [user('s'), ...toolTurn('a', 'x'), ...toolTurn('b', 'y')];
    const out = microMessages(messages, { keepRecentToolGroups: 1 });
    const results = out.filter((m): m is ToolResultMessage => m.role === 'tool');
    expect(results[0]?.content).toBe(MICRO_RESULT_PLACEHOLDER);
    expect(results[1]?.content).toBe('y');
  });

  it('returns the input untouched when tool groups fit the budget', () => {
    const messages: AgentMessage[] = [user('s'), ...toolTurn('a', 'A')];
    expect(microMessages(messages)).toBe(messages);
  });
});

describe('trimRequestMessages', () => {
  it('snips before microing on one fresh array, input never mutated', () => {
    const messages: AgentMessage[] = [user('start')];
    for (let i = 0; i < 60; i++) messages.push(...toolTurn('work', `body ${i}`));
    const before = messages.length;
    const out = trimRequestMessages(messages);
    expect(messages).toHaveLength(before);
    expect(out).not.toBe(messages);
    expect(pairingHolds(out)).toBe(true);
    // Snip capped the groups at 50 (marker included); micro then aged all
    // but the newest 3 tool groups.
    expect(out.some((m) => m.content.includes('message groups omitted'))).toBe(true);
    const results = out.filter((m): m is ToolResultMessage => m.role === 'tool');
    const kept = results.filter((r) => r.content !== MICRO_RESULT_PLACEHOLDER);
    expect(kept).toHaveLength(3);
  });
});
