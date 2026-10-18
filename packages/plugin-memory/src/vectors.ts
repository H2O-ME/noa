/**
 * Vectors: the math, the on-disk codec, the keyword fallback, and the index
 * document that ties them together.
 *
 * ## Why no vector database
 *
 * A few thousand vectors is a few milliseconds of brute-force arithmetic. A
 * vector database buys approximate search at a scale this program will never
 * reach, and charges for it in a second process, a schema to migrate and a
 * dependency that can be missing. So the index is one JSON file and the search
 * is a loop over an array. The scale assumption is written down rather than
 * assumed: at `maxEpisodeChunks` (4000) entries of 1536 dimensions, one query is
 * ~6M multiply-adds — a few milliseconds, and the index file is ~30 MB of
 * base64, which is why the cap exists.
 *
 * ## Pre-normalized vectors
 *
 * Vectors are L2-normalized ON THE WAY IN, and the query vector too, so cosine
 * similarity reduces to a dot product — no square root per entry per query. The
 * normalization is not an optimization detail: OpenAI-compatible endpoints do
 * not all return unit vectors (local runtimes and proxies in particular), and
 * cosine over unnormalized vectors without dividing by the norms is simply
 * wrong. Normalizing once at the boundary makes the rest of the file able to
 * assume it.
 *
 * ## Base64 Float32, and the alignment trap
 *
 * A JSON array of numbers costs ~20 bytes per float; raw float32 costs 4, and
 * base64 of that costs ~5.4. On a 4000 × 1536 index that is the difference
 * between ~120 MB and ~33 MB of file, so the codec is worth its twelve lines.
 * The trap: `Buffer.from(b64, 'base64')` returns a view into Node's SHARED
 * buffer pool, so `byteOffset` is not necessarily 4-aligned and constructing a
 * `Float32Array` over it throws `RangeError`. The fix is to copy the exact byte
 * range out first — see {@link decodeVector}.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWrite } from '@noa/core';
import type { MemoryTarget } from './store.js';

/** Index format version; a mismatch rebuilds rather than migrating. */
export const INDEX_VERSION = 1;

/** Indexed entry kinds. */
export type IndexScope = 'memory' | 'history';

/** What a history chunk came from. */
export type EpisodeRole = 'user' | 'assistant' | 'summary';

/** Per-entry metadata. Everything here is small; the text is the payload. */
export interface IndexMeta {
  /** `sha1(text)` prefix — the reuse key when a file is re-scanned. */
  readonly textHash: string;
  /** Curated-memory entries only: which of the two files it came from. */
  readonly target?: MemoryTarget;
  /** History chunks only: the conversation they came from. */
  readonly sessionId?: string;
  /** History chunks only. */
  readonly role?: EpisodeRole;
  /** History chunks only: the message timestamp. */
  readonly at?: number;
}

/** One indexed item. */
export interface IndexEntry {
  readonly id: string;
  readonly scope: IndexScope;
  readonly text: string;
  readonly meta: IndexMeta;
  /** L2-normalized float32 vector, base64. */
  readonly vector: string;
}

/** What has been read out of one session log, so the next pass can resume. */
export interface FileState {
  readonly size: number;
  readonly mtimeMs: number;
  /**
   * `sha1` of the file's first bytes.
   *
   * The reason this exists next to size: compaction rewrites a log IN PLACE, and
   * a rewrite that happens to land on the same byte length is invisible to a
   * size comparison — the offsets would then be trusted against a different
   * file. The head hash catches it for the price of one small read.
   */
  readonly head: string;
  /** Byte offset already indexed; the next pass reads from here. */
  readonly offset: number;
}

/** The whole index, as it is stored. */
export interface IndexDocument {
  readonly version: number;
  /** The embedding model the vectors came from; a change invalidates them all. */
  readonly model: string;
  readonly dims: number;
  readonly entries: readonly IndexEntry[];
  readonly files: Readonly<Record<string, FileState>>;
}

/** `sha1` of the text, first 12 hex chars — the content identity used everywhere. */
export function textHash(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 12);
}

/** The stable id of one curated-memory entry. */
export function memoryEntryId(target: string, text: string): string {
  return `memory:${target}:${textHash(text)}`;
}

/**
 * L2-normalize a vector.
 *
 * A zero vector (all components zero, or a NaN-poisoned one) normalizes to
 * itself: dividing by a zero norm would produce NaNs that then compare as
 * "no similarity" against everything, which is the same as not being indexed —
 * but NaN in a JSON file is a corrupt document, so the guard is required for the
 * FORMAT, not just the math.
 * @param vector - the raw vector.
 * @returns a unit vector (or the zero vector, unchanged).
 */
