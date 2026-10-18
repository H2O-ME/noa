/**
 * models.dev: where this product learns what a model can do.
 *
 * The endpoint publishes ids and nothing else (Noa's gateway answers `GET
 * /models` with `id` / `object` / `created` / `owned_by`), so "can this model
 * see an image" has to come from somewhere. models.dev is that somewhere, and
 * this file is the only place that knows it is a downloaded JSON document.
 *
 * ## What it is used for, and what it is not
 *
 * It answers CAPABILITIES for an id. It is deliberately not the source of the
 * model LIST — the endpoint is, because a gateway that adds a model must not
 * need this product re-released (see `ModelCatalogPort`).
 *
 * ## The matching rule, and why it counts
 *
 * Ids are matched by their LAST path segment, lowercased with punctuation
 * stripped: the gateway says `DeepSeek-V4-Flash`, models.dev says
 * `deepinfra/deepseek-ai/DeepSeek-V4-Flash`, and both normalize to
 * `deepseekv4flash`. That part is easy.
 *
 * The hard part is that models.dev carries the same id under dozens of providers
 * and they do not always say the same thing. Measured on the live document:
 *
 * | id | votes on "accepts images" |
 * | --- | --- |
 * | `deepseek-v4-flash` | no 65, yes 1 |
 * | `deepseek-v4.1-flash` | yes 77, no 4 |
 * | `glm-5.2` | no 95, yes 1 |
 * | `qwen3.8-flash` | yes 32, no 2 |
 *
 * Two things follow, and both are load-bearing:
 *
 *  1. **Only the `image` bit is voted on.** The raw lists differ constantly
 *     without disagreeing about anything this product consumes — `["text",
 *     "image"]`, `["text","image","video"]` and `["text","image","video","pdf"]`
 *     are three spellings of "it takes pictures". Comparing whole lists turned
 *     every one of those into a conflict and left the feature doing nothing.
 *  2. **A clear majority decides; a close call stays unknown.** Two thirds. The
 *     splits above are 65:1, 77:4, 95:1 and 32:2 — real signal, not noise, and
 *     the first one is the exact model this product runs on (independently
 *     measured as text-only: the gateway accepts a 195KB image and reports the
 *     same `prompt_tokens` as a request carrying none). A 50:50 would still be a
 *     coin flip, so it is reported as unknown rather than guessed.
 *
 * Entries whose `canonical_model_id` points at a DIFFERENT id are dropped before
 * the count: they are aliases speaking for another model. That is models.dev's
 * own metadata, not a heuristic, and it removes the loudest source of confusion
 * here (`deepseek/deepseek-v4-flash` is an alias for `deepseek-v4.1-flash-1017`,
 * so it claims image support for an id that is otherwise text-only).
 *
 * Only `text` and `image` are ever reported, whatever else the winning side
 * listed: the vote was on the image bit, and asserting `video` or `pdf` from it
 * would be claiming something nobody counted.
 *
 * ## Freshness
 *
 * The document is ~6MB, so it is fetched at most once per TTL and cached under
 * `~/.noa/cache/`. Every failure path — no network, a truncated download, a
 * cache file that will not parse — degrades to "no answer", which is a state the
 * whole stack already handles. Nothing here can fail a turn.
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheRoot, errMessage, type ModelCapabilities } from '@noa/core';

/** The document. One URL, one shape; the API is a single JSON blob. */
export const MODELS_DEV_URL = 'https://models.dev/api.json';

/** How long a cached copy is trusted. Capabilities move on release cadence, not daily. */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A download that takes longer than this is not worth waiting for. */
const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/** Where the cached document lives. */
export function modelsDevCachePath(homedir?: string): string {
  return path.join(cacheRoot(homedir), 'models-dev.json');
}

/**
 * What models.dev says about one id.
 *
 * Three states rather than an optional list, because "we looked and it
 * disagrees" is a different fact from "we have never heard of this id" — and
 * the first one is worth telling the operator about, since it means the
 * automatic source cannot be relied on for that model.
 */
