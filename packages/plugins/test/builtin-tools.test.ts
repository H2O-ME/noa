import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { JobRegistry, shell as shellKey, typeStrippingAvailable, type TodoItem } from '@noa/core';
import { PluginHost, builtinPlugins, READ_MAX_BYTES } from '../src/index.js';
import { configuredRowsOf, rowsOf } from './plugin-rows.js';
import { bashOnPath } from '../src/builtin/shell-select.js';
import { BudgetedBuffer } from '../src/builtin/bash.js';
import { screenContentRegex } from '../src/builtin/search.js';

async function activatedHost(): Promise<{ host: PluginHost; jobs: JobRegistry; emitted: unknown[] }> {
  const host = new PluginHost('.');
  const jobs = new JobRegistry();
  const emitted: unknown[] = [];
  await host.sync(rowsOf(builtinPlugins({ rootDir: () => host.rootDir })));
  return { host, jobs, emitted };
}

async function fsHostAt(root: string): Promise<PluginHost> {
  const host = new PluginHost(root);
  await host.sync(rowsOf(builtinPlugins({ rootDir: () => host.rootDir })));
  return host;
}

describe('todo plugin', () => {
  it('replaces the whole list and emits a log-only todo/write event', async () => {
    const { host, emitted } = await activatedHost();
    const todo = host.tools.find((t) => t.name === 'todo_write')!;
    const todos: TodoItem[] = [
      { content: 'investigate failure', status: 'completed' },
      { content: 'apply fix', status: 'in_progress' },
      { content: 're-run tests', status: 'pending' },
    ];
    const result = await todo.execute({ todos }, { rootDir: '.', emit: (evt) => void emitted.push(evt) });

    expect(result).toContain('[x] investigate failure');
    expect(result).toContain('[~] apply fix');
    expect(result).toContain('[ ] re-run tests');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'todo/write', todos });
  });

  it('rejects malformed entries', async () => {
    const { host } = await activatedHost();
    const todo = host.tools.find((t) => t.name === 'todo_write')!;
    expect(await todo.execute({ todos: [{ content: 'x', status: 'done' }] }, { rootDir: '.' })).toContain('Error:');
    expect(await todo.execute({ todos: 'nope' }, { rootDir: '.' })).toContain('Error:');
  });
});

describe('jobs plugin', () => {
  it('lists, reads output, and stops registered jobs', async () => {
    const { host, jobs } = await activatedHost();
    const tool = host.tools.find((t) => t.name === 'jobs')!;

    jobs.start({
      kind: 'bash', sessionId: '',
      label: 'tail -f log',
      cancel: () => {},
      done: new Promise(() => {}),
      readOutput: (() => {
        let released = false;
        return () => {
          if (released) return '';
          released = true;
          return 'booting…';
        };
      })(),
    });

    const list = await tool.execute({ action: 'list' }, { rootDir: '.', jobs });
    expect(list).toContain('bash-1');
    expect(list).toContain('tail -f log');

    const output = await tool.execute({ action: 'output', id: 'bash-1' }, { rootDir: '.', jobs });
    expect(output).toContain('booting…');

    const second = await tool.execute({ action: 'output', id: 'bash-1' }, { rootDir: '.', jobs });
    expect(second).toContain('no new output');

    const stopped = await tool.execute({ action: 'stop', id: 'bash-1' }, { rootDir: '.', jobs });
    expect(stopped).toContain('Stop requested');
  });

  it('reports missing registry and unknown ids', async () => {
    const { host } = await activatedHost();
    const tool = host.tools.find((t) => t.name === 'jobs')!;
    expect(await tool.execute({ action: 'list' }, { rootDir: '.' })).toContain('No background jobs available');
    expect(await tool.execute({ action: 'output', id: 'nope' }, { rootDir: '.', jobs: new JobRegistry() })).toContain(
      'unknown job',
    );
  });
});

