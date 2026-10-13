/**
 * 遥控指令的纯解析器（`src/remote-parse.ts`）。
 *
 * 这是整个遥控面的**唯一语法来源**：QQ 那边输入的是文本，所以「这句话是指令还是普通
 * 提示词」必须能被穷举。纪律与前端斜杠菜单一致——**认不得的原样当提示词**，因为把
 * 操作者的话悄悄吞掉是比「没听懂」严重得多的失败。
 */
import { describe, expect, it } from 'vitest';
import { parseRemoteCommand } from '../src/remote-parse.js';

/** 这条输入被认成了什么指令（不是指令则返回「prompt」）。 */
function kindOf(text: string): string {
  const parsed = parseRemoteCommand(text);
  return parsed.command?.kind ?? 'prompt';
}

describe('remote command parsing', () => {
  it('reads each documented command, with its argument', () => {
    expect(parseRemoteCommand('/perm full')).toEqual({ command: { kind: 'perm', mode: 'full' } });
    expect(parseRemoteCommand('/model deepseek-v4-flash')).toEqual({
      command: { kind: 'model', model: 'deepseek-v4-flash' },
    });
    expect(parseRemoteCommand('/ws D:/work')).toEqual({ command: { kind: 'workspace', dir: 'D:/work' } });
    expect(parseRemoteCommand('/new')).toEqual({ command: { kind: 'new' } });
    expect(parseRemoteCommand('/status')).toEqual({ command: { kind: 'status' } });
    expect(parseRemoteCommand('/help')).toEqual({ command: { kind: 'help' } });
    expect(parseRemoteCommand('/approve')).toEqual({ command: { kind: 'approve', allow: true } });
    expect(parseRemoteCommand('/deny')).toEqual({ command: { kind: 'approve', allow: false } });
  });

  it('sends every unrecognized line through as a prompt, verbatim', () => {
    // The load-bearing rule: a typo, an unknown slash name, or an ordinary
    // question must all reach the agent as the text the operator actually wrote.
    // The verbatim part matters — trimming is how the parser reads a command, not
    // something it may do to the operator's prompt.
    //
    // `/compact` is in this list on purpose: this parser declines names it does
    // not own, and the CALLER resolves them against the kernel's live catalog
    // (`PeerTurns.run`). Deciding it here would mean a hardcoded copy of the
    // catalog that drifts the moment a plugin is switched on or off.
    for (const text of ['帮我看看这个 bug', '/compact', '/Perm full', '/modelx', '  /unknown stuff  ']) {
      expect(parseRemoteCommand(text)).toEqual({ text });
    }
  });

  it('asks the question instead of failing when a command needs an argument', () => {
    // `/model` with nothing after it is a reasonable "which ones are there?", not
    // an error: the peer cannot guess an id and needs the list to pick from.
    expect(kindOf('/model')).toBe('models');
    // `/ws` with nothing reports where the workspace IS (a status read) rather
    // than guessing a path — the kernel is the only thing that can validate one.
    expect(kindOf('/ws')).toBe('status');
  });

  it('refuses a bogus permission tier as a prompt rather than a silent no-op', () => {
    // `/perm root` must not be accepted-and-ignored: the peer's line becomes a
    // prompt, which at least produces a visible answer.
    expect(parseRemoteCommand('/perm root')).toEqual({ text: '/perm root' });
    expect(parseRemoteCommand('/perm')).toEqual({ text: '/perm' });
  });

  it('reads a command with trailing spaces and an inline argument', () => {
    // A phone keyboard appends spaces; an argument may contain spaces (a path).
    expect(parseRemoteCommand('  /perm   auto-edit  ')).toEqual({ command: { kind: 'perm', mode: 'auto-edit' } });
    expect(parseRemoteCommand('/ws C:/Program Files/x')).toEqual({
      command: { kind: 'workspace', dir: 'C:/Program Files/x' },
    });
  });
});
