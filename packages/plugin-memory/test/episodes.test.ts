/**
 * The episode reader: which events become chunks, and the three guards that
 * invalidate a saved byte offset.
 *
 * The offsets are the part worth testing hard. A stale offset either starts mid
 * JSON (every line fails to parse, silently indexing nothing) or skips records
 * that were moved by a rewrite — and both failures are invisible in production
 * because the index simply gets quietly thinner.
 */
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  episodeId,
  scanSessionFile,
  sessionFilesNewestFirst,
  type EpisodeChunk,
} from '../src/episodes.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'noa-memory-log-'));
});

/** One session log: the header line, then the events. */
function logText(id: string, events: unknown[]): string {
  const header = JSON.stringify({ type: 'session', v: 2, id, createdAt: 1 });
  return `${[header, ...events.map((event) => JSON.stringify(event))].join('\n')}\n`;
}

/** A model-visible message event. */
function msg(role: 'user' | 'assistant' | 'tool', content: string, ts: number): unknown {
  return { type: 'message', message: { id: `msg_${ts}`, ts, role, content } };
}

/** Write a log and return its path. */
async function writeLog(id: string, events: unknown[]): Promise<string> {
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, logText(id, events), 'utf8');
  return file;
}

/** The chunk texts, for concise assertions. */
function texts(chunks: readonly EpisodeChunk[]): string[] {
  return chunks.map((chunk) => chunk.text);
}

describe('what gets indexed', () => {
  it('keeps user and assistant prose, drops tool results and short noise', async () => {
    const file = await writeLog('sess_a', [
      msg('user', '我们上周把部署脚本迁移到了自建 runner，原因是什么来着', 100),
      msg('assistant', '因为 GitHub Actions 的并发额度不够用了', 200),
      msg('tool', 'total 40\ndrwxr-xr-x  1 user 197609 0 Sep 1 10:00 .', 300),
      msg('user', '好的', 400),
      msg('user', '/new', 500),
      msg('assistant', '收到', 600),
    ]);
    const scan = await scanSessionFile(file, undefined);
    expect(texts(scan?.chunks ?? [])).toEqual([
      '我们上周把部署脚本迁移到了自建 runner，原因是什么来着',
      '因为 GitHub Actions 的并发额度不够用了',
    ]);
    expect(scan?.chunks[0]?.role).toBe('user');
    expect(scan?.chunks[1]?.role).toBe('assistant');
  });

  it('indexes a compaction summary — the densest retrieval target in the file', async () => {
    const file = await writeLog('sess_b', [
      { type: 'compaction/start', trigger: 'auto', at: 10 },
      { type: 'compaction/summary', summary: '本次对话讨论了部署迁移与并发额度问题', keep: [], shadowedTokenCount: 10, at: 11 },
      { type: 'compaction/end', at: 12 },
      msg('user', '那接下来把 CI 也一起改了吧', 20),
    ]);
    const scan = await scanSessionFile(file, undefined);
    expect(scan?.chunks[0]?.role).toBe('summary');
    expect(scan?.chunks[0]?.text).toContain('部署迁移');
  });

  it('skips log-only events and corrupt lines without losing the rest', async () => {
    const file = path.join(dir, 'sess_c.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session', v: 2, id: 'sess_c', createdAt: 1 }),
        JSON.stringify(msg('user', '这一条要留下，因为它够长了', 1)),
        '{ this is not json',
        JSON.stringify({ type: 'todo/write', todos: [], at: 2 }),
        JSON.stringify(msg('user', '这一条也要留下，同样足够长', 3)),
        '',
      ].join('\n'),
      'utf8',
    );
    const scan = await scanSessionFile(file, undefined);
    expect(texts(scan?.chunks ?? [])).toEqual(['这一条要留下，因为它够长了', '这一条也要留下，同样足够长']);
  });

  it('ids a chunk by content and time, so a re-scan replaces rather than duplicates', async () => {
    const file = await writeLog('sess_d', [msg('user', '一条会被重新读到的消息，长度足够', 42)]);
    const first = await scanSessionFile(file, undefined);
    const second = await scanSessionFile(file, undefined);
    expect(second?.chunks[0]?.id).toBe(first?.chunks[0]?.id);
    expect(first?.chunks[0]?.id).toBe(episodeId('sess_d', '一条会被重新读到的消息，长度足够', 42));
  });

  it('never indexes the injected context fragment as something the operator said', async () => {
    // 线上真实事故：模型被问到「你对我有什么记忆」，答「从历史对话能看出你在 D:/web 工作、
    // 常用 EdgeOne Makers」。证据不是对话，是这条注入块里的技能清单 —— 它被当成用户说过的话
    // 索引了。索引的是**说过的话**，不是**运行环境**。
    const file = await writeLog('sess_ctx', [
      { type: 'message', message: { id: 'msg_ctx_1', ts: 1, role: 'user', content: '<environment>\ncwd=D:/web\n</environment>\n\n<available_skills>\n- edgeone-makers: 部署到 EdgeOne\n</available_skills>' } },
      msg('user', '这条才是我说的话，长度足够入索引', 2),
    ]);
    const scan = await scanSessionFile(file, undefined);
    expect(texts(scan?.chunks ?? [])).toEqual(['这条才是我说的话，长度足够入索引']);
  });

  it('skips an old fragment that carries a plain id, by its content', async () => {
    // 老日志里的片段 id 是普通 `msg_…`（`msg_ctx_` 前缀是后加的）。按内容兜底认，
    // 否则重建索引会把历史里的注入块重新收进来。
    const file = await writeLog('sess_old', [
      { type: 'message', message: { id: 'msg_9', ts: 1, role: 'user', content: '<environment>\nplatform=win32\n</environment>' } },
      msg('user', '同样这条才是我说的话，长度足够', 2),
    ]);
    const scan = await scanSessionFile(file, undefined);
    expect(texts(scan?.chunks ?? [])).toEqual(['同样这条才是我说的话，长度足够']);
  });

  it('keeps a real prompt that merely opens with a bracket', async () => {
    // 判定要结构性（id 前缀），不能退化成「以 < 开头就丢」：操作者完全可以自己打出
    // 一个带尖括号的提示，那是他的话，得留下。
    const file = await writeLog('sess_bracket', [
      msg('user', '<div> 这个标签为什么撑不满高度，帮我看看布局', 1),
    ]);
    const scan = await scanSessionFile(file, undefined);
    expect(texts(scan?.chunks ?? [])).toEqual(['<div> 这个标签为什么撑不满高度，帮我看看布局']);
  });
});

