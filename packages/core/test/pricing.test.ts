/**
 * 价格换算：纯算术，所以这里能穷举驱动，不需要起会话也不需要端点。
 *
 * 钉住的是一条**诚实性**规则：未配价绝不是 0。把「不知道多少钱」印成 `$0.00`，
 * 读者会得出「免费」这个相反的结论 —— 这是这个文件里几乎每个用例真正在测的东西。
 */
import { describe, expect, it } from 'vitest';
import { costOf, type PricingTable } from '../src/pricing.js';

describe('costOf', () => {
  it('prices both sides at USD per million tokens', () => {
    const table: PricingTable = { m: { input: 3, output: 15 } };
    const cost = costOf('m', { promptTokens: 1_000_000, completionTokens: 200_000 }, table);
    expect(cost).toEqual({
      model: 'm',
      inputUSD: 3,
      outputUSD: 3,
      totalUSD: 6,
      partial: false,
    });
  });

  it('returns undefined for a model the table does not mention', () => {
    expect(costOf('other', { promptTokens: 10, completionTokens: 10 }, { m: { input: 1 } })).toBeUndefined();
  });

  it('returns undefined when the entry exists but has no price on either side', () => {
    // An empty entry is the same state as a missing one: nothing to price with.
    expect(costOf('m', { promptTokens: 10, completionTokens: 10 }, { m: {} })).toBeUndefined();
  });

  it('treats a missing side as UNPRICED, never as free', () => {
    const cost = costOf('m', { promptTokens: 1_000_000, completionTokens: 1_000_000 }, { m: { input: 2 } });
    expect(cost).toEqual({ model: 'm', inputUSD: 2, totalUSD: 2, partial: true });
    // The absent side is absent from the result, not zeroed into it — that is what
    // lets a reader tell "not counted" from "counted as nothing".
    expect(cost).not.toHaveProperty('outputUSD');
  });

  it('reports the priced side alone when only the output has a price', () => {
    const cost = costOf('m', { promptTokens: 1_000_000, completionTokens: 500_000 }, { m: { output: 10 } });
    expect(cost).toEqual({ model: 'm', outputUSD: 5, totalUSD: 5, partial: true });
  });

  it('is exact at zero tokens, and free only when actually priced at zero', () => {
    // `priced at 0` and `unpriced` must stay distinguishable: the first is a real
    // (free) price, the second is a missing fact.
    expect(costOf('m', { promptTokens: 0, completionTokens: 0 }, { m: { input: 5 } })?.totalUSD).toBe(0);
    expect(costOf('m', { promptTokens: 0, completionTokens: 0 }, { m: {} })).toBeUndefined();
  });

  it('ignores the other UsageStats fields, so a session snapshot can be passed as-is', () => {
    const cost = costOf(
      'm',
      { promptTokens: 1_000_000, completionTokens: 0, turns: 9, cachedTokens: 5, missTokens: 5, missTurns: 1 },
      { m: { input: 1 } },
    );
    expect(cost?.totalUSD).toBe(1);
  });
});
