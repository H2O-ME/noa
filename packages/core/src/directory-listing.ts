/**
 * One directory level, listed for a surface's workspace picker.
 *
 * The host is the only party that can see the filesystem, and a browser has no
 * folder chooser that yields a usable path (see below), so picking a workspace
 * means asking the host to enumerate: this is that enumeration, and it is the
 * whole reason the walk lives in core rather than in the surface that draws it.
 *
 * Two properties every caller depends on:
 *
 *  - **Directories only.** The job is choosing a folder, so files are not
 *    offered: a row a user can click but never open is noise, and leaving them
 *    out is most of what keeps a 10k-entry level small.
 *  - **Symlinks are never followed.** `withFileTypes` reports the link itself,
 *    so a symlinked directory is not `isDirectory()` and is skipped — the same
 *    rule the file listing and the search walk apply. A link is how a walk
 *    escapes the tree it was pointed at.
 *
 * Refusals throw (missing target, not a directory, unreadable): the surface
 * renders the reason, and "this directory cannot be listed" must not be
 * mistakable for "this directory is empty".
 *
 * Why not `showDirectoryPicker()`: it exists on a loopback origin (which is a
 * secure context), so it is not that the API is missing. It is that the
 * `FileSystemDirectoryHandle` it resolves **carries no path** — the page learns
 * `handle.name`, `handle.kind` and `isSameEntry`, never `D:\code\project`. This
 * product adopts a workspace by absolute path (the kernel re-roots bash, search
 * and the fs tools at it), so a handle the host cannot name is unusable; the
 * host's own enumeration is the only route that yields one.
 */
import os from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { listDirectoryRoots } from './directory-roots.js';
import { errMessage } from './errors.js';

export { MAX_DIRECTORY_NAME_CHARS, isSafeDirectoryName, createDirectory } from './directory-create.js';

/** One child of a listed level. */
export interface DirectoryEntry {
  /** Last path segment (the row's label). */
  name: string;
  /**
   * Absolute path of the child. Sent so the browser never joins a path itself:
   * only the host knows the platform's separators and how a path is spelled,
   * and a surface that concatenates its own would be a second implementation of
   * path layout.
   */
  path: string;
  /**
   * Dot-led, so the browser hides it by default. The fact is host-side because
   * only the host can see the real name; whether to show it is the surface's.
   */
  hidden: boolean;
  /**
   * File or directory.
   *
   * Present only when the caller asked for files too (`listDirectory` with
   * `includeFiles`), and then always. A directory-only listing has no use for
   * the field — every row is a directory by construction — so it is omitted
   * rather than sent as a constant the surface would then have to ignore.
   */
  kind?: 'dir' | 'file';
}

/** One breadcrumb in the chain from a root down to the listed level. */
export interface DirectoryCrumb {
  /** Last path segment; empty at a filesystem root (the surface labels it). */
  name: string;
  /** Absolute path this crumb jumps to. */
  path: string;
}

/** One listed directory level. */
export interface DirectoryLevel {
  /** Absolute path of the level itself. */
  path: string;
  /** The host home directory — the picker's start and its Home crumb. */
  home: string;
  /** Absolute parent, absent at a filesystem root. */
  parent?: string;
  /**
   * Root → level, trimmed to START at the home directory when the level sits
   * inside it (a chain from `/` down to a deep project is five useless clicks),
   * and the full ancestry otherwise.
   */
  crumbs: readonly DirectoryCrumb[];
  /**
   * Every reachable volume on this host, so a picker can offer the entry point
   * that the home subtree does not contain. On Windows that is the drive list
   * — without it a `D:` disk is unreachable, because a drive letter is a dead
   * end for `dirname` and the home directory lives on one drive only.
   */
  roots: readonly DirectoryCrumb[];
  entries: readonly DirectoryEntry[];
  /** True when the entry cap cut the level short (the level did not end). */
  truncated: boolean;
}

/** Child directories one level may carry onto the wire. */
export const MAX_DIRECTORY_ENTRIES = 500;
/**
 * Depth cap for the crumb chain. A path deeper than this is pathological; the
 * cap keeps a hostile or corrupt path from building an unbounded array.
 */
export const MAX_DIRECTORY_DEPTH = 64;

/**
 * The ancestor chain from a root down to `target`, trimmed to start at `home`
 * when `target` is inside it.
 * @param target - the absolute level being listed.
 * @param home - the host home directory.
 * @returns crumbs in root → level order.
 */
function crumbChain(target: string, home: string): DirectoryCrumb[] {
  const chain: DirectoryCrumb[] = [];
  let current = target;
  for (let i = 0; i < MAX_DIRECTORY_DEPTH; i += 1) {
    chain.push({ name: path.basename(current), path: current });
    const up = path.dirname(current);
    if (up === current) break;
    current = up;
  }
  chain.reverse();
  const homeAt = chain.findIndex((crumb) => crumb.path === home);
  return homeAt === -1 ? chain : chain.slice(homeAt);
}

/**
 * List one directory level.
 *
 * Directories only by default, because the job is usually choosing a folder: a
 * row a user can click but never open is noise, and leaving files out is most of
 * what keeps a 10k-entry level small. `includeFiles` is for the OTHER job — a
 * surface that needs a real path to a FILE (an attachment reference), which a
 * browser cannot obtain any other way. Then every row carries `kind`, so the
 * surface can draw and gate the two apart.
 *
 * Symlinks are never followed either way: `withFileTypes` reports the link
 * itself, so a symlinked directory is not `isDirectory()` and a symlinked file
 * is not `isFile()`. A link is how a walk escapes the tree it was pointed at.
 * @param dir - absolute directory to list; absent or empty means the home
 *   directory, which is where a picker starts.
 * @param home - the host home directory.
 * @param options.includeFiles - also list regular files (every row then carries
 *   `kind`). Off by default so the workspace picker's level stays a folder list.
 * @returns the level's crumbs, roots, entries and truncation flag.
 */
export async function listDirectory(
  dir?: string,
  home: string = os.homedir(),
  options: { includeFiles?: boolean } = {},
): Promise<DirectoryLevel> {
  const includeFiles = options.includeFiles === true;
  const target = dir === undefined || dir.trim() === '' ? home : path.resolve(dir);
  const info = await stat(target).catch(() => undefined);
  if (info === undefined) throw new Error(`目录不存在：${target}`);
  if (!info.isDirectory()) throw new Error(`不是目录：${target}`);
  // An unreadable level is a refusal, not an empty listing: the two look
  // identical to a user otherwise, and only one of them is worth retrying.
  const listing = await readdir(target, { withFileTypes: true }).catch((err: unknown) => {
    throw new Error(`无法读取目录：${errMessage(err)}`);
  });
  const entries: DirectoryEntry[] = [];
  let truncated = false;
  for (const entry of listing) {
    // `isDirectory()` is false for a symlink to a directory: not following is
    // what keeps the walk inside the tree the user pointed it at.
    const isDir = entry.isDirectory();
    if (!isDir && !(includeFiles && entry.isFile())) continue;
    if (entries.length >= MAX_DIRECTORY_ENTRIES) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      path: path.join(target, entry.name),
      hidden: entry.name.startsWith('.'),
      ...(includeFiles ? { kind: isDir ? ('dir' as const) : ('file' as const) } : {}),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(target);
  return {
    path: target,
    home,
    ...(parent === target ? {} : { parent }),
    crumbs: crumbChain(target, home),
    roots: await listDirectoryRoots(),
    entries,
    truncated,
  };
}