describe('BudgetedBuffer (bash output head+tail capture)', () => {
  it('keeps the last line when output overflows the budget', () => {
    const buf = new BudgetedBuffer(100);
    // 40-byte lines; 100-byte budget → head 60 + tail 40. 10 lines overflow.
    for (let i = 1; i <= 10; i++) buf.push(Buffer.from(`line-${String(i).padStart(2, '0')}-abcdefghij\n`));
    const { text, dropped } = buf.drain();
    // Head: first line(s). Tail: the LAST full line must survive intact.
    expect(text).toContain('line-10-abcdefghij\n');
    expect(text).toContain('line-01-abcdefghij\n');
    expect(dropped).toBeGreaterThan(0);
    // No mid-output garbage: consecutive full lines only.
    expect(text.split('\n').filter((l) => l.length > 0)).not.toContain('');
  });

  it('drains: a second read only sees new output', () => {
    const buf = new BudgetedBuffer(1024);
    buf.push(Buffer.from('first-batch\n'));
    const first = buf.drain();
    expect(first.text).toBe('first-batch\n');
    expect(first.dropped).toBe(0);
    buf.push(Buffer.from('second-batch\n'));
    expect(buf.drain().text).toBe('second-batch\n');
  });

  it('keeps output verbatim while under the budget', () => {
    const buf = new BudgetedBuffer(1024);
    buf.push(Buffer.from('small\n'));
    const { text, dropped } = buf.drain();
    expect(text).toBe('small\n');
    expect(dropped).toBe(0);
  });
} );

describe('bash plugin', () => {
  it('publishes the shell it runs commands in, and withdraws it when the row goes', async () => {
    // The `shell` seam exists so the host never names the plugin that executes
    // commands. The context fragment tells the model `shell=<name>`, so that
    // value has to come from whoever OWNS shell execution: reading bash's config
    // from the host would go stale the moment `shellPath` changes (or the plugin
    // is swapped). Two claims: the service reflects THIS row's config, and it
    // disappears with the row because `ctx.provide` is a fiber effect.
    const host = new PluginHost('.');
    // A deliberately bogus path: the point is that the published name follows the
    // ROW's setting, not the machine's PATH probe.
    const configured = path.join('C:', 'custom-tools', 'my-shell.exe');
    await host.sync(configuredRowsOf(builtinPlugins({ rootDir: () => host.rootDir }), { bash: { shellPath: configured } }));
    expect(host.context.get(shellKey)).toEqual({ name: 'my-shell', path: configured });

    // Switching the row off must take the service with it — otherwise the prompt
    // would keep claiming a shell that no longer runs anything.
    await host.sync(rowsOf(builtinPlugins({ rootDir: () => host.rootDir })).filter((row) => row.id !== 'bash'));
    expect(host.context.get(shellKey)).toBeUndefined();
  });

  it.runIf(bashOnPath())('the result names the directory the command ran in', async () => {
    // The cwd is the one fact a result cannot imply: when it ever disagrees
    // with <environment> cwd, every relative command answered about the wrong
    // tree — and a result that omits it cannot show the difference.
    const host = new PluginHost('.');
    await host.sync(rowsOf(builtinPlugins({ rootDir: () => host.rootDir })));
    const tool = host.tools.find((t) => t.name === 'bash')!;

    const result = await tool.execute({ command: 'echo hi' }, { rootDir: process.cwd() });
    expect(result.split('\n')[0]).toBe(`cwd: ${process.cwd()}`);
    expect(result).toContain('stdout:\nhi');
  }, 20_000);
  it.runIf(bashOnPath())('foreground runOnce keeps the most recent output past the cap', async () => {
    const host = new PluginHost('.');
    // Tiny cap so a 500-line seq overflows: head 60% + tail 40% ring.
    await host.sync(configuredRowsOf(builtinPlugins({ rootDir: () => host.rootDir }), { bash: { maxOutputBytes: 200 } }));
    const tool = host.tools.find((t) => t.name === 'bash')!;

    const result = await tool.execute({ command: 'seq 1 500' }, { rootDir: '.' });
    expect(result).toContain('500'); // the LAST emitted line must survive
    expect(result).toContain('1'); // and the head
    expect(result).toContain('truncated'); // the middle drop is reported, not silent
  }, 20_000);
  // Requires a POSIX shell (Git Bash on Windows); PowerShell has no `sleep`.
  it.runIf(bashOnPath())('kills a command past the timeout and settles deterministically', async () => {
    const host = new PluginHost('.');
    await host.sync(configuredRowsOf(builtinPlugins({ rootDir: () => host.rootDir }), { bash: { timeoutMs: 1000 } }));
    const tool = host.tools.find((t) => t.name === 'bash')!;

    const started = Date.now();
    const result = await tool.execute({ command: 'sleep 30' }, { rootDir: '.' });
    const elapsed = Date.now() - started;

    // The timeout (1s) + tree kill + forced settle must stay far below the
    // 30s the command itself would run; close-never-fires must not hang it.
    expect(elapsed).toBeLessThan(10_000);
    expect(result).toContain('did not exit');
  }, 20_000);

  it.runIf(bashOnPath())('settles a background job kill within bounds instead of hanging dispose', async () => {
    // The background path mirrors the foreground one: a Windows tree kill can
    // leave the stdio pipes held by grandchildren, and a done promise waiting
    // on `close` alone would hang `jobs.dispose()` at teardown forever.
    const host = new PluginHost('.');
    await host.sync(configuredRowsOf(builtinPlugins({ rootDir: () => host.rootDir }), { bash: { timeoutMs: 1000 } }));
    const tool = host.tools.find((t) => t.name === 'bash')!;
    const jobs = new JobRegistry();

    const started = await tool.execute(
      { command: 'sleep 30', run_in_background: true },
      { rootDir: '.', jobs },
    );
    expect(started).toMatch(/^Started background job bash-1/);
    jobs.stop('bash-1', 'test kill');

    const t0 = Date.now();
    await jobs.dispose();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(jobs.get('bash-1')?.status).toBe('killed');
    // A killed job carries NO detail: its exit code is deliberately null, so
    // any "exit code: …" string would be noise the status word already covers.
    expect(jobs.get('bash-1')?.detail).toBeUndefined();
  }, 20_000);
});

