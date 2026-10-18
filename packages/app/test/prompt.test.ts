/**
 * 人格提示词的装配：谁被换掉、谁永远在场。
 *
 * 这里钉住的是一条真实的故障（2026-10-17）：系统提示词写着 `You are Noa`，模型仍然
 * 自称 Nova——它顺着会话转录里自己以前的口气说下去。所以「旧名字是旧的」这条必须
 * 与人格分开、永远在场，包括操作者写了 `SOUL.md` 之后。
 */
import { describe, expect, it } from 'vitest';
import { INTERJECTION_LABEL, INTERJECTION_OPEN } from '@noa/core';
import {
  buildNoaSystemPrompt,
  NOA_HISTORY_NOTE,
  NOA_IDENTITY,
  NOA_TOOLS,
  QQ_CHANNEL_HINT,
} from '../src/prompt.js';

describe('buildNoaSystemPrompt', () => {
  it('leads with the built-in identity and keeps the stale-name note next to it', () => {
    const prompt = buildNoaSystemPrompt();
    expect(prompt.startsWith(NOA_IDENTITY)).toBe(true);
    expect(prompt).toContain(NOA_HISTORY_NOTE);
    expect(prompt).toContain(QQ_CHANNEL_HINT);
  });

  it('treats a blank SOUL.md as no override', () => {
    expect(buildNoaSystemPrompt('   \n')).toBe(buildNoaSystemPrompt());
  });

  it('names only unconditionally-registered tools as available', () => {
    // 实测（2026-10-18）：提示词把 run_code / subagent / skill / switch_workspace 与
    // 内置工具并列，模型据此告诉用户它能跑 TypeScript、能派子代理，然后四个调用全部
    // 返回 unknown tool——而它一开始还宣称这些工具可用。底部一句「名单不是承诺」挡不住
    // 一个正在扫能力的模型，所以「可用」与「可能有」在文本上就必须分开。
    const marker = 'MAY also carry';
    const at = NOA_TOOLS.indexOf(marker);
    expect(at).toBeGreaterThan(0);
    const available = NOA_TOOLS.slice(0, at);
    const conditional = NOA_TOOLS.slice(at);

    // 条件注册的：只能在第二节出现。
    for (const name of ['run_code', 'subagent', 'skill', 'switch_workspace', 'memory', 'recall', 'create_goal', 'update_goal']) {
      expect(conditional).toContain(name);
      expect(available).not.toContain(name);
    }
    // 无条件注册的：第一节必须点名，否则模型不知道该优先用哪个。
    for (const name of ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', 'bash', 'jobs', 'todo_write', 'web_fetch', 'web_search', 'ask_user_question']) {
      expect(available).toContain(name);
    }
    // 工具表本身被声明为权威，unknown tool 被声明为「这就是答案」。
    expect(NOA_TOOLS).toContain('IS this deployment');
    expect(NOA_TOOLS).toContain('unknown tool is that answer');
  });

  it('lets a soul replace the identity without dropping the stale-name note', () => {
    // 换人格不会让老日志里的旧名字消失——这条讲的是老日志，不是人格。
    const prompt = buildNoaSystemPrompt('You are 小助手, a cat.');
    expect(prompt.startsWith('You are 小助手, a cat.')).toBe(true);
    expect(prompt).not.toContain('You are Noa');
    expect(prompt).toContain(NOA_HISTORY_NOTE);
  });

  it('names the mid-run marker the kernel actually writes', () => {
    // 通道事实与内核机制必须在文本上对齐：提示词里说的那个标记，就是
    // `@noa/core` 的 `formatInterjection` 真正写进消息的那个。两边各写一遍、各自演化，
    // 就会出现「模型在等一个永远不会出现的标记」——而那种失配没有任何运行时报错。
    // 提示词引的是标签（`[LABEL]` / `[/LABEL]`），开标记里还跟着一句说明，所以这里
    // 断言的是标签，不是整句。
    const prompt = buildNoaSystemPrompt();
    expect(prompt).toContain(`[${INTERJECTION_LABEL}]`);
    expect(prompt).toContain(`[/${INTERJECTION_LABEL}]`);
    // 内核写出来的那一份必须真的以这个标签开头，否则上面两条只是自己跟自己对齐。
    expect(INTERJECTION_OPEN.startsWith(`[${INTERJECTION_LABEL}`)).toBe(true);
  });
});
