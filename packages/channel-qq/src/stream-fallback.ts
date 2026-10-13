/**
 * 流式卡片废掉之后，现场怎么收。
 *
 * 从 `observer.ts` 拆出，因为那是两件事：那边决定「什么时候用卡片」，这里决定「卡片
 * 用不了之后剩下什么」。收尾的正确性全压在一条不变式上——**同一段正文只能留一份**：
 * 卡片露过脸又永远收不了口，回落发出的那条正文就是第二份，读者看到的是半截卡片加一
 * 条完整回复。
 */
import { isRecallExpired } from './api-error.js';
import type { Peer } from './types.js';

/** 收尾要用到的那几件事实（`TurnObserverDeps` 的子集）。 */
export interface StreamBreakDeps {
  /** 卡片中途发不出去时撤掉它。 */
  recallStream?: (peer: Peer, messageId: string) => Promise<void>;
  /** 通知装配层，由它决定要不要暂时别再用流式。 */
  onStreamBroken?: (err: unknown) => void;
  log?: (line: string) => void;
}

/**
 * 流式在这一轮废掉了：留痕、通知装配层、把已经露过脸的卡片撤掉。
 *
 * 撤回是尽力而为——撤不掉就退回重复（重复比只有半截可接受），所以失败只丢一行日志，
 * 绝不反过来打扰回落。
 * @param err - 最后的失败原因。
 * @param peer - 这一轮服务的对端。
 * @param card - 已经露过脸的卡片 id；没有 = 从没发出去过，无需收拾。
 * @param deps - 通知与撤回的座位。
 */
export function handleStreamBreak(
  err: unknown,
  peer: Peer,
  card: string | undefined,
  deps: StreamBreakDeps,
): void {
  deps.log?.(`stream failed, falling back to plain narration + markdown reply: ${String(err)}`);
  deps.onStreamBroken?.(err);
  const recall = deps.recallStream;
  if (card === undefined || recall === undefined) return;
  void recall(peer, card).catch((recallErr: unknown) => {
    // 时限已过是预期（本地时钟与平台时钟对不齐），不冒充需要人处理的告警。
    if (isRecallExpired(recallErr)) return;
    deps.log?.(`stream card recall failed: ${String(recallErr)}`);
  });
}
