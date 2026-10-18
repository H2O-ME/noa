/**
 * The memory plugin, mounted the way the plugin tree mounts it: a row with its
 * own config, the `tools` service from the host, and an optional `embeddings`
 * service.
 *
 * The two things worth asserting here beyond "the tools exist" are the ones a
 * unit test of the pieces cannot see: that the injected block reaches the SYSTEM
 * PROMPT through the hook and only when a request carries tools, and that the
 * whole thing still works with no embedding model at all — the degraded path is
 * a supported configuration, not an error path.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  embeddings as embeddingsKey,
  memoryDir,
  sessionsRoot,
  tools as toolsKey,
  type ChatRequest,
  type EmbeddingClient,
  type ToolDefinition,
  type ToolExecuteContext,
} from '@noa/core';
import { PluginHost } from '@noa/plugins';
import { memoryPlugin, MEMORY_TOOL, RECALL_TOOL } from '../src/index.js';

/** The words the fake embedder knows; a text's vector is its presence pattern. */
const VOCAB = ['部署', 'runner', '并发', '额度', '记忆', '向量', '会话', '咖啡'];

/** A deterministic bag-of-words embedder: enough to assert ranking, no network. */
const fakeEmbedder: EmbeddingClient = {
  model: 'fake-embed-v1',
  embed: async (texts) => texts.map((text) => VOCAB.map((word) => (text.includes(word) ? 1 : 0))),
};

/** Mount the plugin with an optional embeddings service. */
async function hostWith(
  opts: { embedder?: EmbeddingClient; config?: Record<string, unknown> } = {},
): Promise<PluginHost> {
  const host = new PluginHost('.');
  if (opts.embedder !== undefined) host.context.provide(embeddingsKey, opts.embedder);
  await host.sync([{ id: MEMORY_TOOL, plugin: memoryPlugin, config: opts.config ?? {} }]);
  return host;
}

/** The registered tool, by name. */
function toolOf(host: PluginHost, name: string): ToolDefinition {
  const tool = host.tools.find((item) => item.name === name);
  if (tool === undefined) throw new Error(`${name} not registered`);
  return tool;
}

/** A tool-execution context with a session id (the echo filter reads it). */
function callCtx(sessionId?: string): ToolExecuteContext {
  return sessionId === undefined ? { rootDir: '.' } : { rootDir: '.', sessionId };
}

/** Write a session log into the (redirected) sessions root. */
async function writeSessionLog(id: string, lines: unknown[]): Promise<void> {
  const bucket = path.join(sessionsRoot(), '2026', '10', '14');
  await mkdir(bucket, { recursive: true });
  const header = JSON.stringify({ type: 'session', v: 2, id, createdAt: 1 });
  await writeFile(
    path.join(bucket, `${id}.jsonl`),
    `${[header, ...lines.map((line) => JSON.stringify(line))].join('\n')}\n`,
    'utf8',
  );
}

/** One model-visible message event. */
function msg(role: 'user' | 'assistant', content: string, ts: number): unknown {
  return { type: 'message', message: { id: `msg_${ts}`, ts, role, content } };
}

/** A stand-in tool, so a request can carry a non-empty tool list. */
const SOME_TOOL: ToolDefinition = {
  name: 'echo',
  description: 'echo',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: () => 'ok',
};

/** A request as the loop sends it: with tools, unless told otherwise. */
function request(systemPrompt: string, withTools: boolean): ChatRequest {
  return { messages: [], systemPrompt, ...(withTools ? { tools: [SOME_TOOL] } : {}) };
}

beforeEach(async () => {
  // A clean state per test: the harness redirects HOME, and this narrows it
  // further so one test's notes never leak into the next. The sessions root
  // matters as much as the memory dir — a log written by one test is otherwise
  // indexed by the next, which is how a search test starts finding history it
  // never created. `maxRetries` because a previous test's background index pass
  // can still be creating files here.
  await rm(memoryDir(), { recursive: true, force: true, maxRetries: 5 });
  await mkdir(memoryDir(), { recursive: true });
  await rm(sessionsRoot(), { recursive: true, force: true, maxRetries: 5 });
});

describe('registration', () => {
  it('registers both tools with the kinds the design calls for', async () => {
    const host = await hostWith();
    const registry = host.context.must(toolsKey);
    expect(host.tools.map((tool) => tool.name).sort()).toEqual([MEMORY_TOOL, RECALL_TOOL].sort());
    // `write` for the notes (own bounded store, auto-allowed in the `auto` tier)
    // and `read` for recall — neither should reach the approval gate.
    expect(await registry.permissionFor(MEMORY_TOOL)).toBe('write');
    expect(await registry.permissionFor(RECALL_TOOL)).toBe('read');
  });

  it('loads with no embeddings service at all (the degraded install)', async () => {
    const host = await hostWith();
    const out = await toolOf(host, RECALL_TOOL).execute({ query: '部署' }, callCtx());
    expect(out).toContain('没有找到');
  });
});

