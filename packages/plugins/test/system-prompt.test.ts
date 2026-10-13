/**
 * The system prompt's tool rules (`system-prompt.ts`).
 *
 * Asserted because the prompt IS the interface the model reads: a rule the
 * prompt states is one the model can follow, and one it omits is a rule the
 * model has to guess (observed: `@repo/docs/x.md` was read as `docs/x.md`).
 * Contract-level assertions only — wording may change, the rule may not.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from '../src/system-prompt.js';

describe('system prompt', () => {
  it('states that an @ mention is a workspace-relative path used verbatim', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('@path');
    expect(prompt).toContain('WORKSPACE-RELATIVE');
    expect(prompt).toMatch(/never add or drop a leading segment/u);
  });

  it('points the file-read rule at read_file rather than shell commands', () => {
    expect(buildSystemPrompt()).toMatch(/Use read_file — not shell commands/u);
  });

  it('appends plugin-owned sections under their own headings', () => {
    const prompt = buildSystemPrompt([
      { name: 'Plugin: genui', text: 'When the user asks for a button, call render_ui.' },
    ]);
    expect(prompt).toContain('## Plugin: genui');
    expect(prompt).toContain('call render_ui.');
    // The persona prompt is still there — a section is additive, never a rewrite.
    expect(prompt.startsWith(DEFAULT_SYSTEM_PROMPT)).toBe(true);
  });

  it('keeps insertion order and lets the latest same-name registration win', () => {
    const prompt = buildSystemPrompt([
      { name: 'A', text: 'first' },
      { name: 'B', text: 'second' },
      { name: 'A', text: 'third (overrides first)' },
    ]);
    const aIdx = prompt.indexOf('third (overrides first)');
    const bIdx = prompt.indexOf('second');
    // Section A's latest body appears; section B retains its place AFTER A.
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(prompt).not.toContain('\nfirst\n');
  });

  it('returns the bare persona prompt when no sections carry text', () => {
    expect(buildSystemPrompt([])).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(buildSystemPrompt([{ name: 'Empty', text: '' }])).toBe(DEFAULT_SYSTEM_PROMPT);
  });
});
