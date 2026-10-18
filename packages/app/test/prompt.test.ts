/**
 * 人格提示词的装配：谁被换掉、谁永远在场。
 *
 * 这里钉住的是一条真实的故障（2026-10-17）：系统提示词写着 `You are Noa`，模型仍然
 * 自称 Nova——它顺着会话转录里自己以前的口气说下去。所以「旧名字是旧的」这条必须
 * 与人格分开、永远在场，包括操作者写了 `SOUL.md` 之后。
 */
import { describe, expect, it } from 'vitest';
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

  it('says the tool list is not a promise about this deployment', () => {
    // 工具名来自可选插件（advanced 档，配置没开就不加载）。不说清这一点，模型会去调
    // 一个不存在的工具，拿到一句 unknown tool，然后自己编解释——实测它对用户说
    // 「这个环境里记忆检索功能不可用」，而那只是那台机器没启用那个插件。
    expect(NOA_TOOLS).toContain('not a promise about THIS deployment');
    expect(NOA_TOOLS).toContain('names the tools you really have');
  });

  it('lets a soul replace the identity without dropping the stale-name note', () => {
    // 换人格不会让老日志里的旧名字消失——这条讲的是老日志，不是人格。
    const prompt = buildNoaSystemPrompt('You are 小助手, a cat.');
    expect(prompt.startsWith('You are 小助手, a cat.')).toBe(true);
    expect(prompt).not.toContain('You are Noa');
    expect(prompt).toContain(NOA_HISTORY_NOTE);
  });
});
