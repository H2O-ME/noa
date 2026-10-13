/**
 * Every built-in tool must speak the presentation vocabulary — this is what
 * makes the vocabulary real rather than decorative: a browser surface renders
 * these calls by switching on `card`, and a tool that silently stops declaring
 * its view would otherwise degrade in one UI with no test noticing.
 *
 * The assertions also pin the *purity* contract of `presentCall`: it runs
 * before permission is granted, so it must produce a view for a path that does
 * not exist (and never touch the filesystem).
 */
import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@noa/core';
import { PluginHost, builtinPlugins } from '../src/index.js';
import { rowsOf } from './plugin-rows.js';

async function builtins(): Promise<Map<string, ToolDefinition>> {
  const host = new PluginHost('.');
  await host.sync(rowsOf(builtinPlugins({ rootDir: () => host.rootDir })));
  return new Map(host.tools.map((tool) => [tool.name, tool]));
}

const EMPTY: Record<string, unknown> = {};

describe('bash', () => {
  it('declares a terminal card carrying the command verbatim', async () => {
    const bash = (await builtins()).get('bash');
    expect(bash?.presentCall?.({ command: 'pnpm test --reporter=dot' })).toEqual({
      card: 'terminal',
      // `kind` rides EVERY call view (`BUILTIN_TOOL_KINDS`), not just the generic
      // one: a surface that summarises work groups by what a call DID, and must
      // not re-derive that from the tool's name.
      kind: 'execute',
      command: 'pnpm test --reporter=dot',
    });
  });

  it('declares nothing for a blank command (nothing to render)', async () => {
    const bash = (await builtins()).get('bash');
    expect(bash?.presentCall?.({ command: '   ' })).toBeUndefined();
    expect(bash?.presentCall?.(EMPTY)).toBeUndefined();
  });

  it('reads exit code and output back out of its own result format', async () => {
    const bash = (await builtins()).get('bash');
    expect(bash?.presentResult?.(EMPTY, 'exit: 0\nstdout:\nok\n')).toEqual({
      card: 'terminal',
      output: 'ok\n',
      exitCode: 0,
    });
    expect(bash?.presentResult?.(EMPTY, 'exit: 1\nstdout:\n(empty)\nstderr:\nboom')).toEqual({
      card: 'terminal',
      output: '(empty)\nstderr:\nboom',
      exitCode: 1,
    });
  });

  it('reports a killed process as a null exit code', async () => {
    const bash = (await builtins()).get('bash');
    const view = bash?.presentResult?.(
      EMPTY,
      '[command did not exit: killed after timeout or aborted]\nexit: null\nstdout:\n(empty)',
    );
    expect(view).toMatchObject({ card: 'terminal', exitCode: null });
  });

  it('surfaces dropped middle bytes as a number', async () => {
    const bash = (await builtins()).get('bash');
    const view = bash?.presentResult?.(
      EMPTY,
      'exit: 0\n[stdout/stderr truncated: 4096 bytes in the middle kept out of view]\nstdout:\nlong',
    );
    expect(view).toMatchObject({ card: 'terminal', droppedBytes: 4096, output: 'long' });
  });

  it('falls back to no view for a spawn error or a background handle', async () => {
    const bash = (await builtins()).get('bash');
    expect(bash?.presentResult?.(EMPTY, 'Error: cannot spawn shell (bash): ENOENT')).toBeUndefined();
    expect(bash?.presentResult?.(EMPTY, 'Started background job bash-1: pnpm test\nYou will be…')).toBeUndefined();
  });
});

