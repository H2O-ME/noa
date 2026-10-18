/**
 * Reading past conversations out of the session logs.
 *
 * The logs are append-only JSONL, one event per line, so "index what is new" is
 * a byte offset per file — the cheapest incremental scheme there is, and the
 * reason this does not need a change-tracking database.
 *
 * ## The offset is a CACHE, and caches go stale
 *
 * Three things can invalidate a saved offset, and all three are real in this
 * product:
 *
 *  1. **The file shrank.** A truncated tail is repaired by cutting the file back
 *     to its last complete line, so `size < offset` happens.
 *  2. **The offset is not on a line boundary.** Belt and braces for (1) and for a
 *     partially-written line: if the byte before the offset is not `\n`, reading
 *     from there would start mid-JSON and every line would fail to parse.
 *  3. **The file was REPLACED, not appended to.** A v1→v2 upgrade rewrites the
 *     whole log atomically. A rewrite that lands on the same byte length is
 *     invisible to a size comparison, so the guard is a hash of the file's HEADER
 *     LINE — the one part an append never touches and a rewrite always does.
 *
 * Any one of them resets the offset to 0. That is safe because entry ids are
 * content-addressed ({@link episodeId}), so a full re-read REPLACES the entries
 * it already produced rather than duplicating them.
 *
 * ## What is worth indexing
 *
 * Only user and assistant text. Tool results are huge and low-signal, log-only
 * events carry no prose, and both would swamp the index with material nobody
 * would ever search for. Compaction summaries ARE indexed: they are dense
 * restatements of a long stretch of conversation, which makes them the best
 * retrieval targets in the whole file.
 *
 * Short messages are dropped, and so are `/`-prefixed ones. "好的", "收到" and
 * "/new" carry no retrievable meaning, and at a 4000-entry cap a chatty week of
 * them would push out the conversations worth finding.
 */
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { listSessionFiles, isContextFragment, sessionsRoot } from '@noa/core';
import { textHash, type EpisodeRole, type FileState } from './vectors.js';

/** Longest text kept from one message (a chunk is a retrieval unit, not a transcript). */
export const EPISODE_CHUNK_MAX_CHARS = 1500;
/** Messages shorter than this are dropped as noise. */
export const DEFAULT_MIN_EPISODE_CHARS = 12;
/** Bytes read to locate the header line for the rewrite guard. */
export const HEAD_BYTES = 512;
/** Most bytes read from one log in one pass; the next pass resumes at the boundary. */
export const DEFAULT_MAX_BYTES_PER_FILE = 8 * 1024 * 1024;
/** Read window; lines are consumed from it and the position resumes at a boundary. */
const READ_WINDOW = 64 * 1024;

/** One indexable stretch of a past conversation. */
export interface EpisodeChunk {
  readonly id: string;
  readonly sessionId: string;
  readonly role: EpisodeRole;
  readonly at: number;
  readonly text: string;
}

/** Knobs for a scan. */
export interface ScanOptions {
  /** Messages shorter than this (after collapsing) are skipped. */
  readonly minChars?: number;
  /** Read cap per file per pass. */
  readonly maxBytesPerFile?: number;
  /** Truncation length for one chunk. */
  readonly chunkMaxChars?: number;
  /**
   * Most chunks to produce from this file in one pass.
   *
   * The scan stops at a COMPLETE line, so the returned offset is always safe to
   * resume from: a pass bounded by this knob loses nothing, which is what makes
   * a small embedding budget safe to run against a large unindexed backlog.
   */
  readonly maxChunks?: number;
}

/** What one file's scan produced. */
export interface ScanResult {
  readonly sessionId: string;
  readonly chunks: readonly EpisodeChunk[];
  /** The read position to record (offset advanced only past complete lines). */
  readonly state: FileState;
  /** Whether the saved offset was discarded and the file re-read from the start. */
  readonly reset: boolean;
}

/**
 * The content-addressed id of one history chunk.
 *
 * Content plus timestamp, NOT the line number: a re-scan after a rewrite must
 * produce the SAME id for the same message, or every rewrite would duplicate the
 * whole conversation. It also means the vector-reuse map (keyed by text hash)
 * lines up with the id, so a re-scan re-embeds nothing.
 * @param sessionId - the conversation.
 * @param text - the chunk text.
 * @param at - the message timestamp.
 * @returns the id.
 */
