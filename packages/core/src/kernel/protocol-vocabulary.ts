/**
 * The vocabulary the kernel event protocol is written in: the phase names, the
 * operational notice codes and the compaction progress record.
 *
 * Split from `protocol.ts` because these are the WORDS — stable enumerations and
 * small records a consumer may import on their own (a status line needs
 * `TurnPhase` and nothing else) — while `protocol.ts` is the union of events that
 * carries them. `protocol.ts` re-exports all of this.
 */

/** What the agent is doing right now (drives live rows: spinner verb, web pulse). */
export type TurnPhase =
  | 'idle'
  | 'thinking'
  | 'writing'
  | 'tool'
  | 'waiting_approval'
  /**
   * The model asked the human a question and the run is suspended inside the ask.
   * Distinct from `waiting_approval`: one is a verdict on a call already made, the
   * other is input the model needs before it can make one.
   */
  | 'waiting_question'
  | 'compacting'
  | 'retrying';

/** Stable machine codes for operational notices (text is the fallback rendering). */
export type NoticeCode =
  /** A per-request (headless) auto-compaction succeeded — the success line for
   *  runs whose compaction never surfaces as a `compaction` event. */
  | 'compacted'
  /** Auto-compact ran and the retained floor is STILL over: fused off for this session. */
  | 'compact_fused'
  /** A plugin hook replaced the messages array, so in-place compaction was disarmed. */
  | 'compact_alias_broken'
  /** An automatic compaction attempt threw (run continues uncompressed). */
  | 'compact_failed'
  /** A surface's event consumer fell behind MAX_LAG and its window was reset. */
  | 'surface_lagged'
  /** A subscribed event listener threw. Reported instead of crashing the run. */
  | 'listener_failed';

/** A compaction pass, start → done|error, with the outcome bits a surface renders. */
export interface CompactionProgress {
  state: 'start' | 'done' | 'error';
  trigger: 'auto' | 'manual';
  /** Retained recent messages (state 'done'). */
  retained?: number;
  /** Summary length in chars (state 'done'). */
  summaryChars?: number;
  /** Failure reason (state 'error'). */
  error?: string;
}
