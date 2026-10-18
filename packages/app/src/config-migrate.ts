/**
 * Upgrade a raw config document in place to the current shape.
 *
 * The schema is STRICT and refuses unknown keys by name, which is exactly what
 * makes it useful — but it also means a config written before this release would
 * fail to load. Rather than weaken the schema, the two things that changed are
 * rewritten here, on the RAW document, before validation:
 *
 *  - the top-level `approval` tier: the old `read-only` / `auto-edit` collapse
 *    to `auto` (the smart-approval tier that replaced them);
 *  - the QQ channel row's `owners` / `maxTier` / `pairingCode`, removed with the
 *    pairing flow (this is a single-operator deployment now).
 *
 * It runs on every read of the document (load, re-roster, and every save), so the
 * first write after an upgrade also HEALS the file — the operator never has to
 * hand-edit it.
 */
import { CHANNEL_ROW_ID } from './channel-row.js';

/** Tier names that no longer exist, mapped onto the tier that replaced them. */
const LEGACY_TIERS = new Set(['read-only', 'auto-edit']);

/** Channel-row config keys removed with the pairing flow. */
const LEGACY_ROW_KEYS = ['owners', 'maxTier', 'pairingCode'] as const;

/**
 * Rewrite the document in place, returning one human note per change.
 * @param doc - the parsed config document (mutated).
 * @returns the notes to show the operator ([] when nothing changed).
 */
export function migrateConfigDocument(doc: unknown): string[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return [];
  const root = doc as Record<string, unknown>;
  const notes: string[] = [];
  const approval = root['approval'];
  if (typeof approval === 'string' && LEGACY_TIERS.has(approval)) {
    root['approval'] = 'auto';
    notes.push(`approval「${approval}」已废弃，按「auto」（智能审批）处理。`);
  }
  const plugins = root['plugins'];
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) return notes;
  const entries = (plugins as Record<string, unknown>)['entries'];
  if (!Array.isArray(entries)) return notes;
  for (const row of entries) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const entry = row as Record<string, unknown>;
    if (entry['id'] !== CHANNEL_ROW_ID) continue;
    const config = entry['config'];
    if (typeof config !== 'object' || config === null || Array.isArray(config)) continue;
    const settings = config as Record<string, unknown>;
    for (const key of LEGACY_ROW_KEYS) {
      if (key in settings) {
        delete settings[key];
        notes.push(`插件「${CHANNEL_ROW_ID}」的配置键「${key}」已废弃，已忽略。`);
      }
    }
  }
  return notes;
}
