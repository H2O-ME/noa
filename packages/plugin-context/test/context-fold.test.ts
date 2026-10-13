/**
 * The context fold's contract: what the reading must say about a session, and
 * which of its rows are load-bearing.
 *
 * Asserted against hand-built logs rather than a live kernel: the fold is a pure
 * function of `SessionEvent[]` plus a surface, so every rule it claims (a point
 * prices the request BEFORE its own reply, a compaction takes rows off the
 * window, a failed call touches no file) is a fact about the log — and a fact a
 * test can state in three lines.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, ContextSurface, SessionEvent } from '@noa/core';
import { contextInsightsOf } from '../src/fold.js';
import { fileOpOfCall } from '../src/file-ops.js';

const insights = contextInsightsOf();

/** A user turn. */
function user(id: string, content: string, at = 1000): SessionEvent {
  return { type: 'message', message: { id, ts: at, role: 'user', content } };
}

/** The session-start fragment with two sections. */
function fragment(id = 'msg_ctx_1'): SessionEvent {
  return {
    type: 'message',
    message: {
      id,
      ts: 0,
      role: 'user',
      content: '<environment>\ncwd=/w\n</environment>\n<user_instructions>\nbe brief\n</user_instructions>',
    },
  };
}

function assistant(
  id: string,
  content: string,
  options: { at?: number; usage?: { promptTokens: number; completionTokens: number; cachedTokens: number }; calls?: { id: string; name: string; args: Record<string, unknown> }[] } = {},
): SessionEvent {
  const message: AgentMessage = {
    id,
    ts: options.at ?? 2000,
    role: 'assistant',
    content,
    ...(options.calls !== undefined
      ? { toolCalls: options.calls.map((call) => ({ ...call, rawArgs: JSON.stringify(call.args) })) }
      : {}),
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
  };
  return { type: 'message', message };
}

function toolResult(id: string, callId: string, name: string, content: string): SessionEvent {
  return { type: 'message', message: { id, ts: 3000, role: 'tool', toolCallId: callId, name, content } };
}