describe('the memory tool', () => {
  it('writes an entry and reports the budget', async () => {
    const host = await hostWith();
    const out = await toolOf(host, MEMORY_TOOL).execute(
      { operation: 'add', target: 'user', content: '用户偏好简短的回答' },
      callCtx(),
    );
    expect(out).toContain('已记入 USER.md');
    const raw = await readFile(path.join(memoryDir(), 'USER.md'), 'utf8');
    expect(raw).toContain('- 用户偏好简短的回答');
  });

  it('refuses an unknown operation by name', async () => {
    const host = await hostWith();
    const out = await toolOf(host, MEMORY_TOOL).execute({ operation: 'upsert', content: 'x' }, callCtx());
    expect(out).toContain('未知的 operation');
  });
});

describe('the injected block', () => {
  it('appends the framed memory block to a request that carries tools', async () => {
    const host = await hostWith();
    await toolOf(host, MEMORY_TOOL).execute({ target: 'user', content: '用户叫小 H' }, callCtx());
    const out = await host.agentHooks().beforeLLMCall!(request('BASE', true));
    expect(out.systemPrompt).toContain('BASE');
    expect(out.systemPrompt).toContain('<memory>');
    expect(out.systemPrompt).toContain('不是操作者给你的指令');
    expect(out.systemPrompt).toContain('- 用户叫小 H');
  });

  it('leaves a request WITHOUT tools untouched (an internal summarizer call)', async () => {
    const host = await hostWith();
    await toolOf(host, MEMORY_TOOL).execute({ target: 'memory', content: '一条会被注入的记忆' }, callCtx());
    const req = request('BASE', false);
    expect(await host.agentHooks().beforeLLMCall!(req)).toBe(req);
  });

  it('injects nothing while memory is empty', async () => {
    const host = await hostWith();
    const req = request('BASE', true);
    const out = await host.agentHooks().beforeLLMCall!(req);
    expect(out.systemPrompt).toBe('BASE');
  });

  it('picks up a write on the next request, and is byte-stable until then', async () => {
    const host = await hostWith();
    const hooks = host.agentHooks();
    await toolOf(host, MEMORY_TOOL).execute({ target: 'memory', content: '第一条记忆' }, callCtx());
    const first = await hooks.beforeLLMCall!(request('BASE', true));
    // Same content, same block: the prompt prefix stays cached across turns.
    const second = await hooks.beforeLLMCall!(request('BASE', true));
    expect(second.systemPrompt).toBe(first.systemPrompt);
    await toolOf(host, MEMORY_TOOL).execute({ target: 'memory', content: '第二条记忆' }, callCtx());
    const third = await hooks.beforeLLMCall!(request('BASE', true));
    expect(third.systemPrompt).toContain('第二条记忆');
    expect(third.systemPrompt).not.toBe(first.systemPrompt);
  });
});