export function episodeId(sessionId: string, text: string, at: number): string {
  return `history:${sessionId}:${textHash(text)}:${at}`;
}

/**
 * Every session log, newest first.
 *
 * Newest first because a pass has a bounded embedding budget: the recent
 * conversations are the ones a question is most likely about, so they must be
 * the ones that get indexed when the budget runs out.
 * @param root - the date-bucketed sessions root.
 * @returns file paths with their mtimes.
 */
export async function sessionFilesNewestFirst(root: string = sessionsRoot()): Promise<{ file: string; mtimeMs: number }[]> {
  const files = await listSessionFiles(root);
  const stated = await Promise.all(
    files.map(async (file) => {
      const info = await stat(file).catch(() => undefined);
      return info === undefined ? undefined : { file, mtimeMs: info.mtimeMs };
    }),
  );
  return stated
    .filter((entry): entry is { file: string; mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Read one session log's new events and turn them into chunks.
 *
 * @param file - the log path.
 * @param prior - the recorded read position, when there is one.
 * @param opts - scan knobs.
 * @returns the scan result, or undefined when the file cannot be read at all
 *   (deleted mid-walk, locked): one unreadable log must not stop the pass.
 */
export async function scanSessionFile(
  file: string,
  prior: FileState | undefined,
  opts: ScanOptions = {},
): Promise<ScanResult | undefined> {
  const minChars = opts.minChars ?? DEFAULT_MIN_EPISODE_CHARS;
  const maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const chunkMax = opts.chunkMaxChars ?? EPISODE_CHUNK_MAX_CHARS;
  const maxChunks = opts.maxChunks ?? Number.POSITIVE_INFINITY;
  const sessionId = path.basename(file).replace(/\.jsonl$/, '');

  const info = await stat(file).catch(() => undefined);
  if (info === undefined) return undefined;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const head = await readAt(handle, 0, Math.min(HEAD_BYTES, info.size));
    const headDigest = headerDigest(head);

    const { start, reset } = await resolveStart(handle, info.size, headDigest, prior);
    const chunks: EpisodeChunk[] = [];
    // `consumed` is a byte offset that always sits on a line boundary: it only
    // advances past a line whose trailing newline was actually read. The loop's
    // read position runs ahead of it, and the leftover tail is carried, so
    // stopping early (chunk budget, byte budget) loses nothing.
    let consumed = start;
    let position = start;
    let carry = '';
    while (consumed < info.size && chunks.length < maxChunks && consumed - start < maxBytes) {
      const buffer = await readAt(handle, position, Math.min(READ_WINDOW, info.size - position));
      if (buffer.length === 0) break;
      position += buffer.length;
      const lines = (carry + buffer.toString('utf8')).split('\n');
      carry = lines.pop() ?? '';
      let full = false;
      for (const line of lines) {
        if (line.length > 0) {
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            // A corrupt line is skipped, not fatal: the rest of the log is still
            // good, and refusing the whole file would cost the session its index
            // over one damaged record.
            event = undefined;
          }
          const chunk = event === undefined ? undefined : chunkOf(event, sessionId, { minChars, chunkMax });
          if (chunk !== undefined) chunks.push(chunk);
        }
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        if (chunks.length >= maxChunks || consumed - start >= maxBytes) {
          full = true;
          break;
        }
      }
      if (full) break;
    }
    return {
      sessionId,
      chunks,
      state: { size: info.size, mtimeMs: info.mtimeMs, head: headDigest, offset: consumed },
      reset,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Decide where to start reading, applying the three invalidation guards.
 * @param handle - the open file.
 * @param size - its current size.
 * @param headDigest - the current head hash.
 * @param prior - the recorded state.
 * @returns the start offset and whether it was a reset.
 */
async function resolveStart(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  headDigest: string,
  prior: FileState | undefined,
): Promise<{ start: number; reset: boolean }> {
  if (prior === undefined || prior.offset <= 0) return { start: 0, reset: prior !== undefined };
  // (1) shrank — a repaired tail.
  if (size < prior.offset) return { start: 0, reset: true };
  // (3) rewritten in place (same size, different bytes).
  if (prior.head !== headDigest) return { start: 0, reset: true };
  // (2) not on a line boundary — start mid-record, so re-read.
  const before = await readAt(handle, prior.offset - 1, 1);
  if (before.length !== 1 || before[0] !== 0x0a) return { start: 0, reset: true };
  return { start: prior.offset, reset: false };
}

/** Read exactly `length` bytes at `position` (short read only at EOF). */
async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/**
 * The digest of a log's FIRST LINE — its header.
 *
 * The header line, not the first N bytes, and the difference is the whole point:
 * an append never touches the header, so a growing log keeps a stable digest and
 * the offset stays usable. Hashing a fixed byte window instead would mean every
 * append to a log shorter than that window invalidates the offset and re-reads
 * the file from the start — which is most logs for most of their life.
 *
 * What it detects is a log that was REPLACED rather than appended to: the v1→v2
 * upgrade rewrites the whole file, changing the header's `v` and (for an id
 * collision) its `id`, at a byte length that can be identical. That rewrite is
 * invisible to a size comparison, and trusting the old offset against the new
 * file would skip records.
 * @param head - the first bytes of the file.
 * @returns a short digest.
 */
function headerDigest(head: Buffer): string {
  const breakAt = head.indexOf(0x0a);
  const header = breakAt === -1 ? head : head.subarray(0, breakAt + 1);
  return createHash('sha1').update(header).digest('hex').slice(0, 12);
}

/** One event → one chunk, or undefined when the event is not worth indexing. */
function chunkOf(event: unknown, sessionId: string, opts: { minChars: number; chunkMax: number }): EpisodeChunk | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  const record = event as { type?: unknown; message?: unknown; summary?: unknown; at?: unknown };
  if (record.type === 'compaction/summary') {
    const summary = typeof record.summary === 'string' ? record.summary : '';
    const at = typeof record.at === 'number' ? record.at : 0;
    const text = clean(summary, opts.chunkMax);
    if (text.length < opts.minChars) return undefined;
    return { id: episodeId(sessionId, text, at), sessionId, role: 'summary', at, text };
  }
  if (record.type !== 'message') return undefined;
  const message = record.message;
  if (message === null || typeof message !== 'object') return undefined;
  const { id, role, content, ts } = message as { id?: unknown; role?: unknown; content?: unknown; ts?: unknown };
  if (role !== 'user' && role !== 'assistant') return undefined;
  if (typeof content !== 'string' || typeof id !== 'string') return undefined;
  // 会话开头的上下文片段（`<environment>` / `<user_instructions>` / `<project_docs>`
  // / `<available_skills>`）是**注入**，不是谁说过的话。索引它，检索就会把「这台机器
  // 装了什么技能」当成「操作者习惯用什么」端给模型 —— 实测发生过：模型据此声称
  // 「从历史对话能看出你常用 EdgeOne Makers」，而证据只是技能清单里有一行。
  //
  // 判定归 core（`isContextFragment`，按 `msg_ctx_` id 前缀认，老日志退回按
  // `<environment>` 开头认）：这里不写第二套猜测，也不做文本清洗。Hermes 走得更彻底
  // —— 系统提示、环境块、技能清单存在 `sessions` 表，根本不进被索引的 `messages` 表
  // （`hermes_state_common.py:777-783`）；这条按来源标记跳过，是同一件事在 append-only
  // 日志上的最小等价物。
  if (isContextFragment({ id, role, content })) return undefined;
  const text = clean(content, opts.chunkMax);
  if (text.length < opts.minChars) return undefined;
  const at = typeof ts === 'number' ? ts : 0;
  return { id: episodeId(sessionId, text, at), sessionId, role, at, text };
}

/**
 * Collapse a message body into one line.
 *
 * The chunk is a retrieval unit that gets shown back in a `recall` result, so
 * internal structure (a code block's indentation, a list's line breaks) is
 * flattened. Keeping it would cost index bytes and render as a ragged result for
 * no gain — the model can read the original log when it needs the shape.
 */
function clean(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // A channel command is not a thing anyone searches for, and it is noise in the
  // index at the cap.
  if (flat.startsWith('/')) return '';
  return flat.length > maxChars ? `${[...flat].slice(0, maxChars).join('')}…` : flat;
}
