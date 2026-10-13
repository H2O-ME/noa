/**
 * The directory-scoped half of the `@` listing: a query carrying `/` (or an
 * empty one) names a directory, and the answer is that directory's own
 * children — a live listing, not a workspace-wide walk. This is the harness
 * `file-reference-local` split (`search.ts`): `src/` lists `src`, a bare word
 * stays a fuzzy walk. Child order is alphabetical with directories first,
 * the harness `kindRank` tie-break, because a directory listing reads like a
 * file explorer, not a search result.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { SKIP_DIRS, type FileEntry, type FileListingResult } from './file-listing.js';

/**
 * List one directory's immediate children.
 * @param root - the workspace root; `dir` must resolve inside it.
 * @param dir - the directory to list, workspace-relative with `/` separators
 *   and a trailing slash (`''` is the root itself).
 * @param fragment - the text after the last `/`, matched case-insensitively
 *   against the child's name.
 * @param limit - maximum entries to return.
 * @param budgetMs - wall-clock ceiling.
 * @returns the children, and whether the cap cut the listing short.
 */
export async function listDirectoryChildren(
  root: string,
  dir: string,
  fragment: string,
  limit: number,
  budgetMs: number,
): Promise<FileListingResult> {
  const items: FileEntry[] = [];
  const deadline = Date.now() + budgetMs;
  const base = path.resolve(root);
  // The directory comes from editable draft text, so the same boundary the
  // reference's acceptance applies applies here: a path that leaves the
  // workspace (or rides a link out of it) answers with an empty listing.
  const resolved = path.resolve(base, dir === '' ? '.' : dir);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return { items, truncated: false };
  const entries = await readdir(resolved, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return { items, truncated: false };
  // A dot-entry hides unless the query asks for dot-entries by name (the
  // harness rule): typing `.env` must find `.env`, but `e` must not.
  const dotForbidden = !fragment.startsWith('.');
  const needle = fragment.toLowerCase();
  // Directories first, alphabetical within each kind — the harness listing's
  // visible order (its `kindRank` tie-break over an alphabetical walk).
  entries.sort((left, right) =>
    Number(right.isDirectory()) - Number(left.isDirectory())
    || left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (items.length >= limit) return { items, truncated: true };
    if (Date.now() > deadline) return { items, truncated: true };
    if (entry.name.startsWith('.') && dotForbidden) continue;
    // `withFileTypes` reports the link itself, not its target: a symlink is
    // neither directory nor file here, so it is skipped without being followed.
    const kind = entry.isDirectory() && !SKIP_DIRS.has(entry.name)
      ? 'directory'
      : entry.isFile() ? 'file' : undefined;
    if (kind === undefined) continue;
    if (needle !== '' && !entry.name.toLowerCase().includes(needle)) continue;
    // The directory prefix is already on screen (the menu's breadcrumb or the
    // draft itself), so a child's `path` carries it — the pick needs the whole
    // path, the row shows only the name.
    items.push({
      path: `${dir}${entry.name}`,
      name: entry.name,
      kind,
    });
  }
  return { items, truncated: false };
}