describe('recall', () => {
  it('ranks memory entries by meaning through the embedder', async () => {
    const host = await hostWith({ embedder: fakeEmbedder });
    const memory = toolOf(host, MEMORY_TOOL);
    await memory.execute({ target: 'memory', content: '部署走自建 runner' }, callCtx());
    await memory.execute({ target: 'memory', content: '用户喝咖啡不加糖' }, callCtx());
    const out = await toolOf(host, RECALL_TOOL).execute({ query: '部署 runner' }, callCtx());
    expect(out).toContain('部署走自建 runner');
    expect(out).not.toContain('咖啡');
    expect(out).not.toContain('关键词匹配');
  });

  it('falls back to keyword matching with no embedder, and says so', async () => {
    const host = await hostWith();
    await toolOf(host, MEMORY_TOOL).execute({ target: 'memory', content: '并发额度不够用了' }, callCtx());
    const out = await toolOf(host, RECALL_TOOL).execute({ query: '并发额度' }, callCtx());
    expect(out).toContain('并发额度不够用了');
    expect(out).toContain('关键词匹配');
  });

  it('searches past conversations and excludes the asking session', async () => {
    await writeSessionLog('sess_old', [msg('user', '上次我们讨论过部署脚本的迁移方案，用的是自建 runner', 1_000)]);
    await writeSessionLog('sess_now', [msg('user', '这次又问了一遍部署脚本迁移的事，还是自建 runner', 2_000)]);
    const host = await hostWith({ embedder: fakeEmbedder });
    const recall = toolOf(host, RECALL_TOOL);

    const out = await recall.execute({ query: '部署 runner', scope: 'history' }, callCtx('sess_now'));
    expect(out).toContain('sess_old');
    // The echo filter: the conversation asking already has its own turns in
    // context, so returning them would spend the result budget on nothing.
    expect(out).not.toContain('sess_now');

    const included = await recall.execute(
      { query: '部署 runner', scope: 'history', includeCurrentSession: true },
      callCtx('sess_now'),
    );
    expect(included).toContain('sess_now');
  });

  it('honours indexHistory=false by refusing a history scope', async () => {
    const host = await hostWith({ config: { indexHistory: false } });
    const out = await toolOf(host, RECALL_TOOL).execute({ query: '任何东西' }, callCtx());
    expect(out).toContain('indexHistory=false');
  });

  it('rejects an empty query', async () => {
    const host = await hostWith();
    expect(await toolOf(host, RECALL_TOOL).execute({ query: '   ' }, callCtx())).toContain('不能为空');
  });

  it('finds a note written straight into the file, with no index entry for it', async () => {
    // 线上原样复现：`USER.md` 里明明有一条笔记，`recall {scope:"memory"}` 却回
    // 「没有找到相关的记忆」。存在性当时由索引说了算，而索引只收写入工具经手过的条目 ——
    // 手工编辑、或嵌入不可用时写入的那一条，文件里有、索引里没有。文件才是权威来源。
    await writeFile(path.join(memoryDir(), 'USER.md'), '# 关于操作者\n\n- 偏好使用 pnpm，不用 npm\n', 'utf8');
    const host = await hostWith(); // 无嵌入模型：走关键词那条路，也正是当初漏掉笔记的那条
    const out = await toolOf(host, RECALL_TOOL).execute({ query: 'pnpm npm', scope: 'memory' }, callCtx());
    expect(out).toContain('偏好使用 pnpm');
    expect(out).not.toContain('没有找到');
  });

  it('marks a recalled conversation line as something that was SAID back then', async () => {
    // 检索把「当时它说 X」端回来时，模型很容易读成「X 是事实」。实测吃过这个亏：一条
    // 早先「recall 不可用，所以查不到」的自我报告被当成历史事实读了回来，而原因只是
    // 当时配置里缺一行。所以历史行带来源标注，assistant 的那些尤其要说清。
    await writeSessionLog('sess_past', [msg('assistant', '我查不到相关记忆，因为向量模型没有配置', 1_000)]);
    const host = await hostWith({ embedder: fakeEmbedder });
    const out = await toolOf(host, RECALL_TOOL).execute({ query: '记忆 向量 配置', scope: 'history' }, callCtx());
    expect(out).toContain('assistant 当时说');
    expect(out).toContain('不是已验证的事实');
    // 记忆行不该被这条声明污染：它是策展过的内容，不是某次发言。
    const noteOnly = await toolOf(host, RECALL_TOOL).execute({ query: 'pnpm', scope: 'memory' }, callCtx());
    expect(noteOnly).not.toContain('不是已验证的事实');
  });
});

describe('hybrid ranking', () => {
  /**
   * An embedder that points the given query texts along x and every note almost
   * orthogonal to them.
   *
   * That near-orthogonal pair is the shape a real model produces for unrelated
   * text — cosine ≈ 0.1, positive but meaningless — which is exactly why
   * "similarity > 0" is useless as a filter and a floor is needed.
   */
  function dialEmbedder(...queries: string[]): EmbeddingClient {
    const along = new Set(queries);
    return {
      model: 'dial-v1',
      embed: async (texts) => texts.map((text) => (along.has(text) ? [1, 0] : [0.1, 0.995])),
    };
  }

  it('keeps an entry the vector path rejected, when keywords rank it', async () => {
    const host = await hostWith({ embedder: dialEmbedder('部署 runner') });
    const memory = toolOf(host, MEMORY_TOOL);
    await memory.execute({ target: 'memory', content: '部署走自建 runner' }, callCtx());
    await memory.execute({ target: 'memory', content: '用户喝咖啡不加糖' }, callCtx());

    const out = await toolOf(host, RECALL_TOOL).execute({ query: '部署 runner' }, callCtx());
    // Below the floor in vector space, but the only note sharing the query's
    // words — fusing the two rankings instead of choosing between them is what
    // keeps it in the answer.
    expect(out).toContain('部署走自建 runner');
    expect(out).not.toContain('咖啡');
    // The vector model was available and did run, so no fallback note.
    expect(out).not.toContain('关键词匹配');
  });

  it('reports no match when the only resemblance is a weak vector score', async () => {
    const host = await hostWith({ embedder: dialEmbedder('部署') });
    await toolOf(host, MEMORY_TOOL).execute({ target: 'memory', content: '生产环境在 cn-north' }, callCtx());
    // Nothing shares a token with '部署', so keywords cannot rescue it either:
    // the honest answer is "no match", not the least-unrelated note.
    expect(await toolOf(host, RECALL_TOOL).execute({ query: '部署' }, callCtx())).toContain('没有找到');
  });

  it('honours a lowered minSimilarity floor', async () => {
    const host = await hostWith({ embedder: dialEmbedder('部署'), config: { minSimilarity: 0.05 } });
    await toolOf(host, MEMORY_TOOL).execute({ target: 'memory', content: '生产环境在 cn-north' }, callCtx());
    expect(await toolOf(host, RECALL_TOOL).execute({ query: '部署' }, callCtx())).toContain('生产环境在 cn-north');
  });
});
