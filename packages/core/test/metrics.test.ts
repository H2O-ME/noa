/**
 * RunMeter — the per-run timings behind the `run_stats` event (M11 批6).
 * The clock is injected, so every number here is exact rather than
 * flaky-by-timing: a run's duration, its time-to-first-token and the split
 * between provider time and tool time are asserted to the millisecond.
 */
import { describe, expect, it } from 'vitest';
import { RunMeter } from '../src/index.js';

/** A clock the test advances by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('RunMeter', () => {
  it('splits a run into provider time and tool time', () => {
    const clock = fakeClock();
    const meter = new RunMeter(clock.now);
    meter.start();

    clock.advance(100); // request assembly + hooks: NOT provider time
    meter.observe({ type: 'turn_start', turn: 1 });
    meter.requestStart(); // the assembled request reaches the provider
    clock.advance(900); // the provider's answer
    meter.observe({ type: 'text_delta', messageId: 'm', text: 'hi' });
    meter.observe({ type: 'usage', usage: { promptTokens: 100, completionTokens: 20, cachedTokens: 80 }, stats: {} });
    meter.requestEnd();
    clock.advance(500); // a tool runs
    meter.observe({ type: 'tool_call_start', call: { id: 'c1' } });
    clock.advance(2_000);
    meter.observe({ type: 'tool_call_result', call: { id: 'c1' }, result: {} });
    clock.advance(50);

    const stats = meter.finish();
    // First token landed 1000ms in: the 100ms of setup is NOT time-to-token.
    expect(stats.firstTokenMs).toBe(1_000);
    expect(stats.durationMs).toBe(3_550);
    // The 100ms of assembly is not provider time either — the window opens at
    // requestStart, not at turn_start.
    expect(stats.llmMs).toBe(900);
    expect(stats.toolMs).toBe(2_000);
    expect(stats.requests).toBe(1);
    expect(stats.toolCalls).toBe(1);
    expect(stats.retries).toBe(0);
    expect(stats.promptTokens).toBe(100);
    expect(stats.completionTokens).toBe(20);
    expect(stats.cachedTokens).toBe(80);
  });

  it('closes a request that never reports usage', () => {
    const clock = fakeClock();
    const meter = new RunMeter(clock.now);
    meter.start();
    meter.observe({ type: 'turn_start', turn: 1 });
    meter.requestStart();
    clock.advance(700);
    // No `usage` ever arrives (a provider that does not report it, or a request
    // the run abandons): the stream simply ends.
    meter.requestEnd();

    const stats = meter.finish();
    expect(stats.llmMs).toBe(700);
    expect(stats.requests).toBe(1);
    expect(stats.requestTimings).toHaveLength(1);
    expect(stats.requestTimings?.[0]?.finishedAt).toBeDefined();
  });

  it('counts a retried request once, across the retry', () => {
    const clock = fakeClock();
    const meter = new RunMeter(clock.now);
    meter.start();
    meter.observe({ type: 'turn_start', turn: 1 });
    meter.requestStart();
    clock.advance(400);
    meter.observe({ type: 'llm_retry', attempt: 1, maxRetries: 5, error: 'socket', stats: {} });
    clock.advance(600); // the retry's answer
    meter.observe({ type: 'usage', usage: { promptTokens: 10, completionTokens: 1, cachedTokens: 0 }, stats: {} });
    meter.requestEnd();

    const stats = meter.finish();
    expect(stats.retries).toBe(1);
    expect(stats.requests).toBe(1);
    // One open request across the retry: 400 + 600, not 400 plus a second pair.
    expect(stats.llmMs).toBe(1_000);
    expect(stats.requestTimings).toHaveLength(1);
  });

  it('reports a run that streamed nothing without inventing a first-token time', () => {
    const clock = fakeClock();
    const meter = new RunMeter(clock.now);
    meter.start();
    clock.advance(300);
    const stats = meter.finish();
    expect(stats.firstTokenMs).toBeUndefined();
    expect(stats.durationMs).toBe(300);
    expect(stats.toolCalls).toBe(0);
  });

  it('restarts cleanly for the next run', () => {
    const clock = fakeClock();
    const meter = new RunMeter(clock.now);
    meter.start();
    meter.observe({ type: 'turn_start', turn: 1 });
    meter.observe({ type: 'tool_call_start', call: { id: 'c1' } });
    clock.advance(1_000);
    meter.observe({ type: 'tool_call_result', call: { id: 'c1' }, result: {} });
    expect(meter.finish().toolMs).toBe(1_000);

    meter.start();
    clock.advance(10);
    const second = meter.finish();
    expect(second.toolMs).toBe(0);
    expect(second.toolCalls).toBe(0);
    expect(second.durationMs).toBe(10);
  });
});
