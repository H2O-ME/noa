/**
 * Orchestration: keep the index in step with the memory files and the session
 * logs, and search it.
 *
 * Two things here are load-bearing and easy to get wrong.
 *
 * ## A pass reads its inputs when it STARTS
 *
 * A sync runs at plugin activation AND at the start of every `recall`, and the
 * activation one can still be mid-`embed()` (seconds of network) when a message
 * arrives. So there is a lock — two concurrent passes would scan the same logs
 * twice and interleave two writers into one index.
 *
 * But a plain single-flight lock is WRONG here, and the failure it causes is
 * silent: a caller that arrives during the boot pass would wait for a pass that
 * read the memory files before this caller's note existed, and then search an
 * index that does not contain it. The caller asked "is the index up to date?" and
 * got a yes about a moment that had already passed. So a caller that arrives
 * mid-pass asks for one more pass and waits for THAT — see {@link sync}.
 *
 * ## Never advance a read position over material that was not indexed
 *
 * The episode scanner reports where it got to, and this layer records that
 * position only when every chunk it produced actually landed in the index. An
 * embedding failure therefore costs a retry next pass, not a hole in the history
 * that nothing would ever fill — the failure mode where a transient network
 * blip silently drops a week of conversations from the index.
 *
 * ## Nothing here is fatal
 *
 * Every step degrades: no embedding model means texts are indexed without
 * vectors (keyword recall still works), an embedding failure means the pass
 * stops early, an unreadable log is skipped. A memory system that takes the
 * agent down is worse than one that knows less.
 */
import { errMessage, type EmbeddingClient } from '@noa/core';
import { scanSessionFile, sessionFilesNewestFirst, type EpisodeChunk } from './episodes.js';
import { type MemoryStore } from './store.js';
import {
  decodeVector,
  dot,
  encodeVector,
  keywordScores,
  memoryEntryId,
  normalizeVector,
  textHash,
  type IndexEntry,
  type IndexScope,
  type VectorIndex,
} from './vectors.js';

/** How the indexer is configured. */
export interface IndexerOptions {
  readonly store: MemoryStore;
  readonly index: VectorIndex;
  /** Absent = keyword-only indexing (texts stored, no vectors). */
  readonly embedder?: EmbeddingClient;
  /** Embedding calls per pass, across all sources. */
  readonly maxEmbedsPerPass: number;
  /** History entries kept; the oldest are evicted past this. */
  readonly maxEpisodeChunks: number;
  /** Messages shorter than this are not indexed. */
  readonly minEpisodeChars: number;
  /**
   * Cosine similarity below which a vector hit is treated as no match at all.
   * Real embeddings are almost never exactly orthogonal, so without a floor a
   * query about something absent from memory still returns its top-K
   * least-unrelated notes.
   */
  readonly minSimilarity: number;
  /** The date-bucketed sessions root. */
  readonly sessionsRoot: string;
  /** Non-fatal problems, for the plugin's log. */
  readonly onWarn?: (message: string) => void;
}

/** One ranked search hit. */
export interface RecallHit {
  readonly entry: IndexEntry;
  /**
   * The ranking score — with both paths available, a fused score rather than a
   * cosine (see {@link fuseRankings}). Use {@link similarity} to judge how close
   * the match actually is.
   */
  readonly score: number;
  /** Cosine similarity, when the vector path ranked this entry. */
  readonly similarity?: number;
  /** Which path(s) surfaced it. */
  readonly via: 'vector' | 'keyword' | 'both';
}

/** What a search returned, plus how it was produced. */
export interface RecallOutcome {
  readonly hits: readonly RecallHit[];
  /**
   * Whether a query vector was available at all. False means keywords alone
   * ranked the results — either no embedding model is configured, or the query
   * failed to embed.
   */
  readonly vectorUsed: boolean;
  /** How many entries were candidates. */
  readonly considered: number;
}

/** The RRF constant: the rank at which a hit's contribution has halved. */
const RRF_K = 60;

/**
 * Fuse ranked lists by reciprocal rank.
 *
 * The two rankings are not comparable — a cosine similarity and an IDF-weighted
 * token sum live on different scales, and adding them (or thresholding one
 * against the other) is meaningless. Reciprocal rank throws the scores away and
 * keeps only the ORDER: a hit at rank `r` contributes `1 / (k + r)`. An entry
 * ranked highly by both paths therefore wins outright, an entry ranked by only
 * one still appears, and there is no relative weight to tune.
 *
 * This is the hybrid-search trick Honcho uses (`src/utils/search.py`, k=60). It
 * is worth borrowing precisely because it needs no index structure: BM25 would
 * require on-disk term statistics, which is the part that does not fit a
 * file-backed index, while this costs arithmetic over lists already computed.
 * @param lists - ranked lists, best first.
 * @returns one ranked list, best first.
 */
