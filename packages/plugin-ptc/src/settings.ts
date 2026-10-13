/**
 * 这一行自己的设置：条目形状、设置页描述符，以及「行里的值 → worker 预算」这一步。
 *
 * 从 `index.ts` 拆出（那里是插件体与程序执行），因为读者不同：那边讲**怎么跑一段模型
 * 写的程序**，这里讲**这一行的设置长什么样、保存什么、页面显示什么**。
 *
 * 两条纪律：
 *  - **预算的正误只有一处判定**：`resolveCodeRuntimeConfig` 说了算，这里只把它的
 *    结果（成或不成）接给页面与工具。行里手写的坏数字因此不会让插件激活失败——激活
 *    失败会连设置页一起弄丢，而那正是修它的地方。
 *  - **空 = 用默认**：页面显示的是「存下来的值」，没存过就空着（默认值写在 placeholder
 *    里）。保存只写操作者真的给了的键，不把今天的默认值钉进配置文档。
 */
import { DEFAULT_CODE_RUNTIME_CONFIG, resolveCodeRuntimeConfig, type CodeRuntimeConfig } from './code-runtime.js';
import {
  objectConfig,
  type ConfigSchema,
  type PluginPageDescriptor,
  type PluginSettingField,
  type PluginSettingStatus,
} from '@noa/core';
/**
 * Execution mode for the code runtime: native tool calls only, `run_code` only,
 * or both.
 *
 * Defined HERE, in the package that implements the modes, and not in core. It
 * used to live in core with the reasoning "the config schema, the plugin host
 * and every surface all speak it" — none of them do any more: the settings are
 * this row's own config, validated by this package's `Config`, and a surface that
 * wants to show or change a mode asks this plugin. A host-level type would be
 * core holding one plugin's vocabulary, which is the special case this whole
 * refactor deletes.
 */
export type PtcMode = 'native' | 'ptc' | 'both';

/** 行 id，也是 RPC 命名空间（一个身份，一处定义）。 */
export const PTC_PLUGIN_NAME = '@noa/plugin-ptc';

/**
 * Every mode, in the order a picker shows them.
 *
 * The tuple is `as const` so its element type IS {@link PtcMode}: adding a member
 * to the union and forgetting this list becomes a compile error here, not a
 * silently missing option on the page.
 */
export const PTC_MODE_VALUES = ['native', 'ptc', 'both'] as const;

/** The mode list as the plugin's own API (`readonly PtcMode[]`). */
export const PTC_MODES: readonly PtcMode[] = PTC_MODE_VALUES;