describe('incremental reading', () => {
  it('reads only the new bytes when the log has grown', async () => {
    const file = await writeLog('sess_e', [msg('user', '第一条消息，足够长可以入索引', 1)]);
    const first = await scanSessionFile(file, undefined);
    expect(first?.chunks).toHaveLength(1);
    const offset = first?.state.offset ?? 0;
    expect(offset).toBe((await stat(file)).size);

    await writeFile(
      file,
      logText('sess_e', [
        msg('user', '第一条消息，足够长可以入索引', 1),
        msg('assistant', '第二条消息，同样足够长可以入索引', 2),
      ]),
      'utf8',
    );
    const second = await scanSessionFile(file, first?.state);
    expect(second?.reset).toBe(false);
    expect(texts(second?.chunks ?? [])).toEqual(['第二条消息，同样足够长可以入索引']);
  });

  it('does nothing when there is nothing new', async () => {
    const file = await writeLog('sess_f', [msg('user', '唯一的一条消息，够长', 1)]);
    const first = await scanSessionFile(file, undefined);
    const again = await scanSessionFile(file, first?.state);
    expect(again?.chunks).toHaveLength(0);
    expect(again?.state.offset).toBe(first?.state.offset);
  });

  it('stops at a line boundary when the chunk budget runs out, losing nothing', async () => {
    const events = Array.from({ length: 6 }, (_, i) => msg('user', `第 ${i} 条消息，长度足够入索引`, i));
    const file = await writeLog('sess_g', events);
    const first = await scanSessionFile(file, undefined, { maxChunks: 2 });
    expect(first?.chunks).toHaveLength(2);
    // The position must sit on a boundary so the remainder can be read next time.
    // Byte offsets, not character offsets: the messages are multi-byte.
    const offset = first?.state.offset ?? 0;
    const raw = await readFile(file);
    expect(raw.subarray(0, offset).toString('utf8').endsWith('\n')).toBe(true);

    const second = await scanSessionFile(file, first?.state, { maxChunks: 10 });
    expect(texts([...(first?.chunks ?? []), ...(second?.chunks ?? [])])).toEqual(
      events.map((_, i) => `第 ${i} 条消息，长度足够入索引`),
    );
    expect(second?.reset).toBe(false);
  });
});

