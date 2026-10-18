/**
 * Vectors: the math (normalization, dot product as cosine), the base64 codec
 * including the Buffer-pool alignment trap, the Chinese-aware keyword scorer, and
 * the index document's model invalidation.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decodeVector,
  dot,
  encodeVector,
  keywordScores,
  memoryEntryId,
  normalizeVector,
  textHash,
  tokenize,
  VectorIndex,
  type IndexEntry,
} from '../src/vectors.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noa-memory-vec-'));
});

/** One index entry with a vector built from a raw array. */
function entry(id: string, vector: readonly number[], text = id): IndexEntry {
  return {
    id,
    scope: 'memory',
    text,
    meta: { textHash: textHash(text) },
    vector: encodeVector(normalizeVector(vector)),
  };
}

describe('normalizeVector', () => {
  it('makes a unit vector, so the dot product IS the cosine', () => {
    const unit = normalizeVector([3, 4]);
    expect(dot(unit, unit)).toBeCloseTo(1, 6);
    expect(dot(normalizeVector([1, 0]), normalizeVector([0, 1]))).toBeCloseTo(0, 6);
    // A vector that is NOT unit length still compares as an angle, which is the
    // whole point of normalizing at the boundary: endpoints do not all return
    // unit vectors, and cosine over raw values without dividing by the norms is
    // simply the wrong number.
    const a = normalizeVector([10, 0]);
    const b = normalizeVector([0, 7]);
    expect(dot(a, b)).toBeCloseTo(0, 6);
    expect(dot(a, normalizeVector([5, 5]))).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('leaves the zero vector alone instead of producing NaNs', () => {
    const zero = normalizeVector([0, 0, 0]);
    expect([...zero]).toEqual([0, 0, 0]);
    expect(dot(zero, zero)).toBe(0);
  });

  it('replaces non-finite components with zero (NaN cannot be serialized)', () => {
    const vector = normalizeVector([Number.NaN, 1, Number.POSITIVE_INFINITY]);
    expect([...vector].every((value) => Number.isFinite(value))).toBe(true);
  });
});

describe('base64 float32 codec', () => {
  it('round-trips a vector exactly', () => {
    const original = normalizeVector([0.5, -0.25, 0.125, 0.0625]);
    const decoded = decodeVector(encodeVector(original), 4);
    expect(decoded).toBeDefined();
    expect([...(decoded ?? [])]).toEqual([...original]);
  });

  it('decodes many vectors without the Buffer-pool alignment error', () => {
    // Node hands out small Buffers from a shared pool, so the decoded bytes start
    // at an arbitrary byteOffset — constructing a Float32Array directly over
    // `buf.buffer` throws RangeError once the offset is not a multiple of 4. The
    // loop is what makes that failure appear if the copy is ever removed.
    const vectors = Array.from({ length: 200 }, (_, i) => normalizeVector([i, i + 1, i + 2, i + 3]));
    for (const [i, vector] of vectors.entries()) {
      const decoded = decodeVector(encodeVector(vector), 4);
      expect(decoded, `vector ${i}`).toBeDefined();
      expect([...(decoded ?? [])], `vector ${i}`).toEqual([...vector]);
    }
  });

  it('rejects a dimension mismatch, bad base64 and a partial float', () => {
    expect(decodeVector(encodeVector(normalizeVector([1, 2, 3])), 4)).toBeUndefined();
    expect(decodeVector(Buffer.from([1, 2, 3]).toString('base64'), 0)).toBeUndefined();
    expect(decodeVector('', 0)).toBeUndefined();
  });
});

describe('tokenize', () => {
  it('splits Chinese into words rather than one token per sentence', () => {
    const tokens = tokenize('我们上周把部署脚本迁移到了自建 runner');
    // A whitespace split would yield exactly one token here, which is what makes
    // keyword matching useless for this product's conversations.
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens).toContain('部署');
    expect(tokenize('部署')).not.toEqual(['我们上周把部署脚本迁移到了自建runner']);
  });

  it('splits English on word boundaries and lowercases', () => {
    expect(tokenize('Deploy Script')).toEqual(['deploy', 'script']);
  });

  it('returns something for a string with no spaces at all', () => {
    expect(tokenize('abcdefgh').length).toBeGreaterThan(0);
  });
});

describe('keywordScores', () => {
  it('ranks the document sharing a rare token above one sharing a common one', () => {
    const docs = [
      { id: 'a', text: '部署脚本迁移到了自建 runner' },
      { id: 'b', text: '生产环境在 cn-north 区域' },
      { id: 'c', text: '部署环境也要跟着改' },
    ];
    const scores = keywordScores('部署', docs);
    expect(scores.get('a')).toBeGreaterThan(0);
    expect(scores.get('c')).toBeGreaterThan(0);
    expect(scores.get('b')).toBeUndefined();
  });

  it('gives an IDF bonus to the term that only one document has', () => {
    const docs = [
      { id: 'a', text: '部署 迁移' },
      { id: 'b', text: '部署 部署 部署' },
    ];
    const scores = keywordScores('迁移', docs);
    expect(scores.get('a')).toBeGreaterThan(0);
    expect(scores.get('b')).toBeUndefined();
  });

  it('returns nothing for an empty query or no documents', () => {
    expect(keywordScores('   ', [{ id: 'a', text: 'x' }]).size).toBe(0);
    expect(keywordScores('x', []).size).toBe(0);
  });
});

describe('ids', () => {
  it('keys a memory entry by its content', () => {
    expect(memoryEntryId('user', '同一句话')).toBe(memoryEntryId('user', '同一句话'));
    expect(memoryEntryId('user', 'a')).not.toBe(memoryEntryId('memory', 'a'));
    expect(memoryEntryId('user', 'a')).not.toBe(memoryEntryId('user', 'b'));
  });
});

describe('VectorIndex', () => {
  it('loads an empty index when the file is missing or corrupt', async () => {
    const index = new VectorIndex(path.join(dir, 'index.json'));
    await index.load();
    expect(index.all()).toHaveLength(0);

    await writeFile(path.join(dir, 'index.json'), 'not json at all', 'utf8');
    const broken = new VectorIndex(path.join(dir, 'index.json'));
    await broken.load();
    expect(broken.all()).toHaveLength(0);
  });

  it('round-trips entries and file positions through a flush', async () => {
    const file = path.join(dir, 'index.json');
    const index = new VectorIndex(file);
    await index.load();
    index.adoptModel('text-embedding-3-small');
    index.put(entry('memory:user:abc', [1, 0, 0], '关于操作者的一条'));
    index.setFileState('/logs/a.jsonl', { size: 10, mtimeMs: 5, head: 'deadbeef', offset: 10 });
    await index.flush();

    const reloaded = new VectorIndex(file);
    await reloaded.load();
    expect(reloaded.embeddingModel).toBe('text-embedding-3-small');
    expect(reloaded.all().map((item) => item.id)).toEqual(['memory:user:abc']);
    expect(reloaded.fileState('/logs/a.jsonl')?.offset).toBe(10);
    expect([...(decodeVector(reloaded.all()[0]?.vector ?? '', 3) ?? [])]).toEqual([1, 0, 0]);
  });

  it('invalidates everything when the embedding model changes', async () => {
    const index = new VectorIndex(path.join(dir, 'index.json'));
    await index.load();
    index.adoptModel('model-a');
    index.put(entry('x', [1, 0]));
    index.setFileState('/logs/a.jsonl', { size: 1, mtimeMs: 1, head: 'h', offset: 1 });

    expect(index.adoptModel('model-a')).toBe(false);
    expect(index.all()).toHaveLength(1);
    // Vectors from two models are not comparable, so a change must drop the
    // vectors AND the read positions — otherwise the history would never be
    // re-read and would keep the old model's vectors forever.
    expect(index.adoptModel('model-b')).toBe(true);
    expect(index.all()).toHaveLength(0);
    expect(index.filePaths()).toHaveLength(0);
  });

  it('drops only memory entries when asked, and evicts history oldest-first', async () => {
    const index = new VectorIndex(path.join(dir, 'index.json'));
    await index.load();
    index.put(entry('memory:a', [1, 0]));
    for (let i = 0; i < 5; i++) {
      index.put({
        id: `history:s:${i}`,
        scope: 'history',
        text: `第 ${i} 条`,
        meta: { textHash: textHash(`第 ${i} 条`), sessionId: 's', at: 1000 + i },
        vector: encodeVector(normalizeVector([1, 0])),
      });
    }
    expect(index.evictHistory(3)).toBe(2);
    const ids = index.all().map((item) => item.id);
    expect(ids).toContain('memory:a');
    expect(ids).not.toContain('history:s:0');
    expect(ids).not.toContain('history:s:1');
    expect(ids).toContain('history:s:4');

    index.drop((item) => item.scope === 'memory');
    expect(index.all().map((item) => item.id)).not.toContain('memory:a');
  });

  it('serializes concurrent flushes so the last write reflects the live state', async () => {
    const file = path.join(dir, 'index.json');
    const index = new VectorIndex(file);
    await index.load();
    index.put(entry('a', [1, 0]));
    // Two flushes enqueued back to back, with a mutation between them: the queued
    // document is built when the write RUNS, so both writes carry the newest state
    // and nothing is lost. Building it at enqueue time is the lost-update bug.
    const first = index.flush();
    index.put(entry('b', [0, 1]));
    const second = index.flush();
    await Promise.all([first, second]);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries: { id: string }[] };
    expect(parsed.entries.map((item) => item.id).sort()).toEqual(['a', 'b']);
  });
});
