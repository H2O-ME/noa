/**
 * 这一行自己的设置：条目形状，以及「行里的值 → worker 预算」这一步。
 *
 * 从 `index.ts` 拆出（那里是插件体与程序执行），因为读者不同：那边讲**怎么跑一段模型
 * 写的程序**，这里讲**这一行的设置长什么样、怎么变成预算**。
 *
 * 一条纪律：**预算的正误只有一处判定**——`resolveCodeRuntimeConfig` 说了算，这里只把
 * 它的结果（成或不成）接给工具。行里手写的坏数字因此不会让插件激活失败，而是变成
 * `run_code` 里的一句拒绝。设置直接写在 `plugins.entries[].config`（没有设置页）。
 */
import { DEFAULT_CODE_RUNTIME_CONFIG, resolveCodeRuntimeConfig, type CodeRuntimeConfig } from './code-runtime.js';
import { objectConfig, type ConfigSchema } from '@noa/core';

/** 行 id（一个身份，一处定义）。 */
export const PTC_PLUGIN_NAME = '@noa/plugin-ptc';

/** 这一行的设置，也就是 `Config` 校验的形状。 */
export interface PtcPluginConfig {
  /** 单次 run_code 内并行子调用上限。 */
  maxParallelSubCalls?: number;
  computeMs?: number;
  maxWallMs?: number;
  maxOutputBytes?: number;
  maxOldGenerationSizeMb?: number;
}

/**
 * The row's validator.
 *
 * Types only: the BOUNDS of the four budgets are `resolveCodeRuntimeConfig`'s
 * business (one authority, checked at use), so a hand-edited `computeMs: -1` is
 * reported by the tool rather than making the row blow up.
 */
export const Config: ConfigSchema<PtcPluginConfig> = objectConfig<PtcPluginConfig>({
  maxParallelSubCalls: { type: 'number' },
  computeMs: { type: 'number' },
  maxWallMs: { type: 'number' },
  maxOutputBytes: { type: 'number' },
  maxOldGenerationSizeMb: { type: 'number' },
});

/** 并行子调用上限的默认值（派发队列自己的默认，不属于 worker 预算）。 */
export const DEFAULT_MAX_PARALLEL_SUB_CALLS = 10;

/** 「这份设置能不能跑」的结果：不成就把原因交给工具。 */
export type PtcRuntimeOutcome =
  | { readonly ok: true; readonly config: CodeRuntimeConfig }
  | { readonly ok: false; readonly message: string };

/**
 * 行设置 → worker 预算法。
 *
 * 不抛：调用方（插件体）把它当**读数**用，所以坏数字的后果是工具里的一句拒绝，
 * 而不是一个失败行。
 * @param settings - the row's settings.
 * @returns the resolved budgets, or why they are unusable.
 */
export function ptcRuntimeConfig(settings: PtcPluginConfig): PtcRuntimeOutcome {
  try {
    return {
      ok: true,
      config: resolveCodeRuntimeConfig({
        ...(settings.computeMs !== undefined ? { computeMs: settings.computeMs } : {}),
        ...(settings.maxWallMs !== undefined ? { maxWallMs: settings.maxWallMs } : {}),
        ...(settings.maxOutputBytes !== undefined ? { maxOutputBytes: settings.maxOutputBytes } : {}),
        ...(settings.maxOldGenerationSizeMb !== undefined
          ? { maxOldGenerationSizeMb: settings.maxOldGenerationSizeMb }
          : {}),
      }),
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The runtime defaults, re-exported so a reader of this module sees the budgets it resolves against. */
export { DEFAULT_CODE_RUNTIME_CONFIG };
