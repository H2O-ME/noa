/**
 * Lossless-JSON snapshotting for the code-runtime port boundary. Values that
 * cross the worker boundary must be pure JSON trees: no undefined holes,
 * functions, symbols, bigints, non-finite numbers, cycles or class instances.
 * A failed snapshot returns `undefined` (the caller decides how to report the
 * lossy value); a successful one is a detached plain copy, so later mutation
 * of the original can never desync what was already sent.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Depth cap for the recursive walk: deeper structures fail closed, not overflow. */
const MAX_DEPTH = 64;

function snapshot(value: unknown, depth: number, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null) return null;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value as string | boolean;
  if (kind === 'number') return Number.isFinite(value as number) ? (value as number) : undefined;
  if (kind !== 'object') return undefined; // undefined, function, symbol, bigint
  const obj = value as object;
  if (seen.has(obj)) return undefined; // cycle
  if (depth <= 0) return undefined;
  seen.add(obj);
  if (Array.isArray(obj)) {
    const out: JsonValue[] = [];
    for (const item of obj) {
      const snapped = snapshot(item, depth - 1, seen);
      // Sparse arrays and undefined elements are not losslessly representable.
      if (snapped === undefined) return undefined;
      out.push(snapped);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(obj) as unknown;
  if (proto !== Object.prototype && proto !== null) return undefined; // class instances etc.
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(obj)) {
    const snapped = snapshot(item, depth - 1, seen);
    if (snapped === undefined) return undefined;
    // A plain `out[key] =` assignment for `__proto__` silently mutates the
    // prototype instead of creating an own key — the key would vanish from
    // the snapshot. defineProperty keeps it a real own enumerable property,
    // so JSON.stringify round-trips it.
    if (key === '__proto__') {
      Object.defineProperty(out, key, { enumerable: true, writable: true, configurable: true, value: snapped });
    } else {
      out[key] = snapped;
    }
  }
  return out;
}

/** The detached lossless-JSON copy of `value`, or `undefined` when it has none. */
export function snapshotJson(value: unknown): JsonValue | undefined {
  return snapshot(value, MAX_DEPTH, new WeakSet());
}

/** Exact JSON-encoded byte cost (quotes and escapes counted) of a string or value. */
export function jsonByteLength(value: JsonValue | string): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
