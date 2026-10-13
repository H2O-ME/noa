/**
 * The workspace picker's directory enumeration.
 *
 * The properties asserted here are the ones a picker depends on and that a
 * casual refactor breaks: directories only (a file row can be clicked but never
 * opened), symlinks never followed (that is how a walk escapes its tree), a
 * refusal distinguished from an empty level (an unreadable mount must not look
 * like an empty folder), and a name guard that cannot be talked into creating
 * outside its parent.
 */
import { mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDirectory,
  isSafeDirectoryName,
  listDirectory,
  listDirectoryRoots,
  MAX_DIRECTORY_ENTRIES,
} from '../src/index.js';

/** A level with two subdirectories, a file, a dot directory and a symlink. */
async function level(): Promise<{ root: string; home: string }> {
  const base = await mkdtemp(path.join(tmpdir(), 'nova-dirs-'));
  const root = path.join(base, 'home');
  await mkdir(path.join(root, 'projects', 'alpha'), { recursive: true });
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, '.config'), { recursive: true });
  await writeFile(path.join(root, 'readme.txt'), 'text');
  await symlink(path.join(root, 'notes'), path.join(root, 'linked')).catch(() => undefined);
  return { root, home: root };
}

describe('listDirectory', () => {
  it('offers directories only, each with its absolute path', async () => {
    const { root } = await level();
    const listed = await listDirectory(root, root);
    const names = listed.entries.map((entry) => entry.name);
    expect(names).toContain('notes');
    expect(names).toContain('projects');
    // A file is never a candidate workspace.
    expect(names).not.toContain('readme.txt');
    // Each row carries the host's own join, so the browser never builds a path.
    const notes = listed.entries.find((entry) => entry.name === 'notes');
    expect(notes?.path).toBe(path.join(root, 'notes'));
  });

  it('never follows a symlink to a directory', async () => {
    const { root } = await level();
    const listed = await listDirectory(root, root);
    // `linked` points at a real directory but is not itself one: following it is
    // how a picker would walk outside the tree the user pointed at.
    expect(listed.entries.map((entry) => entry.name)).not.toContain('linked');
  });

  it('flags dot entries as hidden rather than dropping them', async () => {
    const { root } = await level();
    const listed = await listDirectory(root, root);
    // The host owns the fact; whether to show it belongs to the surface.
    expect(listed.entries.find((entry) => entry.name === '.config')?.hidden).toBe(true);
    expect(listed.entries.find((entry) => entry.name === 'notes')?.hidden).toBe(false);
  });

  it('trims the crumb chain to start at the home directory', async () => {
    const { root } = await level();
    const deep = path.join(root, 'projects', 'alpha');
    const listed = await listDirectory(deep, root);
    // Root → level, but starting at home: the drive root and the account
    // directory above it are not choices a user makes here.
    expect(listed.crumbs.map((crumb) => crumb.path)).toEqual([root, path.join(root, 'projects'), deep]);
    expect(listed.home).toBe(root);
    expect(listed.parent).toBe(path.join(root, 'projects'));
  });

  it('treats an absent or empty path as the home directory', async () => {
    const { root } = await level();
    // Both spellings are one request: the picker opens with no path at all.
    expect((await listDirectory(undefined, root)).path).toBe(root);
    expect((await listDirectory('', root)).path).toBe(root);
  });

  it('refuses a missing target, a file, and reports each distinctly', async () => {
    const { root } = await level();
    // A refusal must be an error, not an empty listing: "cannot look" and
    // "nothing there" are different facts and only one is worth retrying.
    await expect(listDirectory(path.join(root, 'nope'), root)).rejects.toThrow(/不存在/);
    await expect(listDirectory(path.join(root, 'readme.txt'), root)).rejects.toThrow(/不是目录/);
  });

  it('reports truncation instead of silently shortening a huge level', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'nova-many-'));
    // Created concurrently: one `mkdir` per entry serially costs seconds on
    // Windows and used to time the whole test out under a loaded runner, which
    // read as a truncation bug rather than a slow fixture.
    await Promise.all(
      Array.from({ length: MAX_DIRECTORY_ENTRIES + 5 }, (_, i) =>
        mkdir(path.join(base, `d${String(i).padStart(4, '0')}`)),
      ),
    );
    const listed = await listDirectory(base, base);
    // Truncation is REPORTED, never silent: "there is no more" and "we did not
    // finish looking" are different answers, and a picker that conflates them
    // hides a reachable directory.
    expect(listed.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(listed.truncated).toBe(true);
  }, 60_000);

  it('carries the host reaches roots with every level', async () => {
    const { root } = await level();
    const listed = await listDirectory(root, root);
    // Without this a picker can only walk down from home, and on Windows the
    // drive home sits on is the only one it can ever reach: `dirname('C:\')` is
    // `C:\`, so every other volume is unreachable no matter how far up the user
    // clicks. The roots are the host's fact, reported with the level.
    expect(listed.roots.length).toBeGreaterThan(0);
    for (const entry of listed.roots) {
      // A root's own basename is '' on both platforms, so it is labeled by its
      // path — that is the row text a user clicks.
      expect(entry.name).toBe(entry.path);
    }
  });
});

describe('listDirectoryRoots', () => {
  it('reports the POSIX root as "/"', async () => {
    expect(await listDirectoryRoots('linux')).toEqual([{ name: '/', path: '/' }]);
  });

  it('offers only the Windows drives that can actually be stat-ed', async () => {
    // An empty optical drive and an unassigned letter both fail; a row that
    // errors on click is worse than no row, so the probe is what decides.
    const roots = await listDirectoryRoots('win32');
    for (const entry of roots) {
      expect(entry.path).toMatch(/^[A-Z]:\\$/);
      expect((await stat(entry.path)).isDirectory()).toBe(true);
    }
  });
});

describe('createDirectory', () => {
  it('creates one child and returns its path', async () => {
    const { root } = await level();
    const created = await createDirectory(root, 'fresh');
    expect(created).toBe(path.join(root, 'fresh'));
    expect((await listDirectory(root, root)).entries.map((entry) => entry.name)).toContain('fresh');
  });

  it('refuses a name that already exists rather than adopting it', async () => {
    const { root } = await level();
    // Silently handing back somebody else's directory would make "created" a
    // claim the host cannot support.
    await expect(createDirectory(root, 'notes')).rejects.toThrow(/已存在/);
  });

  it('refuses a name that would escape or address a path', async () => {
    const { root } = await level();
    await expect(createDirectory(root, '..')).rejects.toThrow(/不合法/);
    await expect(createDirectory(root, 'a/b')).rejects.toThrow(/不合法/);
    await expect(createDirectory(root, 'a\\b')).rejects.toThrow(/不合法/);
    await expect(createDirectory(root, '')).rejects.toThrow(/不合法/);
  });
});

describe('isSafeDirectoryName', () => {
  it('accepts ordinary names and refuses everything that is not one segment', () => {
    expect(isSafeDirectoryName('my-project')).toBe(true);
    expect(isSafeDirectoryName('项目')).toBe(true);
    expect(isSafeDirectoryName('a b')).toBe(true);
    for (const bad of ['.', '..', '', ' lead', 'trail ', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b']) {
      expect(isSafeDirectoryName(bad)).toBe(false);
    }
    expect(isSafeDirectoryName('x'.repeat(65))).toBe(false);
  });
});
