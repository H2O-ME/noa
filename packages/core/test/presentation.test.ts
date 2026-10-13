/**
 * The presentation vocabulary must stay *shape only*. These tests are the fence
 * that keeps it that way: semantics equivalence with the behavior the terminal
 * view layer used to own (so adopting the vocabulary cannot change a pixel),
 * and a textual guard against copy / color / width leaking into `core`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_TOOL_KINDS,
  callViewOf,
  isFailureContent,
  isPathArgKind,
  isReadOnlyKind,
  resultViewOf,
  toolCallKind,
} from '../src/index.js';
// The subagent view is internal (not re-exported from the package barrel), and
// the packaging rule is explicit: tests import internals directly rather than
// widening the public API to make a test compile.
import { presentSubagentCall, presentSubagentResult } from '../src/tools/subagent-view.js';

describe('isFailureContent', () => {
  // Cases pinned to the pre-move terminal implementation, byte for byte: the
  // function changed packages, not semantics.
  const cases: [string, boolean][] = [
    ['Error: file not found: x.ts', true],
    ['Permission denied: by user: nope', true],
    ['exit: 1\nstdout:\n(empty)', true],
    ['exit: 0\nstdout:\nok', false],
    ['exit: null\n[command did not exit: killed after timeout or aborted]', true],
    ['wrote 12 chars to a.ts', false],
    ['a.ts:1: const x = 1', false],
    ['\nstdout:\nexit: 2', true],
    ['a.ts:7: call process.exit: 2 loudly', false],
  ];
  for (const [content, expected] of cases) {
    it(`classifies ${JSON.stringify(content.slice(0, 28))} as ${expected ? 'failure' : 'success'}`, () => {
      expect(isFailureContent(content)).toBe(expected);
    });
  }
});

describe('tool call kinds', () => {
  it('reaches every table entry through the public classifier', () => {
    // A round trip, not a copy of the vocabulary. This test used to restate the
    // union as a literal set and check membership — a second implementation that
    // had to be edited by hand whenever the union grew, in a file `tsc` does not
    // even read (`tsconfig.json` includes only `src`). The invariant that
    // actually matters is that the table the classifier consults is the table
    // this file reads, and that it answers for every name in it.
    const entries = Object.entries(BUILTIN_TOOL_KINDS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [name, kind] of entries) {
      expect(toolCallKind(name)).toBe(kind);
    }
    // A kind added to the union without a label for it is caught where the label
    // lives: the surfaces key their copy maps by `ToolCallKind`
    // (`Record<ToolCallKind, string>`), and those files ARE typechecked.
  });

  it('unknown tools classify as other instead of throwing', () => {
    expect(toolCallKind('some_third_party_tool')).toBe('other');
    expect(isReadOnlyKind(toolCallKind('nope'))).toBe(false);
    expect(isPathArgKind(toolCallKind('nope'))).toBe(false);
  });

  it('a tool named after an Object.prototype member still classifies as other', () => {
    // The kind table is an object literal and the name is model output, so a
    // bare index would hand back `Object.prototype.constructor` — a function,
    // not a ToolCallKind — and every `switch (kind)` downstream would miss.
    for (const name of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(toolCallKind(name)).toBe('other');
    }
  });

  /**
   * These two sets are exactly what the terminal view layer used to hardcode by
   * tool name (`READ_ONLY_TOOLS`, `PATH_ARG_TOOLS`). Deriving them from kinds
   * must agree on every name, or adopting the vocabulary would have changed
   * live-row grouping and path clipping.
   */
  const READ_ONLY_BY_NAME = ['read_file', 'list_dir', 'search_files'];
  const PATH_ARG_BY_NAME = ['read_file', 'write_file', 'edit_file', 'list_dir'];
  const ALL_NAMES = [...new Set([...Object.keys(BUILTIN_TOOL_KINDS), ...READ_ONLY_BY_NAME, ...PATH_ARG_BY_NAME])];

  it('read-only grouping matches the historical name list', () => {
    for (const name of ALL_NAMES) {
      expect(isReadOnlyKind(toolCallKind(name))).toBe(READ_ONLY_BY_NAME.includes(name));
    }
  });

  it('path-argument grouping matches the historical name list', () => {
    for (const name of ALL_NAMES) {
      expect(isPathArgKind(toolCallKind(name))).toBe(PATH_ARG_BY_NAME.includes(name));
    }
  });
});

