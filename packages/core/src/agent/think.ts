/**
 * Reasoning tags inside assistant text.
 *
 * Some endpoints do not separate reasoning into its own field: they stream it
 * as ordinary `content`, wrapped in tags (`think`, `thinking`, `reasoning`,
 * `thought`; some Chinese models use `思考` / `推理`). Measured on the live
 * gateway (`MiMo-V2.6-Flash`): `content` came back as a think block followed by
 * the answer, while `DeepSeek-V4-Flash` on the same gateway put the same
 * reasoning in `reasoning_content` and left `content` clean. The kernel
 * accumulates `content` into the assistant message, so without this the bot's
 * reply to the user IS its scratchpad.
 *
 * The tag list is one list on purpose: every surface that hides reasoning binds
 * to it, so a name added here is covered everywhere. Matching is
 * case-insensitive.
 */
const THINK_TAG_NAMES = [
  'think',
  'thinking',
  'reasoning',
  'thought',
  'reasoning_scratchpad',
  '思考',
  '反思',
  '推理',
  '推敲',
] as const;

export const THINK_OPEN_TAGS: readonly string[] = THINK_TAG_NAMES.map((name) => `<${name}>`);
export const THINK_CLOSE_TAGS: readonly string[] = THINK_TAG_NAMES.map((name) => `</${name}>`);

const ALL_TAGS: readonly string[] = [...THINK_OPEN_TAGS, ...THINK_CLOSE_TAGS];
const MAX_TAG_LEN = Math.max(...ALL_TAGS.map((tag) => tag.length));

const ORPHAN_CLOSE_RE = new RegExp(
  `(?:${THINK_CLOSE_TAGS.map((tag) => tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[ \\t\\n\\r]*`,
  'gi',
);

/** Strip a close tag with no matching open, plus the whitespace that trailed it. */
function stripOrphanCloseTags(text: string): string {
  return text.includes('</') ? text.replace(ORPHAN_CLOSE_RE, '') : text;
}

interface Hit {
  index: number;
  length: number;
}

const MISS: Hit = { index: -1, length: 0 };

function findFirstTag(buf: string, tags: readonly string[]): Hit {
  const lower = buf.toLowerCase();
  let best = MISS;
  for (const tag of tags) {
    const index = lower.indexOf(tag);
    if (index !== -1 && (best.index === -1 || index < best.index)) best = { index, length: tag.length };
  }
  return best;
}

/**
 * Stateful scrubber for streamed assistant text.
 *
 * A regex run per delta is wrong: an opening ` thinking` arriving alone in one
 * delta would be erased while its block's text is kept, so the reasoning leaks
 * and the visible answer is mangled. This holds partial tags at delta boundaries
 * until they resolve, discards what is inside a block, and releases held-back
 * prose that turned out not to be a tag.
 *
 * An open tag only starts a block at a block boundary (stream start, after a
 * newline, or on a whitespace-only line so far), so prose that *mentions*
 * `<think>` is not swallowed. A CLOSED pair is always suppressed, wherever it
 * sits — an inline `<think>x</think>` in an answer is leaked reasoning far more
 * often than it is content.
 */
export class StreamingThinkScrubber {
  private inBlock = false;
  /** Held-back tail: a partial tag that a later delta may complete. */
  private buf = '';
  /**
   * True iff the last thing emitted ended with a newline (or nothing was emitted
   * yet). Decides whether an open tag at buffer position 0 sits at a boundary.
   */
  private lastEmittedEndedNewline = true;

  /** Reset for a new turn — or a new attempt, when the provider replays one. */
  reset(): void {
    this.inBlock = false;
    this.buf = '';
    this.lastEmittedEndedNewline = true;
  }

  /**
   * Feed one delta; returns the visible portion (`''` when the delta is entirely
   * reasoning or is being held back).
   */
  feed(text: string): string {
    if (text.length === 0) return '';
    let buf = this.buf + text;
    this.buf = '';
    const out: string[] = [];

    while (buf.length > 0) {
      if (this.inBlock) {
        const close = findFirstTag(buf, THINK_CLOSE_TAGS);
        if (close.index === -1) {
          // No close yet: hold back a possible partial close tag, discard the rest.
          this.holdPartial(buf, THINK_CLOSE_TAGS);
          break;
        }
        buf = buf.slice(close.index + close.length);
        this.inBlock = false;
        continue;
      }

      // Earliest of: a closed pair anywhere, an unterminated open tag at a
      // boundary. Earliest wins so text before the tag is still emitted.
      const pair = findEarliestClosedPair(buf);
      const open = this.findOpenAtBoundary(buf, out);
      if (pair !== undefined && (open.index === -1 || pair[0] <= open.index)) {
        this.emit(out, buf.slice(0, pair[0]));
        buf = buf.slice(pair[1]);
        continue;
      }
      if (open.index !== -1) {
        this.emit(out, buf.slice(0, open.index));
        this.inBlock = true;
        buf = buf.slice(open.index + open.length);
        continue;
      }

      // Nothing resolvable: hold back a partial-tag tail so a tag split across
      // deltas is not missed, and emit the rest.
      this.emit(out, this.holdPartial(buf, ALL_TAGS));
      break;
    }

    return out.join('');
  }

