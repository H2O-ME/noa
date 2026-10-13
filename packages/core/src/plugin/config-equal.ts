/**
 * Structural equality for a row's `config` — the value comparison the loader
 * diffs rows with.
 *
 * ## Why this is not `===`
 *
 * A row's config is DATA read from `plugins.entries` in the operator's config
 * document, and the shell that owns that document re-reads it on every roster
 * (`persist.readPluginEntries`): two reads of an unchanged file produce equal
 * content in FRESH objects. The loader used to compare config by identity, so a
 * live re-read looked like "the operator edited every row" — it tore down and
 * re-applied every configured plugin on every workspace switch and every
 * settings flip, which is exactly the rebuild-everything behaviour the entry
 * tree exists to end.
 *
 * `plugin` / `isolate` / `intercept` stay identity-compared in the loader: those
 * are CODE, and a caller that builds an equivalent wrapper inline really has
 * declared a different scope.
 *
 * ## Why the plain-data guard
 *
 * A plugin that hands the loader a live object (an embedded kernel may) must
 * keep the strict reading rather than be silently "equal" to a look-alike: a
 * class instance, a Map, or a function is not config data, so anything that is
 * not plain JSON shape falls back to identity.
 */

/** Is this JSON-safe config data — a primitive, or an array/object of them? */
export function isPlainData(value: unknown): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isPlainData);
  if (kind !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isPlainData);
}

/**
 * Are two configs the same row setting?
 *
 * By value for plain data, by identity for everything else. Key ORDER is not a
 * difference: the same document read twice must not reload a row.
 */
export function sameConfig(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isPlainData(a) || !isPlainData(b)) return false;
  return deepEqualData(a, b);
}

function deepEqualData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualData(item, b[index]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  // Key count first, so an added key is a change even when every shared key matches.
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && deepEqualData(left[key], right[key]));
}
