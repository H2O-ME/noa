import { describe, expect, it } from 'vitest';
import { MAX_ALWAYS_SCOPE_WORDS, MAX_DENY_REASON_CHARS, parseAskResult } from '../src/approval.js';
import { hasControlChars } from '../src/text.js';

/**
 * The answer parser is the kernel's one untrusted-input boundary for approval:
 * a WebUI frame, a Rust-bridge message and a third-party asker's return all
 * arrive here. These cases are the contract the three call sites rely on, kept
 * at the vocabulary's owner instead of being re-derived per surface.
 */
describe('parseAskResult', () => {
  it('passes bare verdicts through unchanged', () => {
    for (const verdict of ['allow', 'deny', 'always'] as const) {
      expect(parseAskResult(verdict)).toBe(verdict);
    }
  });

  it('reads both grant shapes: tagged (plugin asker) and bare (wire)', () => {
    expect(parseAskResult({ answer: 'always', scopeWords: 2 })).toEqual({ answer: 'always', scopeWords: 2 });
    expect(parseAskResult({ scopeWords: 2 })).toEqual({ answer: 'always', scopeWords: 2 });
    expect(parseAskResult({ answer: 'deny', reason: ' 别碰 CI ' })).toEqual({ answer: 'deny', reason: '别碰 CI' });
    expect(parseAskResult({ reason: '别碰 CI' })).toEqual({ answer: 'deny', reason: '别碰 CI' });
  });

  it('bounds a scope grant and rejects every non-integer form', () => {
    expect(parseAskResult({ scopeWords: 1 })).toEqual({ answer: 'always', scopeWords: 1 });
    expect(parseAskResult({ scopeWords: MAX_ALWAYS_SCOPE_WORDS })).toEqual({ answer: 'always', scopeWords: MAX_ALWAYS_SCOPE_WORDS });
    for (const bad of [0, -1, 1.5, MAX_ALWAYS_SCOPE_WORDS + 1, '2', null, true]) {
      expect(parseAskResult({ scopeWords: bad })).toBeUndefined();
    }
  });

  it('clamps a long reason; a blank or non-string reason degrades a tagged denial', () => {
    const long = parseAskResult({ reason: 'x'.repeat(MAX_DENY_REASON_CHARS + 50) });
    expect(long).toEqual({ answer: 'deny', reason: 'x'.repeat(MAX_DENY_REASON_CHARS) });
    // Tagged: the verdict survives without the unusable reason.
    expect(parseAskResult({ answer: 'deny', reason: '   ' })).toBe('deny');
    expect(parseAskResult({ answer: 'deny', reason: 42 })).toBe('deny');
    expect(parseAskResult({ answer: 'deny' })).toBe('deny');
    // Untagged: there is no verdict to keep, so the whole answer is malformed.
    expect(parseAskResult({ reason: '   ' })).toBeUndefined();
    expect(parseAskResult({ reason: 42 })).toBeUndefined();
  });

  it('rejects control junk in a reason but tolerates the newlines a user typed', () => {
    expect(parseAskResult({ reason: 'stop\u001b[2J' })).toBeUndefined();
    expect(parseAskResult({ answer: 'deny', reason: 'stop\u001b[2J' })).toBe('deny');
    expect(parseAskResult({ reason: 'line one\nline two' })).toEqual({ answer: 'deny', reason: 'line one\nline two' });
  });

  it('honours an explicit answer tag over shape sniffing', () => {
    // A grant whose tag disagrees with its fields is malformed, not a guess.
    expect(parseAskResult({ answer: 'allow', scopeWords: 2 })).toBeUndefined();
    expect(parseAskResult({ answer: 'yes', scopeWords: 2 })).toBeUndefined();
    expect(parseAskResult({ answer: 'always' })).toBeUndefined();
  });

  it('rejects everything that is not an answer at all', () => {
    for (const bad of ['maybe', 'Y', '', 1, null, undefined, true, [], [{ reason: 'x' }]]) {
      expect(parseAskResult(bad)).toBeUndefined();
    }
  });
});

describe('hasControlChars', () => {
  it('flags escapes and NULs in both policies', () => {
    expect(hasControlChars('a\u001b[31mb')).toBe(true);
    expect(hasControlChars('a\u0000b')).toBe(true);
    expect(hasControlChars('a\u0000b', { multiline: true })).toBe(true);
  });

  it('lets multi-line fields keep their newlines and tabs', () => {
    expect(hasControlChars('one\ntwo', { multiline: true })).toBe(false);
    expect(hasControlChars('one\ttwo', { multiline: true })).toBe(false);
    // A path or an id is never multi-line.
    expect(hasControlChars('one\ntwo')).toBe(true);
    expect(hasControlChars('one\ttwo')).toBe(true);
  });
});