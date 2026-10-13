/**
 * Built-in tool argument coercion. `strArg`/`intArg` were byte-identical copies
 * in fs.ts and search.ts — one home now. Loose by design: tool args come from a
 * model, so an int may arrive as a numeric string and must not throw.
 */

/** String arg if present and a string, else undefined. */
export function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Integer arg as a finite truncated number, tolerating a numeric string (a
 * model sometimes emits "400"). undefined when absent or un-coercible.
 */
export function intArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
