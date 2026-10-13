/**
 * Which session logs exist on disk.
 *
 * Split from `session-peek.ts` (which reads one log's head): the date-bucketed
 * walk changes when the storage layout changes, while a head scan changes when
 * the log's line format does. They are enumerated and read for the same reason
 * — feeding the session list — but they have different reasons to move.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Enumeration bound: a runaway sessions dir must not freeze the switcher. */
export const MAX_SESSION_FILES = 2000;

/** Every session log under the date-bucketed root, capped at {@link MAX_SESSION_FILES}. */
export async function listSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for (const year of await readdir(root)) {
      const yearDir = path.join(root, year);
      for (const month of await readdir(yearDir).catch(() => [] as string[])) {
        const monthDir = path.join(yearDir, month);
        for (const day of await readdir(monthDir).catch(() => [] as string[])) {
          const dayDir = path.join(monthDir, day);
          for (const name of await readdir(dayDir).catch(() => [] as string[])) {
            if (name.endsWith('.jsonl')) files.push(path.join(dayDir, name));
            if (files.length >= MAX_SESSION_FILES) return files;
          }
        }
      }
    }
  } catch {
    return []; // root does not exist yet — no sessions, not an error
  }
  return files;
}
