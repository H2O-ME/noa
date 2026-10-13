/**
 * 平台错误的结构化形状，以及「这次失败该不该重试」的唯一判据。
 *
 * 这层存在的理由只有一条：**HTTP 状态码不是判据**。同一个开放平台，把「消息分片发送
 * 过快」以 HTTP 404 返回（业务码 50002 / err_code 40113004），把「系统繁忙，请稍后重
 * 试」以 HTTP 500 返回（50015001）。按状态码分类会同时犯两个错：把限频当永久失败
 * （于是平台抖一下，整轮的流式就被一次噪声废掉），又把真实的 4xx 当可重试（于是对着
 * 一个永远不会成功的请求退避三轮）。所以判据是业务码，状态码只在响应里没有业务码时
 * 兜底。
 *
 * 第三类是「撤回过期」（40064004）：它不是故障，是**预期**——消息发出超过平台的两分
 * 钟时限后再撤，本来就会被拒。它既不该重试，也不该在日志里冒充需要人处理的告警。
 */
import { QqTimeoutError } from './deadline.js';

/** 平台明确要求「稍后再来」的业务码。 */
const RETRYABLE_CODES = new Set([
  50015001, // 系统繁忙，请稍后重试
  50002, // 消息分片发送过快（粗码）
  40113004, // 消息分片发送过快（细码）
]);

/** 限频：重试要等得更久，因为平台要的是「慢一点」，不是「再试一次」。 */
const RATE_LIMIT_CODES = new Set([50002, 40113004]);

/** 撤回时限已过：预期结果，不是故障。 */
const RECALL_EXPIRED_CODES = new Set([40064004]);

/** 传输层失败（连接被断、超时、DNS）：与业务码无关，重试有意义。 */
const TRANSPORT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'ABORT_ERR',
]);

/**
 * 一次被平台拒绝的请求。
 *
 * 消息格式与原先的裸 `Error` 逐字一致（`qqbot: <what> (<status>): <body>`），所以日志
 * 与既有断言看不出差别；多出来的是结构化字段，让调用方能按**业务码**分类，而不是去
 * 正则匹配自己的错误文案。
 */
export class QqApiError extends Error {
  readonly status: number;
  /** 响应体的粗粒度业务码。 */
  readonly code: number | undefined;
  /** 响应体的细粒度业务码；与 `code` 不是一个命名空间。 */
  readonly errCode: number | undefined;

  constructor(what: string, status: number, payload: unknown) {
    super(`qqbot: ${what} (${status}): ${describe(payload)}`);
    this.name = 'QqApiError';
    this.status = status;
    this.code = numericField(payload, 'code');
    this.errCode = numericField(payload, 'err_code');
  }

  /** 细码优先：`err_code` 比 `code` 更能定位，缺了才退回粗码。 */
  get businessCode(): number | undefined {
    return this.errCode ?? this.code;
  }
}

/**
 * 这次失败重试有没有意义。
 * @param err - 上抛的失败。
 * @returns true = 等一会儿重发同一次请求；false = 再发也是白费，立刻收手。
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof QqApiError) {
    const code = err.businessCode;
    return (code !== undefined && RETRYABLE_CODES.has(code)) || err.status >= 500;
  }
  if (err instanceof QqTimeoutError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSPORT_CODES.has(code)) return true;
  // undici 把网络层失败统一报成 `TypeError: fetch failed`，真因藏在 `cause` 里——
  // 日志里那条裸的 `TypeError: fetch failed` 就是它，是抖动而非程序缺陷。
  return err instanceof TypeError;
}

/** 限频：调用方据此拉长重试间隔，而不是照常退避。 */
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof QqApiError)) return false;
  const code = err.businessCode;
  return code !== undefined && RATE_LIMIT_CODES.has(code);
}

/** 撤回时限已过：调用方据此安静收场，而不是打一条告警。 */
export function isRecallExpired(err: unknown): boolean {
  if (!(err instanceof QqApiError)) return false;
  const code = err.businessCode;
  return code !== undefined && RECALL_EXPIRED_CODES.has(code);
}

/** 响应体里取一个数字字段（非对象、缺字段、类型不对一律 undefined）。 */
function numericField(payload: unknown, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : undefined;
}

/** 响应体的可读摘要，与原先的错误文案同款（非 JSON 就原样，长则截断）。 */
function describe(payload: unknown): string {
  const detail = typeof payload === 'object' && payload !== null ? JSON.stringify(payload) : String(payload);
  return detail.slice(0, 300);
}
