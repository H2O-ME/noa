import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalBroker,
  MAX_ALWAYS_SCOPE_WORDS,
  MAX_DENY_REASON_CHARS,
  parseAskResult,
  type ApprovalResolution,
} from '../src/approval.js';
import type { ToolCall } from '../src/types.js';
import { hasControlChars } from '../src/text.js';

/** One execute call — the only kind that ever reaches an approval ask. */
const CALL: ToolCall = { id: 'c1', name: 'bash', args: { command: 'rm -rf /' }, rawArgs: '{}' };

/**
 * The answer parser is the kernel's one untrusted-input boundary for approval:
 * a WebUI frame, a Rust-bridge message and a third-party asker's return all
 * arrive here. These cases are the contract the three call sites rely on, kept
 * at the vocabulary's owner instead of being re-derived per surface.
 */
describe('parseAskResult', () => {
  it('passes bare verdicts through unchanged', () => {
    for (const verdict of ['allow', 'deny', 'always'] as const) {
      expect(parseAskResult(verdict)).toBe(verdict);
    }
  });

  it('reads both grant shapes: tagged (plugin asker) and bare (wire)', () => {
    expect(parseAskResult({ answer: 'always', scopeWords: 2 })).toEqual({ answer: 'always', scopeWords: 2 });
    expect(parseAskResult({ scopeWords: 2 })).toEqual({ answer: 'always', scopeWords: 2 });
    expect(parseAskResult({ answer: 'deny', reason: ' 别碰 CI ' })).toEqual({ answer: 'deny', reason: '别碰 CI' });
    expect(parseAskResult({ reason: '别碰 CI' })).toEqual({ answer: 'deny', reason: '别碰 CI' });
  });

  it('bounds a scope grant and rejects every non-integer form', () => {
    expect(parseAskResult({ scopeWords: 1 })).toEqual({ answer: 'always', scopeWords: 1 });
    expect(parseAskResult({ scopeWords: MAX_ALWAYS_SCOPE_WORDS })).toEqual({ answer: 'always', scopeWords: MAX_ALWAYS_SCOPE_WORDS });
    for (const bad of [0, -1, 1.5, MAX_ALWAYS_SCOPE_WORDS + 1, '2', null, true]) {
      expect(parseAskResult({ scopeWords: bad })).toBeUndefined();
    }
  });

  it('clamps a long reason; a blank or non-string reason degrades a tagged denial', () => {
    const long = parseAskResult({ reason: 'x'.repeat(MAX_DENY_REASON_CHARS + 50) });
    expect(long).toEqual({ answer: 'deny', reason: 'x'.repeat(MAX_DENY_REASON_CHARS) });
    // Tagged: the verdict survives without the unusable reason.
    expect(parseAskResult({ answer: 'deny', reason: '   ' })).toBe('deny');
    expect(parseAskResult({ answer: 'deny', reason: 42 })).toBe('deny');
    expect(parseAskResult({ answer: 'deny' })).toBe('deny');
    // Untagged: there is no verdict to keep, so the whole answer is malformed.
    expect(parseAskResult({ reason: '   ' })).toBeUndefined();
    expect(parseAskResult({ reason: 42 })).toBeUndefined();
  });

  it('rejects control junk in a reason but tolerates the newlines a user typed', () => {
    expect(parseAskResult({ reason: 'stop\u001b[2J' })).toBeUndefined();
    expect(parseAskResult({ answer: 'deny', reason: 'stop\u001b[2J' })).toBe('deny');
    expect(parseAskResult({ reason: 'line one\nline two' })).toEqual({ answer: 'deny', reason: 'line one\nline two' });
  });

  it('honours an explicit answer tag over shape sniffing', () => {
    // A grant whose tag disagrees with its fields is malformed, not a guess.
    expect(parseAskResult({ answer: 'allow', scopeWords: 2 })).toBeUndefined();
    expect(parseAskResult({ answer: 'yes', scopeWords: 2 })).toBeUndefined();
    expect(parseAskResult({ answer: 'always' })).toBeUndefined();
  });

  it('rejects everything that is not an answer at all', () => {
    for (const bad of ['maybe', 'Y', '', 1, null, undefined, true, [], [{ reason: 'x' }]]) {
      expect(parseAskResult(bad)).toBeUndefined();
    }
  });
});

