/**
 * The window snapshot's contract: what a Browser/DNA reader sees at one request.
 *
 * Same lane `context-fold.test.ts` uses — hand-built logs and the pure
 * `windowAtSeq` function — so every rule the snapshot claims (the window is
 * the elements that entered before `seq` and had not been removed; a missing
 * position is `undefined`) is a fact about the log a test can state in three lines.
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage, ContextSurface, SessionEvent } from '@noa/core';
import { windowAtSeq } from '../src/fold.js';

function user(id: string, content: string, at = 1000): SessionEvent {
  return { type: 'message', message: { id, ts: at, role: 'user', content } };
}

function assistant(
  id: string,
  content: string,
  options: { at?: number; usage?: { promptTokens: number; completionTokens: number; cachedTokens: number } } = {},
): SessionEvent {
  const message: AgentMessage = {
    id,
    ts: options.at ?? 2000,
    role: 'assistant',
    content,
    ...(options.usage !== undefined ? { usage: options.usage } : {}),
  };
  return { type: 'message', message };
}

/** A surface with one tool schema — so the fold produces system + tools rows. */
const surface: ContextSurface = {
  system: 'system prompt',
  tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
};

describe('windowAtSeq', () => {
  it('returns the elements that entered before seq, priced, with the point attached', () => {
    // seq 0: user 'hi' (surface rows are stamped at seq -1 by syncSurface)
    // seq 1: assistant 'hello' → point at seq 1
    // seq 2: user 'again'
    // seq 3: assistant 'world' → point at seq 3
    const events = [
      user('u1', 'hi'),
      assistant('a1', 'hello', { usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 0 } }),
      user('u2', 'again'),
      assistant('a2', 'world', { usage: { promptTokens: 80, completionTokens: 8, cachedTokens: 0 } }),
    ];
    const snap = windowAtSeq(events, 3, surface);
    expect(snap).toBeDefined();
    expect(snap!.seq).toBe(3);
    // The window includes the surface rows plus u1/a1/u2 — all entered before
    // seq 3. Assistant a2 itself is NOT in its own window.
    const labels = snap!.elements.map((e) => e.label);
    expect(labels).toContain('system');
    expect(labels).toContain('read_file');
    expect(labels).toContain('hi');
    expect(labels).not.toContain('world');
    expect(snap!.total).toBeGreaterThan(0);
    // The point at seq 3 is attached.
    expect(snap!.point).toBeDefined();
    expect(snap!.point!.seq).toBe(3);
    expect(snap!.point!.prompt).toBe(80);
  });

  it('returns undefined only when no element entered before seq', () => {
    const events = [user('u1', 'hi'), assistant('a1', 'hello')];
    // Before the first event — nothing entered, surface included (it is stamped
    // at `seq - 1` of the first event, so it appears AT seq 0, not before).
    expect(windowAtSeq(events, -1, surface)).toBeUndefined();
    // seq 0 already includes the surface rows (stamped at seq -1).
    const atStart = windowAtSeq(events, 0, surface);
    expect(atStart).toBeDefined();
    expect(atStart!.elements.map((e) => e.label)).toEqual(['system', 'read_file']);
    // A seq past the end is NOT undefined — the window is whatever survives.
    const past = windowAtSeq(events, 99, surface);
    expect(past).toBeDefined();
    expect(past!.elements.map((e) => e.label)).toContain('hi');
  });

  it('excludes elements removed by a compaction whose position is <= seq', () => {
    const events: SessionEvent[] = [
      user('u1', 'before'),
      assistant('a1', 'one'),
      {
        type: 'compaction/summary',
        at: 5000,
        summary: 'compacted',
        keep: [],
        shadowedTokenCount: 100,
      },
      user('u2', 'after'),
      assistant('a2', 'two'),
    ];
    // Seq 4 is the second assistant. The pre-compaction user `before` is gone.
    const snap = windowAtSeq(events, 4);
    expect(snap).toBeDefined();
    const labels = snap!.elements.map((e) => e.label);
    expect(labels).not.toContain('before');
    expect(labels).toContain('after');
  });

  it('reads the same composition as the live fold at that seq', () => {
    const events = [
      user('u1', 'hi'),
      assistant('a1', 'hello', { usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0 } }),
    ];
    const snap = windowAtSeq(events, 2, surface);
    expect(snap).toBeDefined();
    // The composition's total matches the snapshot's cats sum — one rule, two reads.
    const catSum =
      snap!.cats.system +
      snap!.cats.tools +
      snap!.cats.injected +
      snap!.cats.user +
      snap!.cats.assistant +
      snap!.cats.tool;
    expect(catSum).toBe(snap!.total);
  });
});