export function normalizeVector(vector: readonly number[]): Float32Array {
  const out = new Float32Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = vector[i] ?? 0;
    const safe = Number.isFinite(value) ? value : 0;
    out[i] = safe;
    sum += safe * safe;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return out;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

/**
 * Dot product of two vectors. Both sides are normalized, so this IS the cosine
 * similarity.
 * @param a - a unit vector.
 * @param b - a unit vector of the same length.
 * @returns the similarity in [-1, 1].
 */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** Encode a float32 vector as base64 (the exact bytes, no JSON number expansion). */
export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

/**
 * Decode base64 back into a float32 vector.
 *
 * The copy out of `buf.buffer` is not defensive style, it is required: Node
 * allocates small Buffers inside a shared pool, so the decoded bytes usually
 * start at an unaligned `byteOffset` and `new Float32Array(buf.buffer, …)` throws
 * `RangeError: start offset of Float32Array should be a multiple of 4`.
 *
 * @param b64 - the encoded vector.
 * @param dims - the expected dimension count; a mismatch means corruption.
 * @returns the vector, or undefined when the bytes cannot be one.
 */
export function decodeVector(b64: string, dims: number): Float32Array | undefined {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return undefined;
  }
  if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return undefined;
  const count = buf.byteLength / 4;
  if (dims > 0 && count !== dims) return undefined;
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(bytes);
}

/* ── keyword fallback ────────────────────────────────────────────────────── */

let segmenterCache: Intl.Segmenter | undefined;
let segmenterResolved = false;

/** The word segmenter, or undefined where the runtime has none. */
function segmenter(): Intl.Segmenter | undefined {
  if (!segmenterResolved) {
    segmenterResolved = true;
    if (typeof Intl.Segmenter === 'function') {
      segmenterCache = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    }
  }
  return segmenterCache;
}

/**
 * Split text into comparable tokens.
 *
 * `Intl.Segmenter`, not `split(/\s+/)`: this product's conversations are mostly
 * Chinese, and a whitespace split makes every Chinese sentence ONE token, which
 * makes keyword matching match nothing at all. ICU ships with Node, so the
 * dictionary segmentation costs no dependency.
 *
 * Word tokens are not enough on their own, and the reason is worth stating
 * because it is not obvious: ICU's segmentation is CONTEXT-dependent, so the same
 * four characters come back as one token in one sentence and as two in another.
 * A query that happens to segment differently from the document it should match
 * would score zero. So CJK runs ALSO contribute their character bigrams, which
 * makes an exact substring match regardless of how the segmenter split it — the
 * standard trick, and the one that makes this fallback usable rather than merely
 * present.
 * @param text - the text to tokenize.
 * @returns lowercased tokens.
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const seg = segmenter();
  if (seg !== undefined) {
    for (const part of seg.segment(lower)) {
      if (part.isWordLike) tokens.push(part.segment);
    }
  }
  tokens.push(...cjkBigrams(lower));
  if (tokens.length > 0) return tokens;
  return bigrams(lower);
}

/** CJK scripts whose words are not delimited by spaces. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;

/** Character bigrams of every CJK run in the text (single-char runs stay whole). */
function cjkBigrams(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    const chars = [...run];
    const first = chars[0];
    if (first === undefined) continue;
    if (chars.length === 1) {
      out.push(first);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  }
  return out;
}

/** Character bigrams of the text with whitespace removed. */
function bigrams(text: string): string[] {
  const chars = [...text.replace(/\s+/g, '')];
  if (chars.length <= 1) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** One document the keyword scorer can rank. */
export interface KeywordDoc {
  readonly id: string;
  readonly text: string;
}

/**
 * Rank documents by IDF-weighted token overlap with the query.
 *
 * IDF is computed over the CANDIDATE SET at query time rather than stored: it is
 * one extra pass over tokens we already have in memory, it costs the index file
 * nothing, and a stored document-frequency table would be one more thing to keep
 * consistent with a hand-edited store.
 *
 * This is the degraded path — what runs when no embedding model is configured —
 * so it optimizes for "better than nothing and never wrong about ordering in an
 * obvious way", not for ranking quality.
 * @param query - the search text.
 * @param docs - the candidates.
 * @returns a score per document id (absent = no overlap).
 */
export function keywordScores(query: string, docs: readonly KeywordDoc[]): Map<string, number> {
  const scores = new Map<string, number>();
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || docs.length === 0) return scores;
  const docTokens = docs.map((doc) => new Set(tokenize(doc.text)));
  for (const token of queryTokens) {
    let df = 0;
    for (const set of docTokens) if (set.has(token)) df++;
    if (df === 0) continue;
    const idf = Math.log(1 + docs.length / df);
    for (let i = 0; i < docs.length; i++) {
      if (!docTokens[i]?.has(token)) continue;
      const id = docs[i]?.id;
      if (id === undefined) continue;
      scores.set(id, (scores.get(id) ?? 0) + idf);
    }
  }
  return scores;
}

