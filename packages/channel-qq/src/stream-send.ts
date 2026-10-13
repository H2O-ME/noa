/**
 * 一片流式消息怎么发出去：重试几次、等多久、什么时候算「试不动了」。
 *
 * 从 `stream.ts` 拆出，因为那是两个问题：那边是「什么时候该发哪一片」（delta 的累积
 * 与节流），这里是「这一片发出去要几次才成」。分开的实益是重试策略能单独读——它只调
 * 常量和两个注入的接缝，而其中一个判据错一点，就会把平台抖动升级成整轮降级。
 *
 * 判据本身（哪些失败值得重试）在 `api-error.ts`，因为那需要平台知识而不是策略。
 */
import { isRateLimited, isRetryable } from './api-error.js';

/** 一片最多试几次（含首次）。 */
export const STREAM_SEND_ATTEMPTS = 3;
/**
 * 重试的总时长上限。
 *
 * 一次挂死的请求不该把回复无限期拖住：收口的成败决定正文由谁送，调用方要等它，而每
 * 一次尝试本身还有自己的墙钟上限（`deadline.ts`）。有这道闸门，最坏情况就是「一次挂
 * 死的请求」那么多，而不是「次数 × 每次上限」。
 */
export const STREAM_RETRY_BUDGET_MS = 5_000;
/** 第一次重试前的等待，之后按尝试次数线性放大。 */
const RETRY_BACKOFF_MS = 600;
/** 限频的重试等待更长：平台要的是慢一点，不是「再试一次」。 */
const RATE_LIMIT_BACKOFF_MS = 2_000;

/** 默认的等待实现。 */
export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 发一片要用的接缝。 */
export interface ShardSendOptions {
  /** 发一次。抛错即这一次失败。 */
  attempt: () => Promise<void>;
  /** 时钟（重试预算用）。 */
  now: () => number;
  /** 重试之间的等待。 */
  sleep: (ms: number) => Promise<void>;
}

/** 这一片的下场：`err` 存在 = 试到不能再试了。 */
export type ShardOutcome = { ok: true } | { ok: false; err: unknown };

/**
 * 发一片，失败按可重试性决定重试还是收手。
 * @param options - 发送动作与两个接缝。
 * @returns 成功，或最后一次的失败。
 */
export async function sendShard(options: ShardSendOptions): Promise<ShardOutcome> {
  const startedAt = options.now();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await options.attempt();
      return { ok: true };
    } catch (err) {
      const exhausted = attempt >= STREAM_SEND_ATTEMPTS
        || options.now() - startedAt >= STREAM_RETRY_BUDGET_MS
        || !isRetryable(err);
      if (exhausted) return { ok: false, err };
      await options.sleep(retryDelayMs(err, attempt));
    }
  }
}

/** 下一次重试前等多久：限频要等更久，其余按尝试次数放大。 */
function retryDelayMs(err: unknown, attempt: number): number {
  return (isRateLimited(err) ? RATE_LIMIT_BACKOFF_MS : RETRY_BACKOFF_MS) * attempt;
}
