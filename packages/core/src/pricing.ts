/**
 * 用量 → 钱的换算：一张表加一个纯函数。
 *
 * 之所以是「表 + 纯函数」而不是一个服务：价格不是**能力**，是**部署方写下来的一个
 * 事实**，而换算本身没有任何 IO、没有任何状态。把它做成客户端会假装这里有可发现、
 * 可替换的实现；做成纯函数则让「这段算术对不对」可以直接穷举驱动，不需要起进程。
 *
 * 单位是**每百万 token 的美元价**，因为这是各家端点自己公布价格的方式，也是唯一
 * 不需要在配置里写一串 0.0000005 的单位。
 *
 * 价格表由部署方提供（本产品从 `config.json` 读），经内核装配以 `pricing` 能力发布
 * —— 与 `embedModel` / `sttModel` 同一条路：插件看不到宿主的配置，只声明自己要什么。
 *
 * **未配价是一种受支持的状态**，不是配置缺失：表里没有这个模型时 `costOf` 返回
 * `undefined`，调用方照实说「未配价」而不是报一个 $0.00 —— 后者是个谎，它和「免费」
 * 长得一模一样。
 */
import { key, type ServiceKey } from './plugin/types.js';

/** 一个模型的价格，单位：美元 / 百万 token。 */
export interface ModelPrice {
  /** 输入（提示）价。缺省表示**未配价**，不是免费。 */
  readonly input?: number;
  /** 输出（补全）价。缺省表示**未配价**，不是免费。 */
  readonly output?: number;
}

/** 模型 id → 价格。表里没有的模型是未配价。 */
export type PricingTable = Readonly<Record<string, ModelPrice>>;

/** 一次换算的结果。 */
export interface CostEstimate {
  /** 换算用的模型 id。 */
  readonly model: string;
  /** 输入侧的钱（美元）。该侧未配价时缺省。 */
  readonly inputUSD?: number;
  /** 输出侧的钱（美元）。该侧未配价时缺省。 */
  readonly outputUSD?: number;
  /** **已配价**那几侧的和。绝不把未配价的一侧当 0 混进来。 */
  readonly totalUSD: number;
  /**
   * 是否有一侧未配价 —— 为真时 `totalUSD` 是**下界**，不是全价。
   *
   * 这个字段存在的唯一理由是让调用方能如实标注。少了它，一张只配了输入价的表会
   * 让每一笔估算都显得比真实账单便宜，而读者无从分辨。
   */
  readonly partial: boolean;
}

/** 价格表用的单位（各家端点公布价格的单位）。 */
const PER_MILLION_TOKENS = 1_000_000;

/**
 * 把一次会话的累计用量换算成钱。
 * @param model - 实际在用的模型 id（表按这个 key 查）。
 * @param totals - 累计 token 数；只读其中两个字段，`UsageStats` 可直接传入。
 * @param pricing - 价格表。
 * @returns 估算结果；模型未配价（或两侧都没配）时 undefined。
 */
export function costOf(
  model: string,
  totals: { readonly promptTokens: number; readonly completionTokens: number },
  pricing: PricingTable,
): CostEstimate | undefined {
  const price = pricing[model];
  if (price === undefined) return undefined;
  const inputUSD = priced(price.input, totals.promptTokens);
  const outputUSD = priced(price.output, totals.completionTokens);
  if (inputUSD === undefined && outputUSD === undefined) return undefined;
  return {
    model,
    ...(inputUSD === undefined ? {} : { inputUSD }),
    ...(outputUSD === undefined ? {} : { outputUSD }),
    totalUSD: (inputUSD ?? 0) + (outputUSD ?? 0),
    partial: inputUSD === undefined || outputUSD === undefined,
  };
}

/**
 * 一侧的价钱；未配价返回 undefined（**不是 0** —— 见模块头）。
 * @param perMillion - 每百万 token 的美元价。
 * @param tokens - 该侧的 token 数。
 * @returns 美元金额，或 undefined。
 */
function priced(perMillion: number | undefined, tokens: number): number | undefined {
  if (perMillion === undefined) return undefined;
  return (tokens / PER_MILLION_TOKENS) * perMillion;
}

/**
 * 价格表，当这个部署配了价时。
 *
 * 用 `ctx.get` 读，缺省是受支持的状态：没有表就没有成本估算，`/usage` 只报 token
 * 数 —— 报得少一句，好过报一个假的金额。
 */
export const pricing: ServiceKey<PricingTable> = key<PricingTable>('pricing');