/* ── the index ───────────────────────────────────────────────────────────── */

/**
 * The in-memory index, with a serialized atomic save.
 *
 * ONE instance per kernel, held in the plugin's closure, and every mutation goes
 * through it. That is the fix for a lost-update race that is easy to write and
 * hard to see: a background episode sync can be mid-`embed()` for seconds while a
 * `memory` write finishes, and if each kept its own copy of the array, whichever
 * flushed last would erase the other's work. One instance means there is nothing
 * to reconcile — and {@link flush} serializes the LIVE state at the moment the
 * queued write runs, never a snapshot captured when it was enqueued, which is the
 * second half of the same bug.
 */
export class VectorIndex {
  private entries: IndexEntry[] = [];
  private files: Record<string, FileState> = {};
  private model = '';
  private dims = 0;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Bumped by every mutation, and compared against what was last written.
   *
   * The point is to make a no-op flush free. A sync pass runs on every `recall`,
   * and most passes find nothing new — without this, each one would serialize the
   * whole index and rewrite the file to store the identical document.
   */
  private version = 0;
  private persisted = 0;

  /** @param file - absolute path of the index document. */
  constructor(private readonly file: string) {}

  /** Load from disk once; a missing or corrupt document is an empty index. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      // Missing, unreadable or not JSON: the index is DERIVED, so starting over
      // is the correct recovery and costs one re-embedding pass. Reporting it as
      // an error would take the memory system down over a cache.
      return;
    }
    const doc = parsed as Partial<IndexDocument> | null;
    if (doc === null || typeof doc !== 'object') return;
    if (doc.version !== INDEX_VERSION) return;
    if (typeof doc.model !== 'string' || typeof doc.dims !== 'number') return;
    if (!Array.isArray(doc.entries)) return;
    this.model = doc.model;
    this.dims = doc.dims;
    this.entries = doc.entries.filter(isIndexEntry);
    this.files = plainFileStates(doc.files);
  }

  /** The model the loaded vectors came from ('' when the index is empty). */
  get embeddingModel(): string {
    return this.model;
  }

  /** The vector width in force (0 when nothing is indexed). */
  get dimensions(): number {
    return this.dims;
  }

  /**
   * Adopt the configured embedding model, dropping everything if it CHANGED.
   *
   * Vectors from two models are not comparable — mixing them would rank
   * nonsense — so a changed model invalidates the whole index, including the
   * per-file offsets: everything must be re-read and re-embedded. That cost is
   * the reason `embedModel` is documented as "changing it re-indexes", and it is
   * paid once per change.
   * @param model - the model id the embedder reports.
   * @returns whether the index was invalidated.
   */
  adoptModel(model: string): boolean {
    if (this.model === model) return false;
    this.model = model;
    this.entries = [];
    this.files = {};
    this.dims = 0;
    this.version++;
    return true;
  }

  /** Every entry, in insertion order. */
  all(): readonly IndexEntry[] {
    return this.entries;
  }

  /** Entries of one scope. */
  of(scope: IndexScope): readonly IndexEntry[] {
    return this.entries.filter((entry) => entry.scope === scope);
  }

  /** One entry by id, when present. */
  get(id: string): IndexEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  /** Ids present, as a set — the diffing primitive for a re-scan. */
  ids(): Set<string> {
    return new Set(this.entries.map((entry) => entry.id));
  }

  /** Insert or replace one entry. */
  put(entry: IndexEntry): void {
    const at = this.entries.findIndex((existing) => existing.id === entry.id);
    if (at === -1) this.entries.push(entry);
    else this.entries[at] = entry;
    this.version++;
  }

  /** Insert or replace many entries. */
  putMany(entries: readonly IndexEntry[]): void {
    for (const entry of entries) this.put(entry);
  }

