/**
 * Read-side answers about the plugin tree, taken from the RAW document rather
 * than from a loaded `Config`.
 *
 * Ported from nova's `packages/cli/src/config-read.ts`: the load path runs
 * `expandDeep`, so a loaded `Config` has already replaced `{env:NAME}` with the
 * secret and can no longer answer "which variable does this row name?".
 *
 * Nothing here knows any plugin: a row is `{ id, enabled?, config? }`, and what
 * lives inside `config` is the owning plugin's business.
 */
import { docFile, plainMember, readDoc } from './config-doc.js';

/** One plugin row as stored on disk. */
export interface StoredPluginEntry {
  readonly id: string;
  readonly enabled?: boolean;
  readonly config?: unknown;
}

/**
 * The `plugins.entries` rows as stored, in file order.
 *
 * Read from the RAW document because the loaded `Config` is a boot-time snapshot
 * and this list is exactly what a running process's edit changes. It is what the
 * kernel re-rosters from, so it must be the expanded-on-load shape the config
 * itself gets.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the rows; [] when the file, the `plugins` object or the list is absent.
 */
export async function readPluginEntries(homedir?: string): Promise<StoredPluginEntry[]> {
  const doc = await readDoc(docFile(homedir)).catch(() => undefined);
  const entries = plainMember(doc, 'plugins')?.['entries'];
  if (!Array.isArray(entries)) return [];
  const rows: StoredPluginEntry[] = [];
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate['id'] !== 'string' || candidate['id'].length === 0) continue;
    rows.push({
      id: candidate['id'],
      ...(typeof candidate['enabled'] === 'boolean' ? { enabled: candidate['enabled'] } : {}),
      ...(candidate['config'] !== undefined ? { config: candidate['config'] } : {}),
    });
  }
  return rows;
}