describe('hasControlChars', () => {
  it('flags escapes and NULs in both policies', () => {
    expect(hasControlChars('a\u001b[31mb')).toBe(true);
    expect(hasControlChars('a\u0000b')).toBe(true);
    expect(hasControlChars('a\u0000b', { multiline: true })).toBe(true);
  });

  it('lets multi-line fields keep their newlines and tabs', () => {
    expect(hasControlChars('one\ntwo', { multiline: true })).toBe(false);
    expect(hasControlChars('one\ttwo', { multiline: true })).toBe(false);
    // A path or an id is never multi-line.
    expect(hasControlChars('one\ntwo')).toBe(true);
    expect(hasControlChars('one\ttwo')).toBe(true);
  });
});
/**
 * 兜底等待：**沉默必须有个尽头**。
 *
 * 审批的失败方向是拒绝（fail-closed），但「拒绝」要有一个定时器把它落下来才会发生。
 * 原先那个定时器只存在于通道层（`channel-qq` 的 3 分钟），内核自己的契约是「等人类，
 * 等到天荒地老」——任何别的 surface 只要忘了自带一个，那一轮就永久停在那里。
 */
describe('ApprovalBroker · backstop wait', () => {
  it('denies an ask nobody answers, and reports it as a timeout rather than a user verdict', async () => {
    vi.useFakeTimers();
    try {
      const resolutions: ApprovalResolution[] = [];
      const broker = new ApprovalBroker(() => undefined, undefined, 5_000);
      broker.attach(
        () => undefined,
        (_id, resolution) => resolutions.push(resolution),
      );

      const pending = broker.asker(CALL, 'execute');
      await vi.advanceTimersByTimeAsync(5_000);

      const answer = await pending;
      expect(answer).toMatchObject({ answer: 'deny' });
      // 理由必须进工具结果：模型读到的要是「没等到答复」，不是一句没有来由的拒绝。
      expect((answer as { reason?: string }).reason).toContain('按拒绝处理');
      expect(resolutions).toEqual([{ source: 'timeout' }]);
      expect(broker.outstanding()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands the backstop down once the human answers', async () => {
    vi.useFakeTimers();
    try {
      const resolutions: ApprovalResolution[] = [];
      const broker = new ApprovalBroker(() => undefined, undefined, 5_000);
      broker.attach(
        (request) => {
          broker.resolve(request.id, 'allow');
        },
        (_id, resolution) => resolutions.push(resolution),
      );

      await expect(broker.asker(CALL, 'execute')).resolves.toBe('allow');
      // 定时器必须被清掉：留着它会在五分钟后把一条早已结束的审批再收敛一次
      // ——第二次「结论」落到一个已经不在等的调用上。
      await vi.advanceTimersByTimeAsync(30_000);
      expect(resolutions).toEqual([{ source: 'user', answer: 'allow' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('arms nothing when the assembly pinned no backstop', async () => {
    // `0` 表示「装配方自己保证会收敛」（一个交互式界面自己知道人能等多久）。
    vi.useFakeTimers();
    try {
      const resolutions: ApprovalResolution[] = [];
      const broker = new ApprovalBroker(() => undefined, undefined, 0);
      broker.attach(
        () => undefined,
        (_id, resolution) => resolutions.push(resolution),
      );
      const pending = broker.asker(CALL, 'execute');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(resolutions).toEqual([]);
      broker.failAll('aborted');
      await expect(pending).resolves.toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });
});
