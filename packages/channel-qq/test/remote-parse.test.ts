/**
 * 遥控指令的纯解析器（`src/remote-parse.ts`）。
 *
 * 这是整个遥控面的**唯一语法来源**：QQ 那边输入的是文本，所以「这句话是指令还是普通
 * 提示词」必须能被穷举。纪律与前端斜杠菜单一致——**认不得的原样当提示词**，因为把
 * 操作者的话悄悄吞掉是比「没听懂」严重得多的失败。
 */
import { describe, expect, it } from 'vitest';
import { parseRemoteCommand, remoteBypassesQueue } from '../src/remote-parse.js';

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
    expect(parseRemoteCommand('/usage')).toEqual({ command: { kind: 'usage' } });
    expect(parseRemoteCommand('/undo')).toEqual({ command: { kind: 'undo', turns: 1 } });
    expect(parseRemoteCommand('/undo 3')).toEqual({ command: { kind: 'undo', turns: 3 } });
    expect(parseRemoteCommand('/retry')).toEqual({ command: { kind: 'retry' } });
    expect(parseRemoteCommand('/help')).toEqual({ command: { kind: 'help' } });
    expect(parseRemoteCommand('/approve')).toEqual({ command: { kind: 'approve', allow: true } });
    expect(parseRemoteCommand('/deny')).toEqual({ command: { kind: 'approve', allow: false } });
  });

  it('reads `/model default <id>` as switch-and-persist', () => {
    // 与裸 `/model <id>` 的区别是它**同时**改这个部署的默认（写回 config.json），所以
    // 解析层必须把这件事标出来：调用方据此决定要不要落盘。
    expect(parseRemoteCommand('/model default deepseek-v4-flash')).toEqual({
      command: { kind: 'model', model: 'deepseek-v4-flash', persist: true },
    });
    // 带空格或斜杠的 id 是合法 id（聚合站常见 `vendor/model`），要整段留下。
    expect(parseRemoteCommand('/model default nebius/Qwen3-Embedding-8B')).toEqual({
      command: { kind: 'model', model: 'nebius/Qwen3-Embedding-8B', persist: true },
    });
    // 裸 `/model` 是「有哪些」，不是「切到名为 default 的模型」。
    expect(parseRemoteCommand('/model')).toEqual({ command: { kind: 'models' } });
    // 光一个 `default` 没有 id：那是指令没写全，不是要切到一个叫 default 的模型。
    expect(parseRemoteCommand('/model default')).toEqual({ command: { kind: 'models' } });
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

  it('refuses a bogus turn count as a prompt, never as a silent "one"', () => {
    // Reading `/undo 0` or `/undo -1` as "undo one" would take back a turn the
    // peer did not ask for — the same failure mode as a silent no-op, with worse
    // consequences.
    for (const text of ['/undo 0', '/undo -1', '/undo abc', '/undo 2.5', '/undo 1 2']) {
      expect(parseRemoteCommand(text)).toEqual({ text });
    }
  });

  it('queues the surface-mutating verbs, and only the unblocking ones bypass', () => {
    // An undo spliced in beside a live turn would take back a turn the running
    // request is still building from, so it belongs in the serial queue.
    expect(remoteBypassesQueue({ kind: 'undo', turns: 1 })).toBe(false);
    expect(remoteBypassesQueue({ kind: 'retry' })).toBe(false);
    expect(remoteBypassesQueue({ kind: 'stop' })).toBe(true);
  });

  it('reads a command with trailing spaces and an inline argument', () => {
    // A phone keyboard appends spaces; an argument may contain spaces (a path).
    expect(parseRemoteCommand('  /perm   auto  ')).toEqual({ command: { kind: 'perm', mode: 'auto' } });
    expect(parseRemoteCommand('/ws C:/Program Files/x')).toEqual({
      command: { kind: 'workspace', dir: 'C:/Program Files/x' },
    });
  });
});
