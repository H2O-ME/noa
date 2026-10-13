/**
 * The session list a surface holds and asks again. A listing keeps the head
 * scans it has already paid for, keyed by the log's own mtime, so re-asking is
 * a walk plus one stat per file — the answer to "what changed" without
 * re-reading a single unchanged head. dsh reaches for the same effect with a
 * disk-backed projection cache; here the process outlives the question, so
 * memory is enough.
 *
 * Split from `session-index.ts` (the catalog API): enumeration is a fact about
 * the sessions directory, while what a long-lived surface should remember
 * between two asks is a policy of its own.
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { listSessionFiles } from './session-files.js';
import { peekSession, type SessionPeek } from './session-peek.js';
import type { SessionEntry } from './session-index.js';

/**
 * The list itself is never cached: a session created a moment ago must show up
 * in the next answer (that is what a surface re-asks for), and the walk is the
 * cheap part — the peek is not.
 */
export class SessionListing {
  private readonly peeks = new Map<string, { stamp: string; peek: SessionPeek }>();

  /** @param root - the date-bucketed sessions root. */
  constructor(private readonly root: string) {}

  /** Sessions under the root, newest first; heads read for the top `limit`. */
  async list(limit: number): Promise<SessionEntry[]> {
    const files = await listSessionFiles(this.root);
    // Parallel: 600 sequential stats on a network-ish filesystem is the whole
    // latency of this call, and nothing here depends on the previous stat.
    const statted = (await Promise.all(
      files.map(async (file) => {
        const info = await stat(file).catch(() => undefined);
        // mtime ALONE is not enough: NTFS stamps land on a ~15ms grid, so an
        // event appended right after the previous read can carry an identical
        // mtime and the cached head would be served forever. Size moves with
        // every append, so the pair changes whenever the log does.
        return info === undefined ? undefined : { file, mtime: info.mtimeMs, stamp: `${info.mtimeMs}:${info.size}` };
      }),
    )).filter((entry): entry is { file: string; mtime: number; stamp: string } => entry !== undefined);
    statted.sort((a, b) => b.mtime - a.mtime);
    const rows = await Promise.all(
      statted.slice(0, Math.max(0, limit)).map(async ({ file, mtime, stamp }) => ({
        file,
        mtime,
        ...(await this.peek(file, stamp)),
      })),
    );
    // Forget heads for logs that are gone: a long-lived surface would
    // otherwise hold every session it has ever listed.
    const live = new Set(files);
    for (const file of this.peeks.keys()) if (!live.has(file)) this.peeks.delete(file);
    return rows;
  }

  private async peek(file: string, stamp: string): Promise<SessionPeek> {
    const cached = this.peeks.get(file);
    if (cached !== undefined && cached.stamp === stamp) return cached.peek;
    // One unreadable file (locked, deleted mid-listing, permissions) must not
    // blow up the whole panel — it just renders without id/title.
    const peek = await peekSession(file).catch(() => ({
      id: path.basename(file).replace(/\.jsonl$/, ''),
      createdAt: undefined,
      title: '',
      workspace: undefined,
      // An unreadable head is not proof of emptiness: hiding a session with
      // content is worse than listing a row without a title.
      blank: false,
    }));
    this.peeks.set(file, { stamp, peek });
    return peek;
  }
}
