/**
 * 推理标签的剥离（`agent/think.ts`）。
 *
 * 这套东西存在的原因是一个实测事实：同一台网关上，`MiMo-V2.6-Flash` 把思考**当作
 * `content` 流出来**（一个 think 块，然后才是正文），而 `DeepSeek-V4-Flash` 把它放进
 * `reasoning_content`、`content` 是干净的。内核把 `content` 累加成 assistant 消息，
 * 所以不剥的话，机器人回给用户的就是自己的草稿纸。
 *
 * 断言围着两件容易做错的事：
 *  - **跨 delta 的标签**。逐 delta 跑正则会把单独到达的开标记吃掉、却留下块内的文字，
 *    于是推理泄漏、正文还残缺。所以必须按状态机把半个标签扣住。
 *  - **别剥过头**。正文里提到标签名是在讨论它，不是在思考。
 *
 * 标签一律从导出常量拼出来，不在源码里写死：字面量是**这份实现要处理的输入**，写死
 * 等于让测试和实现共用同一个可能写错的假设。
 */
import { describe, expect, it } from 'vitest';
import {
  StreamingThinkScrubber,
  THINK_CLOSE_TAGS,
  THINK_OPEN_TAGS,
  stripThinkBlocks,
  runAgent,
  type AgentMessage,
  type ToolDefinition,
} from '../src/index.js';
import { collect, scriptedProvider } from './helpers/scripted-provider.js';

/** Tag order follows `THINK_TAG_NAMES`: think, thinking, reasoning, … 推理. */
const [OPEN_THINK, OPEN_THINKING, OPEN_REASONING] = THINK_OPEN_TAGS as [string, string, string];
const [CLOSE_THINK, CLOSE_THINKING, CLOSE_REASONING] = THINK_CLOSE_TAGS as [string, string, string];
const OPEN_CN = THINK_OPEN_TAGS[7]!;
const CLOSE_CN = THINK_CLOSE_TAGS[7]!;

/** Feed `text` one character at a time — the worst-case delta split. */
function feedByChar(text: string): string {
  const scrubber = new StreamingThinkScrubber();
  let out = '';
  for (const ch of text) out += scrubber.feed(ch);
  return out + scrubber.flush();
}

describe('stripThinkBlocks', () => {
  it('removes a leading reasoning block and keeps the answer', () => {
    expect(stripThinkBlocks(`${OPEN_THINK}\n用户要求我…\n${CLOSE_THINK}\n我是 Noa。`)).toBe('\n我是 Noa。');
  });

  it('removes a closed pair wherever it sits', () => {
    // 内联的闭合对一律删掉：那几乎总是漏出来的推理。
    expect(stripThinkBlocks(`答案是 ${OPEN_THINKING}想想${CLOSE_THINKING}42`)).toBe('答案是 42');
  });

  it('removes an orphan close tag', () => {
    // 上游丢掉了开标记，只剩一个孤零零的闭合标签——留着只会出现在用户眼前。
    expect(stripThinkBlocks(`答完了。\n${CLOSE_THINKING}\n`)).toBe('答完了。\n');
  });

  it('leaves prose that merely mentions a tag alone', () => {
    // 只有行首/块首的开标记才算块的开头。句中提到它是在讨论它。
    const prose = `它的输出以 ${OPEN_THINK} 开头，这是我们剥掉的东西`;
    expect(stripThinkBlocks(prose)).toBe(prose);
  });

  it('covers the Chinese tag names too', () => {
    expect(stripThinkBlocks(`${OPEN_CN}想${CLOSE_CN}答案`)).toBe('答案');
  });

  it('is case-insensitive', () => {
    expect(stripThinkBlocks(`${OPEN_REASONING.toUpperCase()}想${CLOSE_REASONING.toUpperCase()}答案`)).toBe('答案');
  });

  it('passes ordinary text through untouched', () => {
    const plain = '就是一句普通话。\n第二行。';
    expect(stripThinkBlocks(plain)).toBe(plain);
  });
});