function fuseRankings(...lists: readonly RecallHit[][]): RecallHit[] {
  const fused = new Map<string, { entry: IndexEntry; score: number; similarity?: number; via: RecallHit['via'] }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank];
      if (hit === undefined) continue;
      const contribution = 1 / (RRF_K + rank + 1);
      const prior = fused.get(hit.entry.id);
      if (prior === undefined) {
        fused.set(hit.entry.id, { entry: hit.entry, score: contribution, similarity: hit.similarity, via: hit.via });
        continue;
      }
      prior.score += contribution;
      // Surfaced by both paths: the strongest evidence there is that this entry is
      // what was asked for, so it is worth reporting as such.
      if (prior.via !== hit.via) prior.via = 'both';
      if (hit.similarity !== undefined) prior.similarity = hit.similarity;
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * Keep the index in step with everything it indexes.
 *
 * One instance per kernel, held by the plugin. All state is the {@link VectorIndex}
 * it was handed; this class adds only the single-flight lock and the update
 * policy.
 */
export class MemoryIndexer {
  /** The pass in flight, with the sequence number that identifies when it began. */
  private running: { id: number; promise: Promise<void> } | null = null;
  /** How many passes have STARTED. A pass covers a caller iff it began after them. */
  private started = 0;

  /** @param opts - the wiring. */
  constructor(private readonly opts: IndexerOptions) {}

  /**
   * Bring the index up to date, or wait for a pass that includes this call.
   *
   * The contract is what makes it more than a lock: when this resolves, the index
   * reflects the memory files and session logs as they were when the caller
   * called — not as they were when some earlier pass happened to start. A caller
   * that arrives during a pass in flight therefore waits for ONE MORE pass,
   * because the in-flight one read its inputs before this caller's data existed.
   *
   * The comparison is by pass SEQUENCE, not by a "dirty" flag. A flag looks
   * equivalent and is not: with two callers each marking the other's pass stale,
   * every completion schedules another pass and the loop never ends. A sequence
   * number gives each caller a definite answer — "has a pass begun since I was
   * called?" — so the wait is bounded by the number of callers.
   *
   * The extra pass is cheap when nothing changed (the index skips the write
   * entirely — see `VectorIndex.flush`), which is what makes the safe answer also
   * the affordable one.
   * @returns when the index reflects this caller's world.
   */
  async sync(): Promise<void> {
    const calledAt = this.started;
    for (;;) {
      const running = this.running;
      if (running === null) {
        // Nothing in flight: a pass started now reads its inputs now, so it
        // covers this caller. The owner is the one that started it.
        await this.startPass();
        return;
      }
      // A pass began before this call, so its inputs predate this caller's data.
      // Wait for it either way; then loop — by then a covering pass may be
      // running, or the field is free and we start one ourselves.
      const covered = running.id > calledAt;
      await running.promise.catch(() => undefined);
      if (covered) return;
    }
  }

  /** Begin one pass, tracking it so a later caller can wait for or supersede it. */
  private startPass(): Promise<void> {
    const id = ++this.started;
    // The clearing is attached to the returned promise, so it has already run by
    // the time ANY awaiter resumes — no awaiter can observe a finished pass as
    // still in flight.
    const promise = this.run().finally(() => {
      if (this.running?.id === id) this.running = null;
    });
    this.running = { id, promise };
    return promise;
  }

