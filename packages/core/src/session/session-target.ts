/**
 * Resolving a string a SURFACE sent into a path the session store will act on.
 *
 * Split from the catalog (`session-index.ts`) because the two are different
 * jobs with different failure modes: the catalog enumerates what exists and
 * never throws, while everything here takes untrusted input (a frame's `file`
 * or `dir`) and must refuse it loudly. Keeping the refusals in one file also
 * keeps them consistent — resuming, deleting, and switching the workspace are
 * all bounded by the same rules, so a surface cannot be handed a weaker check
 * than the model's own tool.
 */
import path from 'node:path';
import { realpath, stat, unlink } from 'node:fs/promises';
import { appHome, sessionsRoot } from '../paths.js';

/**
 * True when `dir` points inside the nova data directory (sessions/skills/
 * cache live there): NEVER a valid workspace — a session accidentally
 * created inside the data dir must not drag the tools there.
 * (The predicate every session switcher and the surface rewrite all
 * share; `appHome()` default keeps ~/.noa the single source.)
 * @param dir - the candidate directory.
 * @param home - the nova data directory.
 * @returns whether `dir` is the data directory or sits inside it.
 */
export function isInsideNovaHome(dir: string, home = appHome()): boolean {
  const rel = path.relative(home, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a session log path a surface was handed, or throw. The rule every
 * switcher obeys: a session target must be a `.jsonl` INSIDE the sessions root,
 * so a hostile or mistaken path cannot point the session loader at an
 * arbitrary file (`../../secret.jsonl`, a directory, the root itself). Owned
 * here, next to the listing the same surfaces use — the check is a property of
 * the session store, not of whichever surface happened to receive the string.
 * @param file - the path as the surface sent it.
 * @param root - the sessions root the path must sit under.
 * @returns the resolved absolute path.
 */
export function sessionLogPath(file: string, root: string = sessionsRoot()): string {
  const resolved = path.resolve(file);
  const rel = path.relative(root, resolved);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel) || !resolved.endsWith('.jsonl')) {
    throw new Error('session path is outside the sessions dir');
  }
  return resolved;
}

/**
 * Resolve a workspace root a surface was handed, or throw.
 *
 * The kernel's `setWorkspace` re-points every tool root at whatever it is
 * given, so the check has to happen before that call: a path that does not
 * exist (or names a file) would leave bash/search/fs pointing at nothing, and
 * a path inside the nova data directory would let a session edit its own logs
 * and skills. Both refusals are the same rule the model-facing
 * `switch_workspace` tool applies, kept here so a surface and the model cannot
 * disagree about what a legal workspace is.
 * @param dir - the directory a surface asked for.
 * @param home - the nova data directory that is never a workspace.
 * @returns the realpath of the validated directory.
 */
export async function resolveWorkspaceDir(dir: string, home = appHome()): Promise<string> {
  const real = await realpath(dir).catch(() => undefined);
  if (real === undefined) throw new Error(`workspace does not exist: ${dir}`);
  const info = await stat(real).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new Error(`not a directory: ${dir}`);
  if (isInsideNovaHome(real, home)) throw new Error('workspace cannot be inside the nova data directory');
  return real;
}

/**
 * Delete one session log. Returns the path removed, or false when there was
 * nothing to remove (already gone — the caller's intent is satisfied either
 * way, so a double delete is not an error).
 *
 * The target goes through {@link sessionLogPath} first, so deleting is bounded
 * by exactly the same rule as resuming: a `"../../secret.jsonl"` or a path
 * outside the sessions root throws rather than unlinking. Deletion is real
 * (unlink, not a trash or archive flag) — the log IS the session, and a
 * "deleted" session whose file still exists would still be listed, still be
 * resumable, and still count as the newest write.
 * @param file - the log path a surface sent (validated here, not by the caller).
 * @param root - the sessions root the path must sit under.
 * @returns the resolved path removed, or false when it did not exist.
 */
export async function deleteSessionLog(file: string, root: string = sessionsRoot()): Promise<string | false> {
  const resolved = sessionLogPath(file, root);
  try {
    await unlink(resolved);
    return resolved;
  } catch (err) {
    // Only a missing file resolves to "nothing to do"; anything else
    // (permissions, a directory, a busy handle) is a real failure the caller
    // has to report rather than silently leave the row listed.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