describe('fs sandbox', () => {
  it('write_file rejects a symlink pointing outside the workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'nova-outside-'));
    const link = path.join(root, 'escape');
    try {
      await symlink(outside, link, 'dir');
    } catch {
      // Platform without symlink privilege (Windows without dev mode) —
      // the mechanism cannot be exercised here; the guard still applies.
      return;
    }
    const host = await fsHostAt(root);
    const write = host.tools.find((t) => t.name === 'write_file')!;

    await expect(write.execute({ path: 'escape/pwned.txt', content: 'x' }, { rootDir: root })).rejects.toThrow(
      /escapes workspace root/,
    );
    // The real target must not have been created through the link.
    expect(await readFile(path.join(outside, 'pwned.txt'), 'utf8').catch(() => undefined)).toBeUndefined();
  });

  it('read_file names the closest workspace path when the path is one segment short', async () => {
    // The observed miss (2026-10-01): a mention `@repo/docs/agents_md.md` was
    // read as `docs/agents_md.md`, the model then combed the tree for four more
    // calls. The answer must name the real path instead of only saying no.
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    await mkdir(path.join(root, 'repo', 'docs'), { recursive: true });
    await writeFile(path.join(root, 'repo', 'docs', 'agents_md.md'), 'content', 'utf8');
    const host = await fsHostAt(root);
    const read = host.tools.find((t) => t.name === 'read_file')!;

    const miss = await read.execute({ path: 'docs/agents_md.md' }, { rootDir: root });
    expect(miss).toContain('Error: file not found: docs/agents_md.md');
    expect(miss).toContain('Closest path in the workspace: repo/docs/agents_md.md');
    // The hint is actionable as written.
    expect(await read.execute({ path: 'repo/docs/agents_md.md' }, { rootDir: root })).toBe('content');
  });

  it('read_file says only "not found" when nothing in the workspace resembles the path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const read = host.tools.find((t) => t.name === 'read_file')!;
    expect(await read.execute({ path: 'nope.txt' }, { rootDir: root })).toBe('Error: file not found: nope.txt');
  });

  it('read_file classifies a symlinked outside path as read-external', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'nova-outside-'));
    await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
    const link = path.join(root, 'sneak');
    try {
      await symlink(outside, link, 'dir');
    } catch {
      return; // no symlink privilege — nothing to assert
    }
    const host = await fsHostAt(root);
    const read = host.tools.find((t) => t.name === 'read_file')!;
    expect(await read.permissionFor?.({ path: 'sneak/secret.txt' })).toBe('read-external');
  });

  it('read_file treats the spill cache root as trusted (auto-read, no approval gate)', async () => {
    // Truncated tool results spill to ~/.noa/cache/tool-outputs/; the hint in
    // the message log tells the model to read them back, so that path must
    // classify as 'read' rather than send every turn through the approval gate.
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const spill = await mkdtemp(path.join(tmpdir(), 'nova-spill-'));
    await writeFile(path.join(spill, 'full.txt'), 'the full spill', 'utf8');
    const host = new PluginHost(root);
    // The auto-readable roots are ONE live list: the spill directory is an
    // ordinary member of it (it comes from a service row, hence the thunk), not a
    // special case of its own.
    await host.sync(rowsOf(builtinPlugins({ trustedReadRoots: () => [spill], rootDir: () => host.rootDir })));
    const read = host.tools.find((t) => t.name === 'read_file')!;
    expect(await read.permissionFor?.({ path: path.join(spill, 'full.txt') })).toBe('read');
    expect(await read.execute({ path: path.join(spill, 'full.txt') }, { rootDir: root })).toBe('the full spill');
    // Unrelated out-of-workspace paths still need approval …
    expect(await read.permissionFor?.({ path: path.join(tmpdir(), 'something-else.txt') })).toBe('read-external');
    // … and the search tool shares the exemption for its own classification.
    const search = host.tools.find((t) => t.name === 'search_files')!;
    expect(await search.permissionFor?.({ path: spill })).toBe('read');
  });

  it('edit_file rejects edits of a stale snapshot (file changed since last read)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const write = host.tools.find((t) => t.name === 'write_file')!;
    const read = host.tools.find((t) => t.name === 'read_file')!;
    const edit = host.tools.find((t) => t.name === 'edit_file')!;
    const file = path.join(root, 'a.txt');

    await write.execute({ path: 'a.txt', content: 'version one\nmiddle\nend' }, { rootDir: root });
    await read.execute({ path: 'a.txt' }, { rootDir: root });
    // External change between the read and the edit (user, or another tool).
    await writeFile(file, 'v2\nmiddle\nend', 'utf8');
    expect(await edit.execute({ path: 'a.txt', old_string: 'middle', new_string: 'CHANGED' }, { rootDir: root })).toContain(
      'stale',
    );

    // A fresh read resets the baseline; the identical edit now applies.
    await read.execute({ path: 'a.txt' }, { rootDir: root });
    expect(await edit.execute({ path: 'a.txt', old_string: 'middle', new_string: 'CHANGED' }, { rootDir: root })).toContain(
      '1 occurrence',
    );
    expect(await readFile(file, 'utf8')).toBe('v2\nCHANGED\nend');
  });

  it('edit_file refuses an oversized file and one that looks binary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const edit = host.tools.find((t) => t.name === 'edit_file')!;

    // Oversize: over the 8 MiB edit cap (aligned with read_file's cap).
    const big = path.join(root, 'big.txt');
    await writeFile(big, 'x'.repeat(8 * 1024 * 1024 + 1), 'utf8');
    expect(await edit.execute({ path: 'big.txt', old_string: 'x', new_string: 'y' }, { rootDir: root })).toContain(
      'edit cap',
    );

    // Binary: control bytes (NUL) read as text trip looksBinary.
    const bin = path.join(root, 'blob.bin');
    await writeFile(bin, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    expect(await edit.execute({ path: 'blob.bin', old_string: 'x', new_string: 'y' }, { rootDir: root })).toContain(
      'binary',
    );
  });

  it('edit_file inserts $ sequences verbatim (never as RegExp replacement tokens)', async () => {
    // Regression: a string replacer expands $&/$1/`$`/`$'`/`$$`, so editing in
    // a price like `$&10` or an escaped capture `$1` used to silently garble
    // the file. Function replacers must write the characters literally.
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const write = host.tools.find((t) => t.name === 'write_file')!;
    const read = host.tools.find((t) => t.name === 'read_file')!;
    const edit = host.tools.find((t) => t.name === 'edit_file')!;

    const file = path.join(root, 'money.txt');
    await write.execute({ path: 'money.txt', content: 'item: base cost' }, { rootDir: root });
    await read.execute({ path: 'money.txt' }, { rootDir: root });
    // newString carries $& — a string replacer would copy the whole match in.
    await edit.execute({ path: 'money.txt', old_string: 'base cost', new_string: '$&10 (plus $1 and $$20)' }, { rootDir: root });
    expect(await readFile(file, 'utf8')).toBe('item: $&10 (plus $1 and $$20)');

    // replace_all with backtick/quote tokens likewise stays literal.
    await write.execute({ path: 'money.txt', content: 'raw\nraw' }, { rootDir: root });
    await read.execute({ path: 'money.txt' }, { rootDir: root });
    await edit.execute({ path: 'money.txt', old_string: 'raw', new_string: "`$'` edge", replace_all: true }, { rootDir: root });
    expect(await readFile(file, 'utf8')).toBe("`$'` edge\n`$'` edge");
  });

  it('edit_file keeps $ sequences literal through the multi-line CRLF fallback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const write = host.tools.find((t) => t.name === 'write_file')!;
    const read = host.tools.find((t) => t.name === 'read_file')!;
    const edit = host.tools.find((t) => t.name === 'edit_file')!;

    const file = path.join(root, 'crlf.txt');
    // CRLF content; exact multi-line match misses, so tolerantReplace runs.
    await write.execute({ path: 'crlf.txt', content: 'total\r\ncost' }, { rootDir: root });
    await read.execute({ path: 'crlf.txt' }, { rootDir: root });
    await edit.execute({ path: 'crlf.txt', old_string: 'total\ncost', new_string: 'sum $&' }, { rootDir: root });
    expect(await readFile(file, 'utf8')).toBe('sum $&');
  });

  it('write_file requires string content instead of silently writing empty', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const write = host.tools.find((t) => t.name === 'write_file')!;
    await write.execute({ path: 'ok.txt', content: 'fine' }, { rootDir: root });
    expect(await write.execute({ path: 'ok.txt', content: { bad: true } }, { rootDir: root })).toContain(
      'Error: content must be a string',
    );
    expect(await readFile(path.join(root, 'ok.txt'), 'utf8')).toBe('fine');
  });

  it('read_file refuses oversized and binary files up front', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    const host = await fsHostAt(root);
    const read = host.tools.find((t) => t.name === 'read_file')!;

    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(READ_MAX_BYTES + 1), 'utf8');
    expect(await read.execute({ path: 'big.txt' }, { rootDir: root })).toContain('read cap');

    await writeFile(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]), { flag: 'wx' });
    expect(await read.execute({ path: 'bin.dat' }, { rootDir: root })).toContain('binary');
  });
});