  /**
   * Rank entries against a query.
   *
   * Both rankings are computed whenever they are available, and fused — keyword
   * matching is not a fallback here but half the signal (see {@link fuseRankings}).
   * With no embedding model the vector list is empty and the keyword ranking
   * stands alone, which is what an install without `embedModel` runs on every
   * search; that path is a real ranking, not a stub (see `keywordScores`).
   * @param query - what to look for.
   * @param opts - scope, limit and the echo filter.
   * @returns the hits, best first.
   */
  async search(
    query: string,
    opts: {
      scope?: 'all' | IndexScope;
      limit: number;
      /** Session id to exclude (the conversation asking), when known. */
      excludeSessionId?: string;
      /** Drop history hits from the last few minutes that nearly duplicate the query. */
      now?: number;
    },
  ): Promise<RecallOutcome> {
    const scope = opts.scope ?? 'all';
    const candidates = await this.candidatesFor(scope);
    const now = opts.now ?? Date.now();
    const queryVector = await this.embedQuery(query);
    const vector = queryVector === undefined ? [] : this.vectorRanking(queryVector, candidates);
    const hits = fuseRankings(vector, this.keywordRanking(query, candidates));
    return {
      hits: this.filterAndCap(hits, opts, now),
      // "Was a query vector available", not "did a vector hit survive": a floor
      // that rejects every candidate is a search that found nothing, not a search
      // that fell back, and the caller's message must not conflate the two.
      vectorUsed: queryVector !== undefined,
      considered: candidates.length,
    };
  }

  /**
   * The candidates one scope searches.
   *
   * 笔记**直读文件**，不查索引 —— 两个理由，任一都够：
   *
   *  - 文件是权威来源，索引只是它的缓存。缓存没同步（嵌入不可用、pass 还没跑到）
   *    时检索会回「没有找到」，而文件里明明有一条 —— 实测发生过：`USER.md` 里
   *    有一条笔记，`recall {scope:"memory"}` 却说「没有找到相关的记忆」；
   *  - 条目本来就少（受字符预算约束）。Hermes 干脆全量注入系统提示、**根本不检索**
   *    （`tools/memory_tool_store.py:638-644`，`memory` 工具只写不读）。这里保留
   *    recall 作为模型的主动查询入口，但答案必须来自同一份文件。
   *
   * 历史是另一回事：那是唯一大到必须走向量索引的一侧。
   * @param scope - which sources to draw from.
   * @returns the candidates, notes first (they are the curated, trusted half).
   */
  private async candidatesFor(scope: 'all' | IndexScope): Promise<IndexEntry[]> {
    const out: IndexEntry[] = [];
    if (scope === 'all' || scope === 'memory') out.push(...await this.noteEntries());
    if (scope === 'all' || scope === 'history') {
      out.push(...this.opts.index.all().filter((entry) => entry.scope === 'history'));
    }
    return out;
  }

  /**
   * The curated notes as search candidates, read live from their files.
   *
   * 存在性以文件为准，向量是索引给的**增强**：同一条笔记若已在索引里（同步成功），
   * 就借用它的向量参与语义排序；同步没跑到或嵌入不可用时，这一条照样以空向量进入
   * 候选，关键词排序仍然找得到它。两边各司其职，谁也不当单点。
   */
  private async noteEntries(): Promise<IndexEntry[]> {
    const groups = await this.opts.store.loadAll();
    return groups.flatMap((group) =>
      group.entries.map((text) => {
        const id = memoryEntryId(group.target, text);
        return {
          id,
          scope: 'memory' as const,
          text,
          meta: { textHash: textHash(text), target: group.target },
          vector: this.opts.index.get(id)?.vector ?? '',
        };
      }),
    );
  }