export type ModelsDevAnswer =
  | { readonly kind: 'declared'; readonly inputModalities: readonly string[] }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'absent' };

/** The loaded document, as a lookup plus a refresh hook. */
export interface ModelsDevIndex {
  /** models.dev's answer for one id. */
  answer(model: string): ModelsDevAnswer;
  /**
   * Re-download when the cached copy is stale or missing. Never throws: the
   * caller is a boot path, and a model directory is not worth failing a start.
   * @returns whether the document was replaced.
   */
  refreshIfStale(): Promise<boolean>;
}

/** The share of the vote a side needs before its answer is treated as a fact. */
const MAJORITY_NUMERATOR = 2;
const MAJORITY_DENOMINATOR = 3;

/** One id's collected evidence: how many entries said yes, and how many said no. */
interface Evidence {
  /** Entries whose `input` includes `image`. */
  yes: number;
  /** Entries whose `input` does not. */
  no: number;
}

/**
 * Normalize a model id for matching: its last path segment, lowercased, with
 * every non-alphanumeric character removed.
 *
 * The last segment because models.dev ids carry the provider path
 * (`deepinfra/deepseek-ai/DeepSeek-V4-Flash`) while a gateway publishes the bare
 * name. Punctuation because `DeepSeek-V4-Flash`, `deepseek-v4-flash` and
 * `deepseek_v4_flash` are the same model spelled three ways.
 * @param id - a model id from either side.
 * @returns the comparison key.
 */
export function modelsDevKey(id: string): string {
  const last = id.split('/').pop() ?? id;
  return last.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

/**
 * The evidence one models.dev entry contributes, or undefined when it carries
 * none that this product may use.
 *
 * The alias filter lives here: an entry whose `canonical_model_id` points at a
 * DIFFERENT id speaks for that id rather than this one.
 * @param id - the entry's key within its provider.
 * @param raw - the entry, of unknown shape (the document is third-party JSON).
 * @returns the key it speaks for and whether it accepts images.
 */
function entryEvidence(id: string, raw: unknown): { key: string; images: boolean } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const entry = raw as { canonical_model_id?: unknown; modalities?: unknown };
  const key = modelsDevKey(id);
  if (key.length === 0) return undefined;
  const canonical = entry.canonical_model_id;
  if (typeof canonical === 'string' && modelsDevKey(canonical) !== key) return undefined;
  const input = (entry.modalities as { input?: unknown } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  return { key, images: input.includes('image') };
}

/**
 * Reduce the parsed document to one answer per model id.
 *
 * Exported for tests: this is the rule above, and the rule is the part worth
 * pinning down (the download is not).
 * @param document - the parsed `api.json`.
 * @returns a key → answer map, with close calls already marked as conflicts.
 */
export function buildModelsDevIndex(document: unknown): Map<string, ModelsDevAnswer> {
  const evidence = new Map<string, Evidence>();
  if (typeof document !== 'object' || document === null) return new Map();
  for (const provider of Object.values(document as Record<string, unknown>)) {
    if (typeof provider !== 'object' || provider === null) continue;
    const models = (provider as { models?: unknown }).models;
    if (typeof models !== 'object' || models === null) continue;
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
      const found = entryEvidence(id, raw);
      if (found === undefined) continue;
      const slot = evidence.get(found.key) ?? { yes: 0, no: 0 };
      if (found.images) slot.yes += 1;
      else slot.no += 1;
      evidence.set(found.key, slot);
    }
  }
  const out = new Map<string, ModelsDevAnswer>();
  for (const [key, slot] of evidence) out.set(key, decide(slot));
  return out;
}