describe('offset invalidation', () => {
  it('resets when the file SHRANK (a repaired truncated tail)', async () => {
    const file = await writeLog('sess_h', [
      msg('user', '第一条消息，足够长可以入索引', 1),
      msg('user', '第二条消息，足够长可以入索引', 2),
    ]);
    const first = await scanSessionFile(file, undefined);
    // Cut the file back to the header plus one line: `size < offset` now holds.
    await writeFile(file, logText('sess_h', [msg('user', '第一条消息，足够长可以入索引', 1)]), 'utf8');
    const second = await scanSessionFile(file, first?.state);
    expect(second?.reset).toBe(true);
    expect(texts(second?.chunks ?? [])).toEqual(['第一条消息，足够长可以入索引']);
  });

  it('resets when the file was REPLACED at the same length (the header changed)', async () => {
    // Same byte length, different bytes: a size comparison sees nothing. A
    // v1→v2 upgrade rewrites a log exactly like this — the header's `v` changes
    // at an identical length — and trusting the old offset against the new file
    // would skip records that moved.
    const body = [msg('user', '一个够长的消息正文用于占位测试', 1)];
    const original = logText('sess_i1', body);
    const file = path.join(dir, 'sess_i1.jsonl');
    await writeFile(file, original, 'utf8');
    const first = await scanSessionFile(file, undefined);

    // A different id of the SAME length stands in for the changed header.
    const replaced = logText('sess_i2', body);
    expect(replaced.length).toBe(original.length);
    await writeFile(file, replaced, 'utf8');

    const second = await scanSessionFile(file, first?.state);
    expect(second?.reset).toBe(true);
    expect(texts(second?.chunks ?? [])).toEqual(['一个够长的消息正文用于占位测试']);
  });

  it('resets when the saved offset is not on a line boundary', async () => {
    const file = await writeLog('sess_j', [msg('user', '一条足够长的消息用于测试', 1)]);
    const first = await scanSessionFile(file, undefined);
    const state = first?.state;
    expect(state).toBeDefined();
    if (state === undefined) return;
    // A state whose offset lands inside the header line: reading from there would
    // start mid-JSON and every line would fail to parse.
    const second = await scanSessionFile(file, { ...state, offset: 5 });
    expect(second?.reset).toBe(true);
    expect(texts(second?.chunks ?? [])).toEqual(['一条足够长的消息用于测试']);
  });

  it('returns undefined for a log that cannot be read', async () => {
    expect(await scanSessionFile(path.join(dir, 'missing.jsonl'), undefined)).toBeUndefined();
  });
});

describe('sessionFilesNewestFirst', () => {
  it('walks the date buckets and orders by mtime, newest first', async () => {
    const bucket = path.join(dir, '2026', '10', '14');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(bucket, { recursive: true });
    await writeFile(path.join(bucket, 'old.jsonl'), logText('old', [msg('user', '旧的会话内容，足够长', 1)]), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(path.join(bucket, 'new.jsonl'), logText('new', [msg('user', '新的会话内容，足够长', 1)]), 'utf8');
    const files = await sessionFilesNewestFirst(dir);
    expect(files.map((entry) => path.basename(entry.file))).toEqual(['new.jsonl', 'old.jsonl']);
  });

  it('answers an empty list when the root does not exist', async () => {
    expect(await sessionFilesNewestFirst(path.join(dir, 'nope'))).toEqual([]);
  });
});