  /** Cosine-ranked candidates; a hit below `minSimilarity` is treated as no match. */
  private vectorRanking(queryVector: Float32Array, candidates: readonly IndexEntry[]): RecallHit[] {
    const dims = queryVector.length;
    const floor = this.opts.minSimilarity;
    const hits: RecallHit[] = [];
    for (const entry of candidates) {
      if (entry.vector.length === 0) continue;
      const vector = decodeVector(entry.vector, dims);
      // A vector that will not decode is corruption from an older or truncated
      // document; skipping it is the only honest option (it cannot be compared).
      if (vector === undefined) continue;
      const similarity = dot(queryVector, vector);
      if (similarity < floor) continue;
      hits.push({ entry, score: similarity, similarity, via: 'vector' });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /** IDF-weighted keyword ranking; entries sharing no token with the query are absent. */
  private keywordRanking(query: string, candidates: readonly IndexEntry[]): RecallHit[] {
    const scored = keywordScores(
      query,
      candidates.map((entry) => ({ id: entry.id, text: entry.text })),
    );
    // 回查用的是**本次候选集**，不是索引。这两者不再相等（笔记直读文件，可能不在
    // 索引里），而从索引回查会把直读来的候选悄悄丢掉 —— 命中了、却又被扔掉，症状
    // 就是「文件里明明有一条，recall 却说没有找到」。
    const byId = new Map(candidates.map((entry) => [entry.id, entry]));
    const hits: RecallHit[] = [];
    for (const [id, score] of scored) {
      const entry = byId.get(id);
      if (entry !== undefined) hits.push({ entry, score, via: 'keyword' });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits;
  }

  /** Embed the query, or undefined when there is no vector path. */
  private async embedQuery(query: string): Promise<Float32Array | undefined> {
    const embedder = this.opts.embedder;
    if (embedder === undefined || query.trim().length === 0) return undefined;
    try {
      const [vector] = await embedder.embed([query]);
      if (vector === undefined || vector.length === 0) return undefined;
      return normalizeVector(vector);
    } catch (err) {
      this.opts.onWarn?.(`query embedding failed, falling back to keywords: ${errMessage(err)}`);
      return undefined;
    }
  }

  /**
   * Apply the echo filter and the per-conversation quota, then cap the list.
   *
   * The echo problem is specific and worth stating: the current conversation's
   * last few turns are semantically almost identical to the query (the query is
   * usually about them), so a plain top-5 returns mostly what is already in the
   * context window. Excluding the asking session by id is the exact fix; the
   * time-and-similarity guard is the backstop for a caller that has no session id
   * to give (a kernel-level call), and it reads `similarity` rather than `score`
   * because only the cosine is on a scale a threshold means anything for.
   *
   * The per-session quota is the second half: without it, one long conversation
   * with the right vocabulary can fill every slot, and the cross-conversation hit
   * that was the whole point never surfaces. Honcho solves the same crowding by
   * oversampling `limit * 3` and collapsing duplicate chunks afterwards; a hard
   * per-session cap does the same job in one pass.
   */
  private filterAndCap(hits: RecallHit[], opts: { limit: number; excludeSessionId?: string }, now: number): RecallHit[] {
    const excluded = opts.excludeSessionId;
    const perSession = new Map<string, number>();
    const out: RecallHit[] = [];
    for (const hit of hits) {
      const { sessionId, at } = hit.entry.meta;
      if (hit.entry.scope === 'history') {
        if (excluded !== undefined && sessionId === excluded) continue;
        if (excluded === undefined && at !== undefined && now - at < 120_000 && (hit.similarity ?? 0) > 0.96) continue;
        if (sessionId !== undefined) {
          const used = perSession.get(sessionId) ?? 0;
          if (used >= 3) continue;
          perSession.set(sessionId, used + 1);
        }
      }
      out.push(hit);
      if (out.length >= Math.max(1, opts.limit)) break;
    }
    return out;
  }

  /** One pass: memory files, then new conversation bytes, then persist. */
  private async run(): Promise<void> {
    await this.opts.index.load();
    const embedder = this.opts.embedder;
    // Only an actual embedder may claim a model: with none, whatever the index
    // already recorded stays, and the entries it holds stay usable for keywords.
    if (embedder !== undefined && this.opts.index.adoptModel(embedder.model)) {
      this.opts.onWarn?.(`embedding model changed to ${embedder.model}: re-indexing everything`);
    }
    let budget = this.opts.maxEmbedsPerPass;
    budget -= await this.syncMemoryEntries(budget);
    if (budget > 0) budget -= await this.syncEpisodes(budget);
    this.opts.index.evictHistory(this.opts.maxEpisodeChunks);
    try {
      await this.opts.index.flush();
    } catch (err) {
      // The indexing work is already done and lives in memory; only the CACHE
      // write failed. A plugin reload can race a flush in flight (the old
      // instance's atomic rename losing to the new one's), and that is worth a
      // warning, not a failed pass — the next pass rewrites the same document.
      this.opts.onWarn?.(`could not persist the index: ${errMessage(err)}`);
    }
  }

  /**
   * Diff the curated memory files against the index.
   *
   * 这一份**不是**笔记的权威来源（文件才是，见 `candidatesFor`）：它维护的是同一条
   * 笔记的向量，让语义排序在笔记上也可用。所以它同步失败不再等于「笔记搜不到」——
   * 只等于「这一轮笔记少了语义匹配」。
   */
  private async syncMemoryEntries(budget: number): Promise<number> {
    const groups = await this.opts.store.loadAll();
    const desired = new Map<string, { target: 'memory' | 'user'; text: string }>();
    for (const group of groups) {
      for (const text of group.entries) desired.set(memoryEntryId(group.target, text), { target: group.target, text });
    }
    // An entry the operator deleted (or the model rewrote) leaves its old id
    // behind; dropping by id here is what keeps the index a function of the files
    // rather than an append-only shadow of them.
    this.opts.index.drop((entry) => entry.scope === 'memory' && !desired.has(entry.id));
    const todo: IndexEntry[] = [];
    for (const [id, { target, text }] of desired) {
      const existing = this.opts.index.get(id);
      if (existing !== undefined && existing.text === text) continue;
      todo.push({
        id,
        scope: 'memory',
        text,
        meta: { textHash: textHash(text), target },
        vector: '',
      });
    }
    return await this.embed(todo, budget);
  }

  /** Read every new byte of every session log, newest conversation first. */
  private async syncEpisodes(budget: number): Promise<number> {
    const files = await sessionFilesNewestFirst(this.opts.sessionsRoot);
    const live = new Set(files.map((entry) => entry.file));
    for (const known of this.opts.index.filePaths()) {
      if (!live.has(known)) this.opts.index.forgetFile(known);
    }
    let remaining = budget;
    for (const { file } of files) {
      if (remaining <= 0) break;
      const scan = await scanSessionFile(file, this.opts.index.fileState(file), {
        minChars: this.opts.minEpisodeChars,
        maxChunks: remaining,
      });
      if (scan === undefined) continue;
      const todo = this.pendingChunks(scan.chunks);
      if (todo.length === 0) {
        this.opts.index.setFileState(file, scan.state);
        continue;
      }
      const embedded = await this.embed(todo, remaining);
      if (embedded < todo.length) {
        // Embedding is failing (or the budget ran out mid-file). Stopping here
        // without recording the position means the next pass re-reads these exact
        // bytes — a retry, never a gap.
        break;
      }
      this.opts.index.setFileState(file, scan.state);
      remaining -= embedded;
    }
    return budget - remaining;
  }

  /** Chunks not already indexed verbatim (the vector-reuse rule). */
  private pendingChunks(chunks: readonly EpisodeChunk[]): IndexEntry[] {
    const todo: IndexEntry[] = [];
    for (const chunk of chunks) {
      const existing = this.opts.index.get(chunk.id);
      // Same id AND same text means this chunk was already embedded — the common
      // case after a re-scan (a log rewritten by an upgrade, a repaired tail). The
      // stored vector is reused instead of spending an embedding call to
      // recompute a value we already have.
      if (existing !== undefined && existing.text === chunk.text) continue;
      todo.push({
        id: chunk.id,
        scope: 'history',
        text: chunk.text,
        meta: {
          textHash: textHash(chunk.text),
          sessionId: chunk.sessionId,
          role: chunk.role,
          at: chunk.at,
        },
        vector: '',
      });
    }
    return todo;
  }

  /**
   * Embed and store up to `budget` entries.
   * @returns how many actually landed (fewer than asked = the caller must not
   *   advance its read position).
   */
  private async embed(entries: readonly IndexEntry[], budget: number): Promise<number> {
    const batch = entries.slice(0, Math.max(0, Math.trunc(budget)));
    if (batch.length === 0) return 0;
    const embedder = this.opts.embedder;
    if (embedder === undefined) {
      // No embedding model: store the TEXT and leave the vector empty. Keyword
      // recall searches these, so an install without `embedModel` still has a
      // working memory — just a less clever one.
      this.opts.index.putMany(batch);
      return batch.length;
    }
    let vectors: number[][];
    try {
      vectors = await embedder.embed(batch.map((entry) => entry.text));
    } catch (err) {
      this.opts.onWarn?.(`embedding failed: ${errMessage(err)}`);
      return 0;
    }
    const done: IndexEntry[] = [];
    for (let i = 0; i < batch.length; i++) {
      const entry = batch[i];
      const vector = vectors[i];
      if (entry === undefined || vector === undefined || vector.length === 0) continue;
      done.push({ ...entry, vector: encodeVector(normalizeVector(vector)) });
    }
    if (done.length === 0) return 0;
    const dims = vectorDims(done[0]);
    if (dims > 0) this.opts.index.setDims(dims);
    this.opts.index.putMany(done);
    return done.length;
  }
}

/** The dimension count of an encoded entry (0 when it cannot be decoded). */
function vectorDims(entry: IndexEntry | undefined): number {
  if (entry === undefined) return 0;
  return decodeVector(entry.vector, 0)?.length ?? 0;
}