/** Turn one id's votes into an answer. */
function decide(slot: Evidence): ModelsDevAnswer {
  const total = slot.yes + slot.no;
  const winner = Math.max(slot.yes, slot.no);
  // No floor on the vote count: a single entry is unanimous by construction, and
  // "every source that mentions this id agrees" is the strongest evidence there
  // is for a model only one provider lists. Two against one passes (6 ≥ 6), two
  // against two does not.
  const clear = winner * MAJORITY_DENOMINATOR >= total * MAJORITY_NUMERATOR;
  if (!clear) return { kind: 'conflict' };
  // Only the bit that was voted on is reported, in its minimal spelling.
  return slot.yes > slot.no
    ? { kind: 'declared', inputModalities: ['text', 'image'] }
    : { kind: 'declared', inputModalities: ['text'] };
}

/** The answer for one id, from a built index. */
function answerFrom(index: ReadonlyMap<string, ModelsDevAnswer>, model: string): ModelsDevAnswer {
  const key = modelsDevKey(model);
  return key.length === 0 ? { kind: 'absent' } : index.get(key) ?? { kind: 'absent' };
}

/** Capabilities in the shape the catalog port speaks. Unknown fields stay absent. */
export function capabilitiesFrom(answer: ModelsDevAnswer): ModelCapabilities | undefined {
  if (answer.kind !== 'declared') return undefined;
  return { inputModalities: answer.inputModalities };
}

/**
 * Load the index, from cache when it is fresh and from the network otherwise.
 *
 * Boot-time work: one file read, and at most one download. The returned index is
 * a plain in-memory map, so the per-request capability lookup never touches the
 * disk or the network — which matters because that lookup happens while a turn
 * is being assembled.
 * @param options - cache location, clock, fetch and logging seams for tests.
 * @returns the index (never a rejection: every failure degrades to an empty one).
 */
export async function loadModelsDev(options: {
  homedir?: string;
  cacheFile?: string;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
} = {}): Promise<ModelsDevIndex> {
  const cacheFile = options.cacheFile ?? modelsDevCachePath(options.homedir);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => {});
  let index = new Map<string, ModelsDevAnswer>();
  let fetchedAt = 0;

  const readCache = async (): Promise<void> => {
    try {
      const text = await readFile(cacheFile, 'utf8');
      index = buildModelsDevIndex(JSON.parse(text));
      fetchedAt = (await statMtime(cacheFile)) ?? now();
    } catch (err) {
      // Absent is the normal first-run state; a corrupt file is not worth a
      // louder failure than a line, since the next refresh replaces it.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log(`models.dev 缓存读取失败，本次按「未知」处理：${errMessage(err)}`);
      }
    }
  };

  const download = async (): Promise<boolean> => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    try {
      const response = await doFetch(MODELS_DEV_URL, { signal: controller.signal });
      if (!response.ok) {
        log(`models.dev 下载失败：HTTP ${response.status}，本次按「未知」处理`);
        return false;
      }
      const text = await response.text();
      const parsed: unknown = JSON.parse(text);
      const next = buildModelsDevIndex(parsed);
      if (next.size === 0) {
        // A 200 carrying nothing usable is a failed refresh, not an empty
        // catalog: replacing a good index with it would turn every model
        // unknown at once.
        log('models.dev 返回的文档里没有可用的模型条目，保留旧索引');
        return false;
      }
      await writeAtomically(cacheFile, text, log);
      index = next;
      fetchedAt = now();
      return true;
    } catch (err) {
      log(`models.dev 下载失败，本次按「未知」处理：${errMessage(err)}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  await readCache();
  if (now() - fetchedAt > ttlMs) await download();

  return {
    answer: (model: string) => answerFrom(index, model),
    refreshIfStale: async () => {
      if (now() - fetchedAt <= ttlMs) return false;
      return await download();
    },
  };
}

/** The cache file's mtime, or undefined when it cannot be read. */
async function statMtime(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Same-directory temp + rename, so a reader never sees a half-written document. */
async function writeAtomically(file: string, text: string, log: (message: string) => void): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(temp, text, 'utf8');
    await rename(temp, file);
  } catch (err) {
    // The cost of a failed cache write is one more download next boot; it must
    // not cost the boot itself.
    log(`models.dev 缓存写入失败（不影响本次运行）：${errMessage(err)}`);
  }
}