describe('view resolution from a tool registry', () => {
  const tools = [
    {
      name: 'bash',
      presentCall: (args: Record<string, unknown>) => ({ card: 'terminal' as const, command: String(args['command'] ?? '') }),
      presentResult: (args: Record<string, unknown>, content: string) =>
        args['command'] === undefined ? undefined : { card: 'terminal' as const, output: content, exitCode: 0 },
    },
    {
      name: 'read_file',
      presentCall: () => ({ card: 'generic' as const, kind: 'read' as const, title: 'declared' }),
      presentResult: () => undefined, // an evolving tool: no result view yet
    },
  ];

  it("prefers the tool's own declared view", () => {
    expect(callViewOf(tools, { name: 'bash', args: { command: 'ls' } })).toEqual({ card: 'terminal', command: 'ls' });
    expect(callViewOf(tools, { name: 'read_file', args: { path: 'a.ts' } })).toEqual({
      card: 'generic',
      kind: 'read',
      title: 'declared',
    });
  });

  it('falls back to a generic card for an undeclared tool, keyed by argument shape', () => {
    const view = callViewOf(tools, { name: 'my_tool', args: { note: 'x', path: 'src/a.ts' } });
    expect(view).toEqual({ card: 'generic', kind: 'other', title: 'src/a.ts', subtitle: 'x' });
  });

  it('degrades to raw args when no string operand exists, and never throws', () => {
    const view = callViewOf(tools, { name: 'weird', args: { count: 3, nested: { a: 1 } } });
    expect(view.card).toBe('generic');
    expect(view.card === 'generic' && view.title).toContain('count');
  });

  it('resolves result views with the shared failure semantics on the fallback path', () => {
    expect(resultViewOf(tools, { name: 'bash', args: { command: 'ls' } }, 'exit: 0\nstdout:\nok')).toEqual({
      card: 'terminal',
      output: 'exit: 0\nstdout:\nok',
      exitCode: 0,
    });
    // Declares presentCall but no presentResult → generic card, ok from content.
    expect(resultViewOf(tools, { name: 'read_file', args: { path: 'a.ts' } }, 'Error: nope')).toEqual({
      card: 'generic',
      ok: false,
      text: 'Error: nope',
    });
    expect(resultViewOf(tools, { name: 'unknown', args: {} }, 'wrote 3 chars')).toMatchObject({ card: 'generic', ok: true });
  });
});

describe('the subagent delegation declares its own view', () => {
  /**
   * A delegation is not a generic tool call. These pin the two things a reader
   * needs from the row: WHAT was delegated, and that the report is a reply
   * rather than an opaque blob. The kind is also what titles the row, so a
   * `subagents` value that stops reaching the vocabulary fails above.
   */
  it('reads the label when given, else the brief\'s opening line', () => {
    expect(presentSubagentCall({ prompt: 'x', label: '扫依赖' })).toMatchObject({
      card: 'generic',
      kind: 'subagents',
      title: '扫依赖',
    });
    expect(presentSubagentCall({ prompt: '查一下登录链路\n第二行不该出现' })).toMatchObject({
      title: '查一下登录链路',
    });
  });

  it('marks a background delegation and survives a hostile payload', () => {
    expect(presentSubagentCall({ prompt: 'x', run_in_background: true })).toMatchObject({ subtitle: '后台' });
    // Never throws on model-authored args, and never renders an empty title: a
    // non-string prompt is rejected by the tool, so the row says what it is
    // rather than stringifying junk into the transcript.
    expect(presentSubagentCall({}).title).toBe('subagent');
    expect(presentSubagentCall({ label: '   ', prompt: 42 }).title).toBe('subagent');
    // A long opening line is clipped rather than allowed to fill the row.
    expect(String(presentSubagentCall({ prompt: 'a'.repeat(200) }).title).length).toBeLessThanOrEqual(61);
  });

  it('hands the whole report to the surface, with the tool\'s own failure signal', () => {
    const report = 'complete\n证据见 a.ts:12';
    expect(presentSubagentResult({}, report)).toEqual({ card: 'generic', ok: true, text: report });
    // The one failure the tool produces before any nested run starts.
    expect(presentSubagentResult({}, 'Error: prompt must be a non-empty string')).toMatchObject({ ok: false });
  });
});

describe('vocabulary stays presentation-free', () => {
  const source = () => readFile(fileURLToPath(new URL('../src/presentation.ts', import.meta.url)), 'utf8');

  it('carries no ANSI escapes, palette or column-width concepts', async () => {
    const text = await source();
    expect(text).not.toContain(String.fromCodePoint(0x1b));
    expect(text).not.toMatch(/\bPalette\b/);
    expect(text).not.toMatch(/\bcols\b/);
    expect(text).not.toMatch(/maxCols|styledWidth|clipToWidth/);
  });

  it('carries no user-facing copy (labels are each surface localization)', async () => {
    const text = await source();
    // No CJK anywhere in the file, comments included: a Chinese label has to
    // start somewhere, and this is not that place.
    expect(text).not.toMatch(/[一-鿿]/);
  });
});