describe('list_dir', () => {
  it('carries file sizes in bytes so it beats shell ls informationally', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-fs-'));
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'a.txt'), '12345', 'utf8');
    const host = await fsHostAt(root);
    const list = host.tools.find((t) => t.name === 'list_dir')!;
    const out = await list.execute({ path: '.' }, { rootDir: root });
    expect(out).toContain(`f 5 a.txt`);
    expect(out).toContain('d sub');
  });
});

describe('search_files', () => {
  it('finds content matches and name globs, skipping node_modules and dot-dirs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-search-'));
    const host = await fsHostAt(root);
    const search = host.tools.find((t) => t.name === 'search_files')!;
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.ts'), 'export const answer = 42;\n', { flag: 'wx' });
    await writeFile(path.join(root, 'src', 'b.test.ts'), 'it("works", () => expect(1).toBe(1));\n', { flag: 'wx' });
    await writeFile(path.join(root, 'node_modules', 'dep', 'index.ts'), 'export const answer = 42;\n', { flag: 'wx' });
    await writeFile(path.join(root, '.git', 'config'), 'answer = 42\n', { flag: 'wx' });

    const byContent = await search.execute({ content_regex: 'answer = 42' }, { rootDir: root });
    expect(byContent).toContain('src/a.ts:1:');
    expect(byContent).not.toContain('node_modules');
    expect(byContent).not.toContain('.git');

    const byName = await search.execute({ name_glob: '**/*.test.ts' }, { rootDir: root });
    expect(byName).toBe('src/b.test.ts');
  });

  it('validates arguments and reports missing mode', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-search-'));
    const host = await fsHostAt(root);
    const search = host.tools.find((t) => t.name === 'search_files')!;
    expect(await search.execute({}, { rootDir: root })).toContain('Error: provide name_glob or content_regex');
    expect(await search.execute({ content_regex: '(' }, { rootDir: root })).toContain('Error: invalid content_regex');
    expect(await search.execute({ name_glob: '*.ts' }, { rootDir: root })).toBe('(no matches)');
  });

  it('refuses catastrophic-backtracking regex shapes up front (both paths)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-search-'));
    await writeFile(path.join(root, 'a.txt'), `${'a'.repeat(40)}b\n`, 'utf8');
    const host = new PluginHost(root);
    await host.sync(rowsOf(builtinPlugins({ rootDir: () => host.rootDir })));
    const search = host.tools.find((t) => t.name === 'search_files')!;
    // (a+)+b — quantifier inside a quantified group: the textbook shape.
    const screened = await search.execute({ content_regex: '(a+)+b' }, { rootDir: root });
    expect(screened).toContain('Error: content_regex looks prone to catastrophic backtracking');

    // The screen itself is exported and directly testable.
    expect(screenContentRegex('a'.repeat(600))).toContain('over the 512 cap');
    expect(screenContentRegex('a'.repeat(40) + '+'.repeat(40))).toContain('quantifiers');
    expect(screenContentRegex('answer = 42')).toBeUndefined();
    expect(screenContentRegex('^\\w+@\\w+\\.\\w+$')).toBeUndefined();
    // (a|a)*b slips past the static screen — the worker wall clock is the
    // backstop for exactly this class (no quantifier inside the group).
    expect(screenContentRegex('(a|a)*b')).toBeUndefined();
  });

  it.runIf(typeStrippingAvailable())('terminates a runaway content_regex worker at the wall clock', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-search-redos-'));
    // A single line long enough that (a+)+b backtracks for far past the cap:
    // no match, so every split path is explored.
    await writeFile(path.join(root, 'bomb.txt'), `${'a'.repeat(28)}x\n`, 'utf8');
    const host = new PluginHost(root);
    await host.sync(configuredRowsOf(builtinPlugins({ rootDir: () => host.rootDir }), { search: { wallMs: 800 } }));
    const search = host.tools.find((t) => t.name === 'search_files')!;

    const started = Date.now();
    const result = await search.execute({ content_regex: '(a|a)*b' }, { rootDir: root });
    const elapsed = Date.now() - started;
    // The pattern slipped past the static screen but the worker wall clock
    // still cut it — the host event loop stayed responsive throughout.
    expect(result).toContain('wall-clock budget');
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);

  it.runIf(typeStrippingAvailable())('aborts an in-flight worker search when the signal fires', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-search-abort-'));
    await writeFile(path.join(root, 'slow.txt'), `${'a'.repeat(28)}x\n`, 'utf8');
    const host = new PluginHost(root);
    await host.sync(configuredRowsOf(builtinPlugins({ rootDir: () => host.rootDir }), { search: { wallMs: 30_000 } }));
    const search = host.tools.find((t) => t.name === 'search_files')!;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const result = await search.execute(
      { content_regex: '(a|a)*b' },
      { rootDir: root, signal: controller.signal },
    );
    expect(result).toContain('aborted');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);
});

