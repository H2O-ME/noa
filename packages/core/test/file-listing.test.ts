/**
 * The `@` menu's listing and the reference-path guard.
 *
 * Both halves are asserted because they are one policy seen twice: what the
 * walk offers must be exactly what a resolved reference will accept, and
 * neither may reach outside the workspace.
 */
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspacePath, listWorkspaceFiles, SKIP_DIRS } from '../src/index.js';

/** A small workspace: two source files, a skipped tree, and a dot file. */
async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'nova-files-'));
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), 'top');
  await writeFile(path.join(root, 'src', 'main.ts'), 'main');
  await writeFile(path.join(root, 'src', 'deep', 'util.ts'), 'util');
  await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'dep');
  await writeFile(path.join(root, '.hidden'), 'dot');
  return root;
}

describe('listWorkspaceFiles', () => {
  it('lists the root\'s own children for an empty query', async () => {
    const root = await workspace();
    const { items } = await listWorkspaceFiles(root, '');
    const paths = items.map((entry) => entry.path);
    // A directory listing, not a walk: the root's children and nothing deeper
    // (the harness split — `src/` is how the menu descends).
    expect(paths).toContain('README.md');
    expect(paths).toContain('src');
    expect(paths).not.toContain('src/main.ts');
    // `node_modules` is skipped wholesale and a dot-file is not offered.
    expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    expect(paths).not.toContain('.hidden');
    // The skip list is the search tool's own policy, stated once.
    expect(SKIP_DIRS.has('node_modules')).toBe(true);
  });

  it('marks both kinds and sorts directories first', async () => {
    const root = await workspace();
    const { items } = await listWorkspaceFiles(root, 'src/');
    const kinds = items.map((entry) => `${entry.kind}:${entry.path}`);
    expect(kinds).toContain('directory:src/deep');
    expect(kinds).toContain('file:src/main.ts');
    // The harness listing's visible order: a directory row precedes a file row.
    const deep = kinds.findIndex((row) => row === 'directory:src/deep');
    const main = kinds.findIndex((row) => row === 'file:src/main.ts');
    expect(deep).toBeGreaterThanOrEqual(0);
    expect(main).toBeGreaterThan(deep);
  });

  it('a bare query walks the workspace by a substring of the relative path', async () => {
    const root = await workspace();
    const byPath = new Map(
      (await listWorkspaceFiles(root, 'main')).items.map((entry) => [entry.path, entry.kind]),
    );
    expect(byPath.get('src/main.ts')).toBe('file');
  });

  it('a dot-entry hides in a directory listing unless the query asks for dot-entries by name', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'src', '.hush'), 'dot');
    expect((await listWorkspaceFiles(root, 'src/')).items.map((entry) => entry.name))
      .not.toContain('.hush');
    expect((await listWorkspaceFiles(root, 'src/.')).items.map((entry) => entry.path))
      .toContain('src/.hush');
  });

  it('a directory query for a path outside the workspace answers empty', async () => {
    const root = await workspace();
    const { items, truncated } = await listWorkspaceFiles(root, '../');
    expect(items).toEqual([]);
    expect(truncated).toBe(false);
  });

  it('filters by a case-insensitive substring of the relative path', async () => {
    const root = await workspace();
    const { items } = await listWorkspaceFiles(root, 'UTIL');
    expect(items.map((entry) => entry.path)).toContain('src/deep/util.ts');
    // A query that matches nothing yields nothing rather than the whole tree.
    expect((await listWorkspaceFiles(root, 'no-such-name')).items).toEqual([]);
  });

  it('uses / separators so a reference is portable across platforms', async () => {
    const root = await workspace();
    const { items } = await listWorkspaceFiles(root, 'util');
    const hit = items.find((entry) => entry.name === 'util.ts');
    expect(hit?.path).toBe('src/deep/util.ts');
    expect(hit?.path).not.toContain('\\');
  });

  it('stops at the entry cap and says so', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-many-'));
    for (let i = 0; i < 12; i += 1) await writeFile(path.join(root, `f${String(i)}.txt`), 'x');
    const { items, truncated } = await listWorkspaceFiles(root, '', 5);
    expect(items).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it('reports a complete walk as untruncated', async () => {
    const root = await workspace();
    expect((await listWorkspaceFiles(root, 'main')).truncated).toBe(false);
  });

  it('never follows a symlink out of the workspace', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-link-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'nova-out-'));
    await writeFile(path.join(outside, 'secret.txt'), 'not yours');
    await symlink(outside, path.join(root, 'escape'), 'dir').catch(() => undefined);
    const { items } = await listWorkspaceFiles(root, 'secret');
    expect(items.map((entry) => entry.path)).not.toContain('escape/secret.txt');
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves a listing entry back to the file it named', async () => {
    const root = await workspace();
    const { items } = await listWorkspaceFiles(root, 'main.ts');
    const rel = items[0]?.path ?? '';
    expect(rel).toBe('src/main.ts');
    expect(resolveWorkspacePath(root, rel)).toBe(path.join(root, 'src', 'main.ts'));
  });

  it('refuses a path that climbs out of the workspace', async () => {
    const root = await workspace();
    expect(() => resolveWorkspacePath(root, '../../etc/passwd')).toThrow(/outside the workspace/);
    expect(() => resolveWorkspacePath(root, '../sibling.txt')).toThrow(/outside the workspace/);
  });

  it('refuses an absolute path that points elsewhere', async () => {
    const root = await workspace();
    const elsewhere = path.resolve(tmpdir(), 'elsewhere.txt');
    expect(() => resolveWorkspacePath(root, elsewhere)).toThrow(/outside the workspace/);
  });

  it('accepts the workspace root itself as a relative no-op', async () => {
    const root = await workspace();
    expect(resolveWorkspacePath(root, '.')).toBe(path.resolve(root));
  });
});