describe('write_file / edit_file', () => {
  it('both declare a diff card, and creation carries no old text', async () => {
    const tools = await builtins();
    expect(tools.get('write_file')?.presentCall?.({ path: 'a.ts', content: 'hello' })).toEqual({
      card: 'diff',
      kind: 'write',
      diffs: [{ path: 'a.ts', oldText: null, newText: 'hello' }],
    });
    expect(tools.get('edit_file')?.presentCall?.({ path: 'a.ts', old_string: 'x', new_string: 'y' })).toEqual({
      card: 'diff',
      kind: 'edit',
      diffs: [{ path: 'a.ts', oldText: 'x', newText: 'y' }],
    });
  });

  it('presentCall is pure: an unfetched, nonexistent path still yields a diff', async () => {
    const tools = await builtins();
    const view = tools.get('edit_file')?.presentCall?.({
      path: 'no/such/file-anywhere.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(view).toMatchObject({ card: 'diff' });
  });

  it('an incomplete call declares nothing', async () => {
    const tools = await builtins();
    expect(tools.get('edit_file')?.presentCall?.({ path: 'a.ts', new_string: 'y' })).toBeUndefined();
    expect(tools.get('write_file')?.presentCall?.({ path: 'a.ts' })).toBeUndefined();
  });

  it('the result view carries the same diffs and reports failure', async () => {
    const tools = await builtins();
    const args = { path: 'a.ts', content: 'hello' };
    expect(tools.get('write_file')?.presentResult?.(args, 'wrote 5 chars to a.ts')).toMatchObject({
      card: 'diff',
      ok: true,
      diffs: [{ path: 'a.ts', oldText: null, newText: 'hello' }],
    });
    expect(
      tools.get('write_file')?.presentResult?.(args, 'Error: path escapes workspace root: ../x'),
    ).toMatchObject({ card: 'diff', ok: false });
  });
});

describe('search_files', () => {
  it('mode follows the argument the model actually used', async () => {
    const search = (await builtins()).get('search_files');
    expect(search?.presentCall?.({ content_regex: 'runAgent' })).toEqual({
      card: 'search',
      kind: 'search',
      query: 'runAgent',
      mode: 'content',
    });
    expect(search?.presentCall?.({ name_glob: '**/*.ts' })).toEqual({
      card: 'search',
      kind: 'search',
      query: '**/*.ts',
      mode: 'name',
    });
    expect(search?.presentCall?.(EMPTY)).toBeUndefined();
  });

  it('content hits become jump targets; the cap note reads as truncation', async () => {
    const search = (await builtins()).get('search_files');
    expect(
      search?.presentResult?.(
        { content_regex: 'x' },
        'a.ts:3: const x = 1\nb.ts:9: x++',
      ),
    ).toEqual({ card: 'search', matches: [{ path: 'a.ts', line: 3 }, { path: 'b.ts', line: 9 }], truncated: false });
    expect(
      search?.presentResult?.({ content_regex: 'x' }, 'a.ts:1: x\n（已达结果上限 200，缩小范围或改用 bash 检索其余部分）'),
    ).toEqual({ card: 'search', matches: [{ path: 'a.ts', line: 1 }], truncated: true });
  });

  it('name hits are paths without a line, and no matches is an empty list', async () => {
    const search = (await builtins()).get('search_files');
    expect(search?.presentResult?.({ name_glob: '*.ts' }, 'a.ts\nb.ts')).toEqual({
      card: 'search',
      matches: [{ path: 'a.ts' }, { path: 'b.ts' }],
      truncated: false,
    });
    expect(search?.presentResult?.({ name_glob: '*.ts' }, '(no matches)')).toEqual({
      card: 'search',
      matches: [],
      truncated: false,
    });
    expect(search?.presentResult?.({ content_regex: 'x' }, 'Error: invalid content_regex: boom')).toBeUndefined();
  });
});

describe('read_file / list_dir', () => {
  it('a whole-file read is not truncated; a window is', async () => {
    const tools = await builtins();
    expect(tools.get('read_file')?.presentResult?.({ path: 'a.ts' }, 'one\ntwo')).toEqual({
      card: 'read',
      path: 'a.ts',
      lineCount: 2,
      truncated: false,
    });
    expect(tools.get('read_file')?.presentResult?.({ path: 'a.ts' }, '[lines 2-3 of 10]\ntwo\nthree')).toEqual({
      card: 'read',
      path: 'a.ts',
      lineCount: 2,
      truncated: true,
    });
    expect(tools.get('read_file')?.presentResult?.({ path: 'a.ts' }, 'Error: file not found: a.ts')).toBeUndefined();
  });

  it('does not count the trailing newline as a line', async () => {
    // `split('\n').length` is one too many for any text ending in a newline —
    // the tail split yields an empty last element. The count is what the row
    // reports against the window's own total, so an inflated number showed a
    // whole-file read as partial.
    const read = (await builtins()).get('read_file');
    expect(read?.presentResult?.({ path: 'a.ts' }, 'one\ntwo\n')).toMatchObject({ lineCount: 2 });
    expect(read?.presentResult?.({ path: 'a.ts' }, 'one\ntwo')).toMatchObject({ lineCount: 2 });
    expect(read?.presentResult?.({ path: 'a.ts' }, 'one\n')).toMatchObject({ lineCount: 1 });
    expect(read?.presentResult?.({ path: 'a.ts' }, 'one')).toMatchObject({ lineCount: 1 });
    // An empty body is zero lines, not one.
    expect(read?.presentResult?.({ path: 'a.ts' }, '')).toMatchObject({ lineCount: 0 });
    const list = (await builtins()).get('list_dir');
    expect(list?.presentResult?.({}, 'd src\nf 12 index.ts\n')).toMatchObject({ lineCount: 2 });
    expect(list?.presentResult?.({}, 'd src\n(... 7 more)')).toMatchObject({ lineCount: 1 });
  });

  it('a directory listing counts entries and honors the overflow marker', async () => {
    const list = (await builtins()).get('list_dir');
    expect(list?.presentResult?.({}, 'd src\nf 12 index.ts')).toEqual({
      card: 'read',
      path: '.',
      lineCount: 2,
      truncated: false,
    });
    expect(list?.presentResult?.({ path: 'pkg' }, 'd src\n(... 7 more)')).toEqual({
      card: 'read',
      path: 'pkg',
      lineCount: 1,
      truncated: true,
    });
    expect(list?.presentResult?.({}, '(empty directory)')).toMatchObject({ lineCount: 0, truncated: false });
  });
});

describe('todo_write', () => {
  it('declares a plan card over the list it wrote', async () => {
    const todo = (await builtins()).get('todo_write');
    const args = { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] };
    expect(todo?.presentResult?.(args, '[x] a\n[ ] b')).toEqual({
      card: 'plan',
      items: [
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'pending' },
      ],
    });
    expect(todo?.presentResult?.({ todos: 'nope' }, 'Error: todos must be an array')).toBeUndefined();
  });
});

describe('tools without a declaration', () => {
  it('render from the generic card instead of failing', async () => {
    const tools = await builtins();
    // jobs is a real built-in that Step 1 deliberately left undeclared: its
    // result is a table of handles, and the kind table still classifies it.
    const jobs = tools.get('jobs');
    expect(jobs).toBeDefined();
    expect(jobs?.presentCall).toBeUndefined();
  });
});