describe('context fold', () => {
  it('prices the seeded fragment per section, each naming its producer', () => {
    const fold = insights.fold([fragment(), user('u1', 'hello')]);
    const view = fold.view();
    const injected = view.live.elements.filter((element) => element.cat === 'injected');
    expect(injected.map((element) => element.label)).toEqual(['environment', 'user_instructions']);
    expect(injected.every((element) => element.tokens > 0)).toBe(true);
    // A fragment is context, not a turn: the user's own message is the turn.
    expect(view.counts.turns).toBe(1);
    expect(view.live.elements.filter((element) => element.cat === 'user').map((element) => element.label)).toEqual(['hello']);
  });

  it('prices the system prompt and every tool schema from the surface, and retires them on a change', () => {
    const surface: ContextSurface = {
      system: 'you are a careful agent',
      tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }],
    };
    const fold = insights.fold([fragment()], surface);
    const after = fold.view();
    expect(after.live.cats.system).toBeGreaterThan(0);
    expect(after.live.cats.tools).toBeGreaterThan(0);
    expect(after.live.elements.filter((element) => element.cat === 'tools').map((element) => element.label)).toEqual(['read_file']);

    // A re-roster (a different tool table) must not double-count: the old rows
    // go off the window and the new ones take their place.
    fold.apply(user('u1', 'hi'), { system: surface.system, tools: [{ name: 'bash', description: 'run', parameters: {} }] });
    const changed = fold.view();
    const names = changed.live.elements.filter((element) => element.cat === 'tools').map((element) => element.label);
    expect(names).toEqual(['bash']);
  });

  it('emits one point per completed request, priced BEFORE that reply', () => {
    const fold = insights.fold([
      fragment(),
      user('u1', 'x'.repeat(400)),
      assistant('a1', 'y'.repeat(400), { at: 2100, usage: { promptTokens: 1234, completionTokens: 56, cachedTokens: 1000 } }),
    ]);
    const [point] = fold.view().points;
    expect(point).toBeDefined();
    expect(point!.at).toBe(2100);
    // The reply is not part of the request that produced it.
    expect(point!.cats.assistant).toBe(0);
    // …but the user message that opened the turn is.
    expect(point!.cats.user).toBeGreaterThan(0);
    expect(point!.cats.injected).toBeGreaterThan(0);
    // Provider-reported usage rides alongside the estimate untouched.
    expect(point!.prompt).toBe(1234);
    expect(point!.cached).toBe(1000);
    expect(point!.output).toBe(56);
    expect(point!.total).toBe(Object.values(point!.cats).reduce((sum, value) => sum + value, 0));
  });

  it('takes the replaced rows off the window when a compaction lands', () => {
    const messages: SessionEvent[] = [fragment(), user('u1', 'old one'), user('u2', 'old two')];
    const fold = insights.fold(messages);
    const before = fold.view();
    expect(before.live.elements.filter((element) => element.cat === 'user')).toHaveLength(2);

    // Keep the fragment only, summarize the rest — the same shape the log
    // writes (`keepIds` authoritative, `keep` positional).
    fold.apply({
      type: 'compaction/summary',
      summary: 'we discussed two things',
      keep: [0],
      keepIds: ['msg_ctx_1'],
      shadowedTokenCount: 42,
      at: 5000,
    });
    const after = fold.view();
    expect(after.live.elements.filter((element) => element.cat === 'user' && element.label !== 'compaction')).toHaveLength(0);
    expect(after.live.elements.some((element) => element.label === 'compaction')).toBe(true);
    expect(after.counts.compactions).toBe(1);
    const event = after.events.find((record) => record.kind === 'compaction');
    expect(event?.freed).toBe(42);
  });

  it('records a file op only when the call actually ran', () => {
    const run: SessionEvent[] = [
      assistant('a1', '', {
        calls: [
          { id: 'c1', name: 'edit_file', args: { path: 'src/a.ts', old_string: 'one', new_string: 'one\ntwo' } },
          { id: 'c2', name: 'write_file', args: { path: 'src/b.ts', content: 'x\ny\nz' } },
        ],
      }),
      toolResult('t1', 'c1', 'edit_file', 'applied 1 edit'),
      toolResult('t2', 'c2', 'write_file', 'Error: path escapes the workspace'),
    ];
    const view = insights.fold(run).view();
    const edited = view.files.find((file) => file.path === 'src/a.ts');
    expect(edited).toBeDefined();
    expect(edited!.writes).toBe(1);
    expect(edited!.added).toBe(2);
    expect(edited!.removed).toBe(1);
    // The refused write never touched the file, so it has no row at all.
    expect(view.files.some((file) => file.path === 'src/b.ts')).toBe(false);
  });

  it('counts a tool result and flags its failure on the element', () => {
    const view = insights.fold([
      assistant('a1', '', { calls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }] }),
      toolResult('t1', 'c1', 'read_file', 'Error: file not found: a.ts'),
    ]).view();
    const element = view.live.elements.find((entry) => entry.cat === 'tool');
    expect(element?.label).toBe('read_file');
    expect(element?.ok).toBe(false);
    expect(view.counts.toolCalls).toBe(1);
  });

  it('records workspace and goal changes as events', () => {
    const view = insights.fold([
      { type: 'workspace', path: '/w/two', at: 10 },
      { type: 'goal/change', goal: { id: 'g1', objective: 'ship the port', status: 'active', rounds: 0 } as never, at: 11 },
    ]).view();
    expect(view.events.map((record) => record.kind)).toEqual(['workspace', 'goal']);
    expect(view.events[0]!.detail).toBe('/w/two');
    expect(view.events[1]!.detail).toBe('ship the port');
  });

  it('reports an ongoing session without any surface (the log alone)', () => {
    const view = insights.fold([user('u1', 'hello'), assistant('a1', 'hi')]).view();
    expect(view.live.cats.system).toBe(0);
    expect(view.live.cats.tools).toBe(0);
    expect(view.points).toHaveLength(1);
    expect(view.truncated).toBe(false);
  });
});

describe('file op parsing', () => {
  it('reads the path and line deltas the arguments carry', () => {
    const call = (name: string, args: Record<string, unknown>) => ({ id: 'c', name, args, rawArgs: '{}' });
    expect(fileOpOfCall(call('read_file', { path: 'a.ts' }))).toEqual({ kind: 'read', path: 'a.ts' });
    expect(fileOpOfCall(call('write_file', { path: 'a.ts', content: 'x\ny' }))).toEqual({ kind: 'write', path: 'a.ts', added: 2 });
    expect(fileOpOfCall(call('edit_file', { path: 'a.ts', old_string: 'x', new_string: 'x\ny' }))).toEqual({
      kind: 'write',
      path: 'a.ts',
      added: 2,
      removed: 1,
    });
    expect(fileOpOfCall(call('search_files', {}))).toEqual({ kind: 'search', path: '.' });
    // A tool with no named file contributes nothing rather than a guessed row.
    expect(fileOpOfCall(call('bash', { command: 'rm -rf /' }))).toBeUndefined();
    expect(fileOpOfCall(call('read_file', {}))).toBeUndefined();
  });
});