  /**
   * End-of-stream flush. Inside an unterminated block the tail is DISCARDED —
   * leaking half a scratchpad is worse than a truncated answer. Otherwise the
   * held tail was ordinary prose and is released.
   *
   * Always resets the boundary flag: an intra-turn retry flushes and streams
   * again without `reset()`, and a stale `false` flag would make the new
   * stream's opening ` thinking` look mid-line.
   */
  flush(): string {
    const tail = this.inBlock ? '' : this.buf;
    this.buf = '';
    this.inBlock = false;
    this.lastEmittedEndedNewline = true;
    return tail.length > 0 ? stripOrphanCloseTags(tail) : '';
  }

  /** Append visible prose, orphan close tags removed, tracking the newline flag. */
  private emit(out: string[], text: string): void {
    const visible = stripOrphanCloseTags(text);
    if (visible.length === 0) return;
    out.push(visible);
    this.lastEmittedEndedNewline = visible.endsWith('\n');
  }

  /**
   * Move a trailing partial-tag prefix of `buf` into the hold-back slot; return
   * the remainder (the part that cannot be a tag).
   */
  private holdPartial(buf: string, tags: readonly string[]): string {
    const held = maxPartialSuffix(buf, tags);
    this.buf = held > 0 ? buf.slice(buf.length - held) : '';
    return held > 0 ? buf.slice(0, buf.length - held) : buf;
  }

  /** The earliest open tag that sits at a block boundary. */
  private findOpenAtBoundary(buf: string, alreadyEmitted: readonly string[]): Hit {
    const lower = buf.toLowerCase();
    let best = MISS;
    for (const tag of THINK_OPEN_TAGS) {
      let index = lower.indexOf(tag);
      while (index !== -1 && !this.isBlockBoundary(buf, index, alreadyEmitted)) {
        index = lower.indexOf(tag, index + 1);
      }
      if (index !== -1 && (best.index === -1 || index < best.index)) best = { index, length: tag.length };
    }
    return best;
  }

  /**
   * True iff `index` is a block boundary: position 0 with a newline-terminated
   * (or absent) prior emission, or any position whose text on the current line is
   * whitespace only — where "current line" starts inside `buf` if `buf` holds a
   * newline before it, and otherwise at the previous emission.
   */
  private isBlockBoundary(buf: string, index: number, alreadyEmitted: readonly string[]): boolean {
    const priorNewline =
      alreadyEmitted.length > 0
        ? alreadyEmitted[alreadyEmitted.length - 1]!.endsWith('\n')
        : this.lastEmittedEndedNewline;
    if (index === 0) return priorNewline;
    const preceding = buf.slice(0, index);
    const lastNewline = preceding.lastIndexOf('\n');
    return (lastNewline === -1 ? priorNewline : true) && preceding.slice(lastNewline + 1).trim() === '';
  }
}

/** The earliest complete `open…close` pair in `buf`, as `[start, end)`. */
function findEarliestClosedPair(buf: string): [number, number] | undefined {
  const lower = buf.toLowerCase();
  let best: [number, number] | undefined;
  for (let i = 0; i < THINK_OPEN_TAGS.length; i++) {
    const openTag = THINK_OPEN_TAGS[i]!;
    const closeTag = THINK_CLOSE_TAGS[i]!;
    const open = lower.indexOf(openTag);
    if (open === -1) continue;
    const close = lower.indexOf(closeTag, open + openTag.length);
    if (close === -1) continue;
    const end = close + closeTag.length;
    if (best === undefined || open < best[0]) best = [open, end];
  }
  return best;
}

/**
 * Longest suffix of `buf` that is a strict prefix of some tag — i.e. text that a
 * later delta could still turn into a tag, so it must not be emitted yet. A full
 * match is a real tag and is handled by the caller, not held here.
 */
function maxPartialSuffix(buf: string, tags: readonly string[]): number {
  const lower = buf.toLowerCase();
  const most = Math.min(lower.length, MAX_TAG_LEN - 1);
  for (let i = most; i > 0; i--) {
    const suffix = lower.slice(lower.length - i);
    if (tags.some((tag) => tag.length > i && tag.startsWith(suffix))) return i;
  }
  return 0;
}

/**
 * Strip reasoning tags from a COMPLETE string.
 *
 * Deliberately the same state machine the stream uses, not a second regex: the
 * two would drift, and the streamed case is the one that has to be right.
 */
export function stripThinkBlocks(text: string): string {
  if (text.length === 0) return text;
  const scrubber = new StreamingThinkScrubber();
  return scrubber.feed(text) + scrubber.flush();
}
