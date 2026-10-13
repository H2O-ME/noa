/**
 * Plugin-row reporting: turning "this row did not come up" into one line a
 * person can act on.
 *
 * Ported from nova's `packages/cli/src/plugin-report.ts`. Every judgement comes
 * from the roster's OWN `error` / `state` / `enabled` fields — this file names no
 * plugin, so it stays true as rows come and go; the caller supplies the id it
 * cares about.
 *
 * A failed row NEVER stops the boot: this file only produces text.
 */
import type { PluginRosterEntry } from '@noa/plugins';

/**
 * Why this row counts as failed, or undefined when it does not.
 *
 * "Failed" is defined HERE: a non-empty `error`, or a container state of
 * `failed`. The order matters — a failed row is also `enabled: false` (it left no
 * fiber), so reading `enabled` first would file "the module would not load" as
 * "go and switch this row on", which is not an action that can fix it.
 * @param row - one roster row.
 * @returns the reason to show, or undefined for a healthy (loaded or switched-off) row.
 */
export function rowFailureReason(row: PluginRosterEntry): string | undefined {
  if (row.error !== undefined && row.error.length > 0) return row.error;
  if (row.state === 'failed') return '插件没有激活（容器状态 failed，未提供原因）';
  return undefined;
}

/**
 * The boot-time report: one line per failed row, naming the row and the reason.
 *
 * Deliberately not "only the first" and not "merged into one sentence": a broken
 * row is an independent fact, and merging makes several look like one.
 * @param rows - the live roster (`kernel.roster()`).
 * @returns one line per failed row, in roster order.
 */
export function failedPluginLines(rows: readonly PluginRosterEntry[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    const reason = rowFailureReason(row);
    if (reason !== undefined) lines.push(`插件行「${oneLine(row.name)}」加载失败：${oneLine(reason)}`);
  }
  return lines;
}

/**
 * One row's load state, looked up by ROW ID.
 *
 * Kept separate from the container's own `roster()` addressing: the container
 * keys rows by the plugin's own `name`, while the id the operator writes is the
 * config row's — and reading the wrong key is the historical defect that filed a
 * loaded plugin as missing.
 */
export type PluginRowState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'off' }
  | { readonly kind: 'active' };

/**
 * Look one row up: absent / failed / off / live.
 *
 * The order IS the semantics: **a load failure outranks "switched off"**.
 * @param rows - the live roster.
 * @param id - the row id as the operator's `plugins.entries` writes it.
 * @returns the row's state.
 */
export function pluginRowState(rows: readonly PluginRosterEntry[], id: string): PluginRowState {
  const row = rows.find((entry) => entry.name === id);
  if (row === undefined) return { kind: 'absent' };
  const reason = rowFailureReason(row);
  if (reason !== undefined) return { kind: 'failed', error: reason };
  if (row.enabled === false) return { kind: 'off' };
  return { kind: 'active' };
}

/**
 * Strip anything that would let a plugin-supplied string redraw the terminal.
 *
 * Row ids and reasons come from plugin-facing data (module names, error
 * messages), and a reason carrying `\r` or ANSI must not be able to overwrite
 * what was already printed.
 * @param text - the raw string.
 * @returns the string as one control-character-free line.
 */
function oneLine(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    out += control ? ' ' : char;
  }
  return out;
}