describe('approval previews', () => {
  it('renders write_file and edit_file previews without mutating anything', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-preview-'));
    const host = await fsHostAt(root);
    const write = host.tools.find((t) => t.name === 'write_file')!;
    const edit = host.tools.find((t) => t.name === 'edit_file')!;

    const writePreview = await write.preview?.({ path: 'new.txt', content: 'hello world' }, { rootDir: root });
    expect(writePreview).toContain('写入 new.txt');
    expect(writePreview).toContain('hello world');

    await write.execute({ path: 'a.txt', content: 'aaa\nbbb\nccc' }, { rootDir: root });
    const editPreview = await edit.preview?.({ path: 'a.txt', old_string: 'bbb', new_string: 'BBB' }, { rootDir: root });
    expect(editPreview).toContain('编辑 a.txt（1 处替换）');
    expect(editPreview).toContain('- bbb');
    expect(editPreview).toContain('+ BBB');
    // Preview is read-only: the file on disk is untouched.
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('aaa\nbbb\nccc');

    // Multi-hit WITHOUT replace_all is rejected by execute() — the preview
    // must not promise "N 处替换".
    await write.execute({ path: 'b.txt', content: 'xx\nxx\nxx' }, { rootDir: root });
    const multiPreview = await edit.preview?.({ path: 'b.txt', old_string: 'xx', new_string: 'YY' }, { rootDir: root });
    expect(multiPreview).toContain('命中 3 处，执行将报错');
    expect(multiPreview).not.toContain('3 处替换');
    // ...but WITH replace_all the same hit count is honestly a replacement.
    const multiAllPreview = await edit.preview?.(
      { path: 'b.txt', old_string: 'xx', new_string: 'YY', replace_all: true },
      { rootDir: root },
    );
    expect(multiAllPreview).toContain('编辑 b.txt（3 处替换）');
  });
});
