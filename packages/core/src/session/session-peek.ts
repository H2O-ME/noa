/**
 * Log-head scanning for the session list: everything a switcher row shows —
 * identity, creation time, title, the workspace the session was created in —
 * lives in the first lines of the JSONL log, so a capped read answers all of
 * it without loading whole (possibly multi-MB) sessions.
 *
 * Split from `session-index.ts` (the catalog API): the scan and the API change
 * for different reasons — this file moves when the log's head layout changes,
 * that one when the listing/enumeration contract does. The directory walk that
 * says which logs exist is `session-files.ts`.
 */
import { open } from 'node:fs/promises';
import path from 'node:path';
import { isContextFragment } from '../context-fragment.js';
import { stripTitleWrappers } from './session-title.js';

/** What a capped head scan can tell about one session log. */
export interface SessionPeek {
  id: string;
  createdAt: number | undefined;
  title: string;
  workspace: string | undefined;
  /** No user prompt yet: a provisional session a surface hides unless it is the open one. */
  blank: boolean;
}

const TITLE_MAX_CHARS = 120;
/** Titles live in the first lines of the log; a capped read keeps listing
 * O(64KB) per file instead of loading whole (possibly multi-MB) sessions. */
const PEEK_BYTES = 64 * 1024;

/** Read one log's head for its id / creation time / title / workspace. */
export async function peekSession(file: string): Promise<SessionPeek> {
  const id = path.basename(file).replace(/\.jsonl$/, '');
  let createdAt: number | undefined;
  let title = '';
  // The workspace marker is appended at session creation (before the seeded
  // fragment), so the head scan finds it; older logs fall back to the
  // fragment's cwd= line, mirroring `sessionWorkspace`'s own fallback.
  let workspace: string | undefined;
  // Cleared by the first user message that is not a seeded fragment — the same
  // rule `isBlankSession` applies to a full projection, read here from the head.
  let blank = true;
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(PEEK_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    // The capped read can slice a multi-byte UTF-8 char at the boundary; the
    // decoder replaces it with U+FFFD in the tail line, whose JSON.parse then
    // fails and is skipped like any other read-capped partial line.
    const text = buf.subarray(0, bytesRead).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      let evt: unknown;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // a read-capped tail can end mid-line
      }
      if (typeof evt !== 'object' || evt === null) continue;
      const rec = evt as {
        type?: unknown;
        createdAt?: unknown;
        message?: unknown;
        path?: unknown;
        title?: unknown;
      };
      if (rec.type === 'session') {
        if (typeof rec.createdAt === 'number') createdAt = rec.createdAt;
        continue;
      }
      if (rec.type === 'title') {
        // The generated label WINS over the first-prompt fallback: the marker is
        // appended after that prompt, so a later prompt's `||=` below can never
        // overwrite it, and a regenerated title is a second, newer marker. The
        // label is stripped of its wrapper because a marker recorded before that
        // rule existed still carries it — a row must not draw the model's markdown.
        if (typeof rec.title === 'string') title = stripTitleWrappers(rec.title);
        continue;
      }
      if (rec.type === 'workspace') {
        // The NEWEST marker wins, matching `sessionWorkspace` — a session moved
        // to another workspace appends a second marker, and taking the first
        // would file it under the directory it left.
        if (typeof rec.path === 'string') workspace = rec.path;
        continue;
      }
      if (rec.type !== 'message') continue;
      const msg = rec.message as { id?: unknown; role?: unknown; content?: unknown } | undefined;
      if (msg === undefined || msg.role !== 'user') continue;
      const content = typeof msg.content === 'string' ? msg.content : '';
      // The same rule the full projection applies, shared so the head scan and
      // the loaded session cannot disagree. Stricter than "starts with <", so a
      // prompt opening with a bracket is still a prompt.
      if (isContextFragment({ id: typeof msg.id === 'string' ? msg.id : '', ts: 0, role: 'user', content })) {
        const cwd = /^cwd=(.+)$/m.exec(content)?.[1]?.trim();
        if (cwd !== undefined && workspace === undefined) workspace = cwd;
        continue;
      }
      const trimmed = (content.split('\n', 1)[0] ?? '').trim();
      if (trimmed.length === 0) continue;
      // The title is the FIRST prompt, but the scan keeps going: the workspace
      // marker can be appended after it (a session moved mid-life appends one),
      // and stopping here would report the directory it left. `blank` is settled
      // by the first prompt, so it does not flip back.
      title ||= trimmed.slice(0, TITLE_MAX_CHARS);
      blank = false;
    }
    // A filled buffer means the head was cut short, so "no prompt in what I
    // read" is not the same as "there is no prompt". Fail open: showing a row
    // that turns out to be blank is recoverable, hiding a real session is not.
    if (bytesRead === buf.length) blank = false;
  } finally {
    await fh.close();
  }
  return { id, createdAt, title, workspace, blank };
}
