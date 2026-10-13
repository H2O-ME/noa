/**
 * Session-cumulative numbers: ONE fold over the kernel's per-run measurements,
 * shared by the host and the browser. The host folds the whole log to answer
 * `ready` (a resumed session's numbers must cover every run it ever had, not
 * just the blocks this browser happens to hold), and the browser folds each
 * live `run_stats` onto that baseline — the same `addRun`, so the two cannot
 * disagree about what a turn adds to the totals.
 */
import type { RunStats } from './kernel.js';

/** Running totals for the session's stats bar. */
export interface SessionTotals {
  runs: number;
  requests: number;
  toolCalls: number;
  retries: number;
  llmMs: number;
  toolMs: number;
  /** Summed over runs that reported a first token — the average's numerator. */
  firstTokenMs: number;
  firstTokenRuns: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export const emptyTotals: SessionTotals = {
  runs: 0,
  requests: 0,
  toolCalls: 0,
  retries: 0,
  llmMs: 0,
  toolMs: 0,
  firstTokenMs: 0,
  firstTokenRuns: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
};

/** Fold one finished run into the totals. */
export function addRun(totals: SessionTotals, stats: RunStats): SessionTotals {
  return {
    runs: totals.runs + 1,
    requests: totals.requests + stats.requests,
    toolCalls: totals.toolCalls + stats.toolCalls,
    retries: totals.retries + stats.retries,
    llmMs: totals.llmMs + stats.llmMs,
    toolMs: totals.toolMs + stats.toolMs,
    firstTokenMs: totals.firstTokenMs + (stats.firstTokenMs ?? 0),
    firstTokenRuns: totals.firstTokenRuns + (stats.firstTokenMs === undefined ? 0 : 1),
    promptTokens: totals.promptTokens + stats.promptTokens,
    completionTokens: totals.completionTokens + stats.completionTokens,
    cachedTokens: totals.cachedTokens + stats.cachedTokens,
  };
}

/** Every run recorded in a session's log, in log order. */
export function loggedRuns(events: readonly { type: string; stats?: RunStats }[]): RunStats[] {
  const runs: RunStats[] = [];
  for (const event of events) {
    if (event.type === 'run/stats' && event.stats !== undefined) runs.push(event.stats);
  }
  return runs;
}

/** Fold a whole log's runs (the `ready` baseline: `addRun` over every one). */
export function foldRuns(runs: readonly RunStats[]): SessionTotals {
  return runs.reduce(addRun, emptyTotals);
}