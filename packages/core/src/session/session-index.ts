/**
 * Session enumeration: the catalog API a switcher reads (the CLI's picker, the
 * web sidebar). The log-head scan answering each row's fields is
 * `session-peek.ts`, the directory walk is `session-files.ts`, what a
 * long-lived surface remembers between asks is `session-listing.ts`, and the
 * `workspace` marker that files a session under a directory is
 * `session-workspace.ts`.
 */
import { SessionListing } from './session-listing.js';

/** One listed session: identity plus the bits a switcher row renders. */
export interface SessionEntry {
  file: string;
  id: string;
  /** Last write time (ms epoch) — the list is sorted newest-first by it. */
  mtime: number;
  /** From the file's session header; undefined when the header is unreadable. */
  createdAt: number | undefined;
  /** First real user prompt (single line, char-capped); '' when none found. */
  title: string;
  /**
   * The workspace the session belongs to: the newest `workspace` marker in the
   * log head, falling back to the seeded `<environment>` fragment's `cwd=`
   * line. Undefined when the head has neither (a session without a marker and
   * without a readable fragment) — surfaces group it under "无工作区".
   */
  workspace: string | undefined;
  /** No user prompt yet: the provisional session a surface hides unless it is the open one. */
  blank: boolean;
}

/**
 * One-shot listing (the CLI's picker, tests): the same scan a surface's
 * `SessionListing` runs, without a cache to keep.
 */
export function listRecentSessions(root: string, limit: number): Promise<SessionEntry[]> {
  return new SessionListing(root).list(limit);
}

/**
 * True when `dir` points inside the nova data directory. Re-exported from
 * `session-target.ts`, which owns the rule the switchers share.
 */
export { isInsideNovaHome } from './session-target.js';

/**
 * Delete one session log. Returns the path removed, or false when there was
 * nothing to remove. Re-exported from `session-target.ts`.
 */
export { deleteSessionLog, resolveWorkspaceDir, sessionLogPath } from './session-target.js';