  /** Drop every entry matching the predicate. */
  drop(predicate: (entry: IndexEntry) => boolean): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => !predicate(entry));
    if (this.entries.length !== before) this.version++;
  }

  /**
   * Keep at most `limit` HISTORY entries, dropping the oldest first.
   *
   * Memory entries are never evicted: they are curated, capped by their own
   * character budget, and forgetting one because a chatty week pushed the history
   * index over a count would be exactly the wrong trade.
   * @param limit - the history entry cap.
   * @returns how many were dropped.
   */
  evictHistory(limit: number): number {
    const history = this.entries.filter((entry) => entry.scope === 'history');
    if (history.length <= limit) return 0;
    const sorted = [...history].sort((a, b) => (a.meta.at ?? 0) - (b.meta.at ?? 0));
    const doomed = new Set(sorted.slice(0, history.length - limit).map((entry) => entry.id));
    this.entries = this.entries.filter((entry) => !doomed.has(entry.id));
    this.version++;
    return doomed.size;
  }

  /** The recorded read position of one session log. */
  fileState(file: string): FileState | undefined {
    return this.files[file];
  }

  /** Record a session log's read position. */
  setFileState(file: string, state: FileState): void {
    const prior = this.files[file];
    if (
      prior !== undefined
      && prior.offset === state.offset
      && prior.size === state.size
      && prior.head === state.head
    ) {
      return;
    }
    this.files[file] = state;
    this.version++;
  }

  /** Forget a session log's read position (its file is gone). */
  forgetFile(file: string): void {
    if (!(file in this.files)) return;
    delete this.files[file];
    this.version++;
  }

  /** Every recorded file path. */
  filePaths(): string[] {
    return Object.keys(this.files);
  }

  /** The expected vector width, from the entries themselves when the model matches. */
  resolveDims(): number {
    if (this.dims > 0) return this.dims;
    for (const entry of this.entries) {
      const decoded = decodeVector(entry.vector, 0);
      if (decoded !== undefined) return decoded.length;
    }
    return 0;
  }

  /** Record the vector width (called after the first successful embedding). */
  setDims(dims: number): void {
    if (this.dims === dims) return;
    this.dims = dims;
    this.version++;
  }

  /**
   * Persist the index, serialized behind every earlier write.
   *
   * The document is built INSIDE the queued task, so it always reflects the live
   * state at write time. Building it at enqueue time is the lost-update bug in
   * its other shape: an embedding that lands between the two would be written out
   * of existence.
   *
   * A pass that changed nothing writes nothing — see {@link version}.
   * @returns when this write has landed.
   */
  async flush(): Promise<void> {
    if (this.version === this.persisted) return;
    const write = this.queue.then(async () => {
      const writing = this.version;
      // Re-check inside the task: an earlier queued write may already have
      // persisted this exact state.
      if (writing === this.persisted) return;
      const doc: IndexDocument = {
        version: INDEX_VERSION,
        model: this.model,
        dims: this.dims,
        entries: this.entries,
        files: this.files,
      };
      await atomicWrite(this.file, `${JSON.stringify(doc)}\n`);
      // Marked only after the bytes landed, and only up to what was serialized:
      // a mutation during the write keeps the counter ahead, so the next flush
      // writes again instead of believing it is already on disk.
      this.persisted = writing;
    });
    // Keep the chain alive after a failure so one bad write cannot wedge every
    // later one; the caller still sees the rejection.
    this.queue = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }
}

/** Whether a parsed value looks like an index entry (defensive: the file is derived). */
function isIndexEntry(value: unknown): value is IndexEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<IndexEntry>;
  return (
    typeof entry.id === 'string'
    && (entry.scope === 'memory' || entry.scope === 'history')
    && typeof entry.text === 'string'
    && typeof entry.vector === 'string'
    && entry.meta !== null
    && typeof entry.meta === 'object'
  );
}

/** The `files` member, dropping anything malformed. */
function plainFileStates(value: unknown): Record<string, FileState> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, FileState> = {};
  for (const [file, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue;
    const state = raw as Partial<FileState>;
    if (
      typeof state.size !== 'number'
      || typeof state.mtimeMs !== 'number'
      || typeof state.head !== 'string'
      || typeof state.offset !== 'number'
    ) {
      continue;
    }
    out[file] = { size: state.size, mtimeMs: state.mtimeMs, head: state.head, offset: state.offset };
  }
  return out;
}