/** 这一行的设置，也就是 `Config` 校验的形状。 */
export interface PtcPluginConfig {
  /** `native` = 这一行不注册 run_code（等同关闭）。 */
  mode?: PtcMode;
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
 * reported on the page and by the tool rather than making the row blow up.
 */
export const Config: ConfigSchema<PtcPluginConfig> = objectConfig<PtcPluginConfig>({
  mode: { type: 'string', oneOf: PTC_MODES },
  maxParallelSubCalls: { type: 'number' },
  computeMs: { type: 'number' },
  maxWallMs: { type: 'number' },
  maxOutputBytes: { type: 'number' },
  maxOldGenerationSizeMb: { type: 'number' },
});

/** 页面可编辑的字段键——保存校验用的也是这一份清单。 */
export const PTC_SETTING_KEYS = [
  'mode',
  'maxParallelSubCalls',
  'computeMs',
  'maxWallMs',
  'maxOutputBytes',
  'maxOldGenerationSizeMb',
] as const;
export type PtcSettingKey = (typeof PTC_SETTING_KEYS)[number];

/** 这个键是不是本行的设置（未知键必须点名拒绝，不能静默丢掉）。 */
export function isPtcSettingKey(key: string): key is PtcSettingKey {
  return (PTC_SETTING_KEYS as readonly string[]).includes(key);
}

/** 模式的中文读数（页面上的 select 选项与服务那一行状态共用）。 */
export const PTC_MODE_LABELS: Readonly<Record<PtcMode, string>> = {
  native: 'native（关闭：不注册 run_code）',
  ptc: 'ptc（只给 run_code，其它工具走程序内绑定）',
  both: 'both（原生工具调用与 run_code 并存）',
};

/**
 * 短标签，给 `/mode` 的三态表用（页面上的 select 用 `PTC_MODE_LABELS` 的长读数）。
 *
 * 两处都在这个包里，因为**模式是这个插件的词汇**：宿主曾经为它保留一份
 * `CodeMode` 类型、一份三态文案和一处按包名找行的 `codeModeInForce`——那是「加一个
 * 插件就要改一遍核心」的标本。现在宿主不认识模式，`/mode` 由这个插件自己注册。
 */
export const PTC_MODE_SHORT: Readonly<Record<PtcMode, string>> = {
  native: '普通',
  ptc: 'PTC',
  both: '混合',
};

/** 三态各一行语义（`/mode` 的表体）。 */
export const PTC_MODE_HINT: Readonly<Record<PtcMode, string>> = {
  native: '原生工具调用',
  ptc: '模型只见 run_code，其余工具以 TS 程序编排',
  both: 'run_code 与原生调用并存',
};

/**
 * `/mode` 的输出：当前模式一行 + 三态对照表。
 *
 * 是纯函数（不读盘、不碰 ctx），所以能直测；`log` 由调用方给。
 * @param current - the mode this row is in force with.
 * @returns one string per line, ready to log.
 */
export function ptcModeReport(current: PtcMode): string[] {
  return [
    `执行模式：${PTC_MODE_SHORT[current]}（本行 plugins.entries 的 mode；行关着或为 native 时不注册 run_code）`,
    ...PTC_MODES.map((mode) => {
      const mark = mode === current ? '❯' : ' ';
      const label = `${PTC_MODE_SHORT[mode]}${' '.repeat(Math.max(0, 6 - PTC_MODE_SHORT[mode].length))}`;
      return `  ${mark} ${label} ${PTC_MODE_HINT[mode]}`;
    }),
  ];
}

/** 并行子调用上限的默认值（派发队列自己的默认，不属于 worker 预算）。 */
export const DEFAULT_MAX_PARALLEL_SUB_CALLS = 10;

/**
 * Every numeric setting's default, in one place: the page teaches them in its
 * placeholders, and the plugin body resolves `maxParallelSubCalls` from the same
 * number — a default restated at each use is a default that drifts.
 */
const SETTING_DEFAULTS: Readonly<Record<Exclude<PtcSettingKey, 'mode'>, number>> = {
  maxParallelSubCalls: DEFAULT_MAX_PARALLEL_SUB_CALLS,
  computeMs: DEFAULT_CODE_RUNTIME_CONFIG.computeMs,
  maxWallMs: DEFAULT_CODE_RUNTIME_CONFIG.maxWallMs,
  maxOutputBytes: DEFAULT_CODE_RUNTIME_CONFIG.maxOutputBytes,
  maxOldGenerationSizeMb: DEFAULT_CODE_RUNTIME_CONFIG.maxOldGenerationSizeMb,
};

/** 「这份设置能不能跑」的结果：不成就把原因交给页面与工具。 */
export type PtcRuntimeOutcome =
  | { readonly ok: true; readonly config: CodeRuntimeConfig }
  | { readonly ok: false; readonly message: string };

/**
 * 行设置 → worker 预算法。
 *
 * 不抛：调用方（插件体）把它当**读数**用，所以坏数字的后果是页面上的一行与工具里
 * 的一句拒绝，而不是一个连设置页一起消失的失败行。
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

/** 保存时从提交的字段里解出数字：非数字要**点名**，不能变成 NaN 混进配置。 */
function numberField(key: PtcSettingKey, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`ptc: setting "${key}" must be a number, got ${JSON.stringify(raw)}`);
  return value;
}

/**
 * 校验并解出**提交了的**字段（只含表单真正交上来的键）。
 *
 * 空串是「不改」：页面上的数字框空着表示「用默认值」，把它当成 0 会把一次保存变成
 * 一次静默的封顶。`mode` 必须落在 `PTC_MODES` 里——它是 select，但 payload 也可能
 * 来自别处。
 *
 * 返回**补丁**而不是整份设置是有意的：`PluginConfigPort.setEntry` 把提交的 config
 * **逐键**合并进磁盘上的原样行，所以保存只该交表单改过的键——把展开后的整份设置
 * 交回去，会用展开值顶掉操作者手写的 `{env:NAME}` 引用（那是端口契约明文保住的
 * 东西）。
 * @param fields - the submitted fields (the wire carries strings).
 * @returns the per-key patch to store.
 */
