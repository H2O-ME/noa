/**
 * runAgent 家族（M9.6 阶段 G 拆分后）：本文件是**公共面桶文件**——
 * 实现住在 `src/agent/` 五模块（options 常量与选项层 / notices 请求级通知
 * 簿记 / request 装配 / stream 流式与空补全重试 / tools 调度与溢出落盘 /
 * loop 主体），导出面与拆分前逐符号一致。新代码按模块直 import；
 * 经 index.js 消费的外部面不受影响。
 */
export {
  CACHE_MISS_NOISE_FLOOR_TOKENS,
  DEFAULT_MAX_TURNS,
  EMPTY_COMPLETION_MAX_RETRIES,
  LENGTH_CUTOFF_TOOL_GUIDANCE,
  NOT_EXECUTED_GUIDANCE,
  TURN_ABORTED_GUIDANCE,
  emptyStats,
  isAbortMarker,
  type AgentOptions,
  type ToolDispatcher,
} from './agent/options.js';
export { STALE_TODO_NAG, STALE_TODO_TURNS } from './agent/notices.js';
export { runAgent } from './agent/loop.js';
