/**
 * UTF-8 byte-budget truncation in one place. The loop tail, the jobs output
 * tail, and the AGENTS.md doc head were three hand-rolled copies of the same
 * "cut at a whole-character boundary, never a continuation byte" logic — a raw
 * `subarray` would split a multi-byte char and leave a replacement glyph at the
 * seam. All three now defer here.
 *
 * Budget is in BYTES (what a wire/log size cap measures), not display cells;
 * width-aware clipping is a different concern and lives in the surface that renders it.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`. */
export function truncateUtf8Head(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off out of any partial multi-byte sequence (10xxxxxx continuation byte).
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return decoder.decode(bytes.subarray(0, end));
}

/** Longest suffix of `text` whose UTF-8 encoding fits in `maxBytes`. */
export function truncateUtf8Tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  // Skip the partial leading sequence the cut left dangling.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return decoder.decode(bytes.subarray(start));
}