export function ptcSavePatch(fields: Record<string, string>): PtcPluginConfig {
  const patch: PtcPluginConfig = {};
  for (const [key, raw] of Object.entries(fields)) {
    if (!isPtcSettingKey(key)) throw new Error(`ptc: unknown setting "${key}"`);
    const value = raw.trim();
    if (value.length === 0) continue;
    if (key === 'mode') {
      if (!PTC_MODES.includes(value as PtcMode)) {
        throw new Error(`ptc: setting "mode" must be one of ${PTC_MODES.join(' | ')}`);
      }
      patch.mode = value as PtcMode;
      continue;
    }
    patch[key] = numberField(key, value);
  }
  return patch;
}

/**
 * 提交的字段并到当前设置上（内存里的合成视图，用于保存后的页面回显；落盘走
 * `ptcSavePatch` 的逐键补丁）。
 * @param current - the settings this activation was given.
 * @param fields - the submitted fields (the wire carries strings).
 * @returns the settings to display.
 */
export function ptcSaveSettings(current: PtcPluginConfig, fields: Record<string, string>): PtcPluginConfig {
  return { ...current, ...ptcSavePatch(fields) };
}

/**
 * 设置页。
 *
 * 保存成功后**不在这里再印一行确认**：通用页面（`web/ui` 的 `PluginPageSection`）
 * 对每一次成功保存都已经说了一句「已保存」，而「这一行会按新设置重挂」本来就写在
 * `note` 里恒在。一次保存两行绿字是同一件事说两遍——这句重复正是本次设置页重做拆掉
 * 的那类东西。
 * @param settings - the stored settings (what the fields show).
 * @param outcome - the resolved budgets (what the status line reports).
 * @returns the page descriptor.
 */
export function ptcPage(
  settings: PtcPluginConfig,
  outcome: PtcRuntimeOutcome,
): PluginPageDescriptor {
  const mode = settings.mode ?? 'both';
  const status: PluginSettingStatus[] = [
    // 「当前模式」而不是「模式」：下面的字段也叫「模式」，两个同名的读数并排，
    // 读者得自己猜哪个是「现在」哪个是「要改成」。
    { label: '当前模式', value: PTC_MODE_LABELS[mode] },
    outcome.ok
      ? {
          label: '生效',
          value: mode === 'native' ? '未注册 run_code' : 'run_code 已注册',
          tone: mode === 'native' ? 'warn' : 'ok',
        }
      : { label: '生效', value: `配置无效：${outcome.message}`, tone: 'bad' },
  ];
  return {
    title: 'PTC 代码模式',
    intro:
      '让模型写一段 TypeScript 程序去调工具，而不是一步一个原生调用：程序里的每次绑定调用都走'
      + '内核的分发管道，所以审批与钩子对子调用同样生效，只有打印或返回的内容回到对话里。',
    guide: [
      'native：这一行等于关闭，只有原生工具调用。',
      'ptc：只声明 run_code，其余工具只能作为程序里的绑定使用。',
      'both：原生调用与 run_code 并存。',
      '预算是 worker 的上限：计算时间、墙钟、输出字节与堆大小；留空即用默认值。',
    ],
    status,
    fields: [
      {
        key: 'mode',
        label: '模式',
        kind: 'select',
        value: mode,
        options: PTC_MODES.map((value) => ({ value, label: PTC_MODE_LABELS[value] })),
      },
      budgetField(settings, 'maxParallelSubCalls', '并行子调用上限', '单次 run_code 内并行子调用的条数上限。'),
      budgetField(settings, 'computeMs', '计算预算（毫秒）', 'worker 自身忙等的时间上限；空闲等慢工具不算。'),
      budgetField(settings, 'maxWallMs', '墙钟上限（毫秒）', '一次 run_code 的绝对时长上限。'),
      budgetField(settings, 'maxOutputBytes', '输出上限（字节）', '程序输出与返回值之和的字节上限。'),
      budgetField(settings, 'maxOldGenerationSizeMb', '堆上限（MB）', 'worker 老生代堆上限。'),
    ],
    note: '改完保存会重挂这一行；native 模式下这一行不注册任何工具。',
  };
}

/** One numeric budget field: shows the STORED value, teaches the default in the placeholder. */
function budgetField(
  settings: PtcPluginConfig,
  key: Exclude<PtcSettingKey, 'mode'>,
  label: string,
  hint: string,
): PluginSettingField {
  const stored = settings[key];
  return {
    key,
    label,
    kind: 'text',
    value: stored === undefined ? '' : String(stored),
    placeholder: `默认 ${String(SETTING_DEFAULTS[key])}`,
    hint,
  };
}