describe('StreamingThinkScrubber', () => {
  it('hides a block whose tags are split across deltas', () => {
    // 这是逐 delta 正则做错的那一件事：开标记分两次到达。
    const scrubber = new StreamingThinkScrubber();
    let out = '';
    out += scrubber.feed(OPEN_THINK.slice(0, 4));
    out += scrubber.feed(`${OPEN_THINK.slice(4)}想`);
    out += scrubber.feed(`一下${CLOSE_THINK.slice(0, 5)}`);
    out += scrubber.feed(CLOSE_THINK.slice(5));
    out += scrubber.feed('\n答案');
    out += scrubber.flush();
    expect(out).toBe('\n答案');
  });

  it('survives one character at a time', () => {
    const text = `前言\n${OPEN_THINK}推理过程\n需要很多字才像样\n${CLOSE_THINK}\n正文`;
    expect(feedByChar(text)).toBe('前言\n\n正文');
  });

  it('releases text that only looked like the start of a tag', () => {
    // 扣住的半个标签最终不是标签时，必须原样放出来——否则正文会少一截。
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('温度 <t')).toBe('温度 ');
    // 扣住的那半个标签随下一段一起放出来，一个字都不少。
    expect(scrubber.feed('est 通过')).toBe('<test 通过');
    expect(scrubber.flush()).toBe('');
  });

  it('discards an unterminated block rather than leaking half of it', () => {
    // 流断在块里：泄漏半个草稿纸比少一段答案更糟，所以尾部丢掉。
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('答案在前面')).toBe('答案在前面');
    expect(scrubber.feed(`\n${OPEN_THINK}没写完的推理`)).toBe('\n');
    expect(scrubber.flush()).toBe('');
  });

  it('starts a fresh stream after reset', () => {
    // 一次 reset 之后是**新的一次尝试**：它的开标记在流首，仍然是块边界。
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('第一段的答案')).toBe('第一段的答案');
    scrubber.reset();
    expect(scrubber.feed(`${OPEN_THINK}重来的推理`)).toBe('');
    expect(scrubber.feed(`${CLOSE_THINK}重来的答案`)).toBe('重来的答案');
  });

  it('flushes held-back prose without a reset, and can then stream again', () => {
    // 同一次尝试里的重放（provider 的 reset 事件之外）不会调用 reset()：flush 之后
    // 边界标志必须已经复位，否则新流的开标记会被当成行中间。
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('半句 <t')).toBe('半句 ');
    expect(scrubber.flush()).toBe('<t');
    expect(scrubber.feed(`${OPEN_THINK}想`)).toBe('');
    expect(scrubber.feed(`${CLOSE_THINK}答案`)).toBe('答案');
  });

  it('emits nothing for a delta that is entirely reasoning', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed(`思考\n${OPEN_THINK}想`)).toBe('思考\n');
    expect(scrubber.feed('推理推理推理')).toBe('');
    expect(scrubber.feed(CLOSE_THINK)).toBe('');
  });
});

describe('真实轮次的形状（线上日志里量出来的）', () => {
  /**
   * 一台网关上量到的事实：`MiMo-V2.6-Flash` 的 8 条消息里有 7 条是「思考 + 调工具」，
   * 而且那 7 条的思考**根本没有闭合标签**——模型想着想着直接去调工具了。所以「未闭合的
   * 块尾部丢掉」这条规则，在真实流量里就是「这一轮的文本本来就是草稿纸，一条都不该给
   * 用户」。这一条把它钉住：文本变空，但工具调用必须照旧跑完。
   */
  it('一个整轮都是未闭合思考的工具轮：文本为空，工具照跑', async () => {
    const tool: ToolDefinition = {
      name: 'probe',
      description: 'test fixture',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => 'probe-ok',
    };
    const provider = scriptedProvider([
      [
        { type: 'text_delta', text: `${OPEN_THINK}\nLet me check the prerequisites first.` },
        { type: 'tool_call_delta', index: 0, id: 'c1', name: 'probe', argsDelta: '{}' },
        { type: 'finish', finishReason: 'tool_calls' },
      ],
      [{ type: 'text_delta', text: '查完了。' }, { type: 'finish', finishReason: 'stop' }],
    ]);
    const messages: AgentMessage[] = [];
    const events = await collect(runAgent({ provider, messages, rootDir: '.', tools: [tool] }));

    const assistants = messages.filter((m) => m.role === 'assistant');
    // 第一轮：草稿纸一个字都不留，但调用还在——空文本 + 有调用，所以也**不该**被当成
    // 「空补全」去重试（重试会把已经跑过的工具再跑一遍）。
    expect(assistants[0]?.content).toBe('');
    expect(assistants[0]?.toolCalls).toHaveLength(1);
    expect(events.some((e) => e.type === 'empty_completion')).toBe(false);
    // 工具真的跑了，第二轮拿到了干净的回答。
    expect(messages.find((m) => m.role === 'tool')?.content).toBe('probe-ok');
    expect(assistants[1]?.content).toBe('查完了。');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // 会话里不该再有任何一段带标签的文本。
    for (const m of messages) {
      if (typeof m.content === 'string') expect(m.content).not.toMatch(/<think/i);
    }
  });

  it('收尾轮：块内推理丢掉，块后的回答原样留下', async () => {
    const provider = scriptedProvider([
      [
        { type: 'text_delta', text: `${OPEN_THINK}\nThe user wants a short answer.\n${CLOSE_THINK}\n\n` },
        { type: 'text_delta', text: '清理已排程，40 秒后重启。' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const messages: AgentMessage[] = [];
    await collect(runAgent({ provider, messages, rootDir: '.' }));

    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('\n\n清理已排程，40 秒后重启。');
  });
});
