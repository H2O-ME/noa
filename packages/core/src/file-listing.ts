/**
 * Workspace file listing for the composer's `@` menu.
 *
 * A completion menu needs a *bounded* answer: the browser asks on every
 * keystroke, so this walk stops at a cap and reports that it did, rather than
 * enumerating a 40k-file tree and putting it on the wire. The policy is the
 * search tool's own (skip VCS and dependency trees, never follow symlinks) so
 * the menu offers what a search would find and never walks out of the
 * workspace through a link.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { listDirectoryChildren } from './file-listing-directory.js';

/** One entry the `@` menu can offer. */
export interface FileEntry {
  /** Workspace-relative path with `/` separators (the form `@` inserts). */
  path: string;
  /** Last path segment (the row's label). */
  name: string;
  kind: 'file' | 'directory';
}

/**
 * Directories the walk never enters: version control and dependency/build
 * trees. They are huge, never what a user is referring to, and walking them
 * would spend the entry cap on `node_modules` before reaching any source.
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist']);

/**
 * One workspace listing.
 * @param root - the workspace root to walk.
 * @param query - the text after `@`. Two modes, the harness split: a query
 *   carrying `/` (or an empty one) names a directory and lists that
 *   directory's own children — `src/` lists `src`, so a drill sees the folder
 *   it descended into; a bare word is matched case-insensitively against the
 *   relative path across the workspace.
 * @param limit - maximum entries to return.
 * @param budgetMs - wall-clock ceiling; the walk stops when it expires.
 * @returns the matching entries and whether the walk was cut short.
 */
export interface FileListingResult {
  items: FileEntry[];
  /** True when a cap (entry count or the time budget) stopped the walk. */
  truncated: boolean;
}

/** Default entry cap: enough for a menu, small enough for every keystroke. */
export const DEFAULT_FILE_LIST_LIMIT = 200;
/**
 * Wall-clock ceiling for one listing. The menu re-asks per keystroke, so a
 * cold network filesystem must not hold the socket open: whatever the walk
 * reached is returned, flagged as truncated.
 */
export const DEFAULT_FILE_LIST_BUDGET_MS = 1_000;

export async function listWorkspaceFiles(
  root: string,
  query: string,
  limit: number = DEFAULT_FILE_LIST_LIMIT,
  budgetMs: number = DEFAULT_FILE_LIST_BUDGET_MS,
): Promise<FileListingResult> {
  // The grammar writes `/` (the reference never inserts a native separator),
  // but the draft is user-editable: a hand-typed `\` means the same path.
  const normalized = query.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  if (normalized === '' || slash >= 0) {
    const directory = slash < 0 ? '' : normalized.slice(0, slash + 1);
    const fragment = slash < 0 ? '' : normalized.slice(slash + 1);
    return listDirectoryChildren(root, directory, fragment, limit, budgetMs);
  }
  const needle = normalized.toLowerCase();
  const items: FileEntry[] = [];
  const deadline = Date.now() + budgetMs;
  let truncated = false;

  /** Breadth-first so shallow entries (what a user means) win the cap. */
  const queue: string[] = [root];
  while (queue.length > 0) {
    if (items.length >= limit) {
      truncated = true;
      break;
    }
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    const dir = queue.shift();
    if (dir === undefined) break;
    // An unreadable directory (locked, permissions, deleted mid-walk) yields
    // nothing rather than failing the whole listing.
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) continue;
    for (const entry of entries) {
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      const absolute = path.join(dir, entry.name);
      // Relative, `/`-separated: the reference grammar writes this into a
      // draft, so the host never hands the browser a native separator.
      const rel = path.relative(root, absolute).split(path.sep).join('/');
      // `withFileTypes` reports the link itself, not its target: a symlink is
      // neither directory nor file here, so it is skipped without being
      // followed — the same rule the search walk applies.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        queue.push(absolute);
        if (needle === '' || rel.toLowerCase().includes(needle)) {
          items.push({ path: rel, name: entry.name, kind: 'directory' });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      if (needle !== '' && !rel.toLowerCase().includes(needle)) continue;
      items.push({ path: rel, name: entry.name, kind: 'file' });
    }
  }
  return { items, truncated };
}

/**
 * Resolve one `@`-selected workspace path, or throw.
 *
 * The menu hands back a path the user picked, but a draft is user-editable
 * text, so the value is untrusted by the time it reaches a tool: this is the
 * check that a reference cannot name a file outside the workspace (`../../…`)
 * or an absolute path. Kept here beside the listing so the menu's offer and
 * the reference's acceptance are the same rule.
 * @param root - the workspace root the path must stay inside.
 * @param rel - the workspace-relative path from a reference.
 * @returns the absolute path, verified to sit inside `root`.
 */
export function resolveWorkspacePath(root: string, rel: string): string {
  const base = path.resolve(root);
  // A reference is written with `/`; `path.resolve` on Windows accepts both.
  const resolved = path.resolve(base, rel);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('reference path is outside the workspace');
  }
  return resolved;
}

/** True when the path names an existing regular file (a reference may be stale). */
export async function isFile(absolute: string): Promise<boolean> {
  const info = await stat(absolute).catch(() => undefined);
  return info !== undefined && info.isFile();
}
