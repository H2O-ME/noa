/**
 * The curated store: markdown parsing, the single-line invariant, budgets and
 * the unique-substring matching that `patch`/`remove` depend on.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  entriesChars,
  MemoryStore,
  MEMORY_FILES,
  normalizeEntry,
  parseEntries,
  renderEntries,
} from '../src/store.js';

let dir: string;
let store: MemoryStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noa-memory-store-'));
  store = new MemoryStore(dir, { memory: 200, user: 100 });
});

describe('normalizeEntry', () => {
  it('collapses multi-line content into one physical line', () => {
    expect(normalizeEntry('第一行\n第二行')).toBe('第一行; 第二行');
    expect(normalizeEntry('a\r\nb\n\nc')).toBe('a; b; c');
  });

  it('drops a bullet the model wrote itself, including after a break', () => {
    expect(normalizeEntry('- 已经带前缀')).toBe('已经带前缀');
    expect(normalizeEntry('* 星号\n- 换行后的前缀')).toBe('星号; 换行后的前缀');
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeEntry('  a   b\t\tc  ')).toBe('a b c');
  });

  it('is idempotent — what parse produces normalizes to itself', () => {
    const once = normalizeEntry('x\n- y');
    expect(normalizeEntry(once)).toBe(once);
  });
});

describe('parseEntries / renderEntries', () => {
  it('reads bullets, ignores headings, blank lines and prose', () => {
    const text = ['# 标题', '', '- 第一条', 'note: 不是条目', '- 第二条', ''].join('\n');
    expect(parseEntries(text)).toEqual(['第一条', '第二条']);
  });

  it('round-trips through render', () => {
    const entries = ['甲', '乙; 丙'];
    expect(parseEntries(renderEntries('memory', entries))).toEqual(entries);
  });

  it('renders an empty store as a header and nothing else', () => {
    expect(parseEntries(renderEntries('user', []))).toEqual([]);
  });
});

describe('add', () => {
  it('writes one bullet and reports the budget', async () => {
    const result = await store.add('user', '用户喜欢简短的回答');
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`${entriesChars(['用户喜欢简短的回答'])}/100`);
    expect(await store.load('user')).toEqual(['用户喜欢简短的回答']);
    const raw = await readFile(store.fileFor('user'), 'utf8');
    expect(raw.startsWith('# 关于操作者')).toBe(true);
  });

  it('keeps a multi-line note on ONE line in the file', async () => {
    await store.add('memory', '步骤一\n步骤二\n步骤三');
    const raw = await readFile(store.fileFor('memory'), 'utf8');
    const bullets = raw.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets).toEqual(['- 步骤一; 步骤二; 步骤三']);
    expect(await store.load('memory')).toEqual(['步骤一; 步骤二; 步骤三']);
  });

  it('treats an exact repeat as a no-op rather than a second copy', async () => {
    await store.add('memory', '同一个事实');
    const again = await store.add('memory', '- 同一个事实');
    expect(again.ok).toBe(true);
    expect(again.message).toContain('已经');
    expect(await store.load('memory')).toHaveLength(1);
  });

  it('refuses an entry that would exceed the budget and leaves the file alone', async () => {
    await store.add('user', 'a'.repeat(90));
    const before = await readFile(store.fileFor('user'), 'utf8');
    const result = await store.add('user', 'b'.repeat(50));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('放不下');
    expect(result.message).toContain('100');
    expect(await readFile(store.fileFor('user'), 'utf8')).toBe(before);
  });

  it('refuses empty content', async () => {
    const result = await store.add('memory', '   \n  ');
    expect(result.ok).toBe(false);
  });
});

describe('patch / remove', () => {
  beforeEach(async () => {
    await store.add('memory', '部署走 GitHub Actions');
    await store.add('memory', '部署环境在 cn-north');
  });

  it('replaces the one entry containing the substring', async () => {
    const result = await store.patch('memory', 'GitHub Actions', '部署走自建 runner');
    expect(result.ok).toBe(true);
    expect(await store.load('memory')).toEqual(['部署走自建 runner', '部署环境在 cn-north']);
  });

  it('refuses an ambiguous substring instead of guessing', async () => {
    const result = await store.patch('memory', '部署', '别的');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('唯一');
    expect(await store.load('memory')).toEqual(['部署走 GitHub Actions', '部署环境在 cn-north']);
  });

  it('reports a substring that matches nothing', async () => {
    const result = await store.remove('memory', '不存在的东西');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('没有包含');
  });

  it('deletes the matching entry', async () => {
    const result = await store.remove('memory', 'cn-north');
    expect(result.ok).toBe(true);
    expect(await store.load('memory')).toEqual(['部署走 GitHub Actions']);
  });

  it('refuses a patch whose replacement would exceed the budget', async () => {
    const result = await store.patch('memory', 'cn-north', 'x'.repeat(300));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('超过上限');
  });
});

describe('tolerance', () => {
  it('reads a missing file as an empty store', async () => {
    expect(await store.load('memory')).toEqual([]);
  });

  it('skips a corrupt line without losing the rest', async () => {
    await writeFile(
      path.join(dir, MEMORY_FILES.memory),
      ['- 好的条目', '这是没有前缀的一行', '- 另一个', ''].join('\n'),
      'utf8',
    );
    expect(await store.load('memory')).toEqual(['好的条目', '另一个']);
  });
});

describe('stamp', () => {
  it('changes when a file changes and not otherwise', async () => {
    const before = await store.stamp();
    expect(await store.stamp()).toBe(before);
    await store.add('memory', '新的一条');
    expect(await store.stamp()).not.toBe(before);
  });
});
