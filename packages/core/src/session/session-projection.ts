/**
 * The PURE projections over a session's event stream: what a reader reconstructs
 * from the log, with no I/O and no state.
 *
 * Split from `session.ts` (which owns the log's read/write lifecycle) because
 * they answer different questions: this file is "what does this stream MEAN",
 * the class is "how is it stored and appended". Everything here is a pure
 * function over events, so a surface that only projects a log never has to open
 * one — and the compaction surface has exactly ONE implementation, shared by the
 * live compaction path and the replay projection (see `compactionSurface`).
 */
import type { RunStats } from '../kernel/metrics.js';
import type { SessionEvent } from '../session.js';
import { validateEvent } from './session-event-schema.js';
import type { AgentMessage, UserMessage } from '../types.js';

/**
 * Each run's measurement, keyed by the message it closed (the anchor the log
 * itself carries). A surface draws those numbers right after that message; one
 * the projection no longer holds (compaction replaced it) simply keeps no row,
 * because re-anchoring a measurement would attribute it to a message it never
 * measured.
 */
export function anchoredRunStats(events: readonly SessionEvent[]): Map<string, RunStats> {
  const runs = new Map<string, RunStats>();
  for (const event of events) {
    if (event.type !== 'run/stats' || event.afterMessageId === undefined) continue;
    // Last write wins: a re-run of the same anchor is the one a reader saw last.
    runs.set(event.afterMessageId, event.stats);
  }
  return runs;
}

/** The exported prefix used by the projected compaction summary message. */
export const COMPACT_SUMMARY_PREFIX = '[已压缩的上一会话摘要]';

/**
 * Deterministic summary message synthesized from a compaction/summary event.
 * Both the live compaction path and the replay projection construct the SAME
 * message through this helper, so the surface is byte-identical after resume.
 */
export function compactionSummaryMessage(summary: string, seq: number, at: number): UserMessage {
  return {
    id: `msg_compact_${seq}`,
    ts: at,
    role: 'user',
    content: `${COMPACT_SUMMARY_PREFIX}\n${summary}`,
  };
}

/**
 * The ONE implementation of "surface after this compaction" = kept originals
 * + the synthesized summary message. The live compaction path (cli/compact)
 * and the replay projection (deriveMessages) both go through here, so the
 * two never drift — previously the live path resolved `keep` positionally
 * while the projection preferred `keepIds`, and the "model-visible means
 * logged" invariant leaned on a dev-only divergence check.
 */
export function compactionSurface(
  evt: Extract<SessionEvent, { type: 'compaction/summary' }>,
  all: AgentMessage[],
  seq: number,
): AgentMessage[] {
  return [...resolveKeptMessages(evt, all), compactionSummaryMessage(evt.summary, seq, evt.at)];
}

/**
 * One line of a session log. Kept here beside the projection rather than with
 * the reader: the line's shape IS the event vocabulary, and the parser is a
 * pure function of it (`session-log.ts` owns the file access around it).
 *
 * `JSON.parse` guarantees SYNTAX, not SHAPE, so the parsed value is checked
 * against the union (`session-event-schema.ts`) before it is admitted.
 * @throws when the line is not a well-formed event (the reader turns that into
 * its existing "skip this line" warning).
 */
export function parseEventLine(line: string): SessionEvent {
  const event = validateEvent(JSON.parse(line));
  if (event === undefined) throw new Error('malformed session event');
  return event;
}

/**
 * Resolve a compaction/summary event's kept entries against the full message
 * stream. `keepIds` (written since M7.8) is authoritative: a corrupt middle
 * line shifts positional indices, but ids pin the kept messages exactly —
 * a kept message lost to damage is simply omitted. Old logs without keepIds
 * fall back to the positional `keep` indices.
 */
function resolveKeptMessages(
  evt: Extract<SessionEvent, { type: 'compaction/summary' }>,
  all: AgentMessage[],
): AgentMessage[] {
  if (evt.keepIds !== undefined) {
    const byId = new Map(all.map((msg) => [msg.id, msg] as const));
    return evt.keepIds.map((id) => byId.get(id)).filter((msg): msg is AgentMessage => msg !== undefined);
  }
  return evt.keep.map((index) => all[index]).filter((msg): msg is AgentMessage => msg !== undefined);
}

/**
 * Index of the LAST unmatched compaction/start (an orphaned lock from a crash
 * mid-compaction), or -1 when every compaction is properly closed.
 */
export function findOrphanCompaction(events: SessionEvent[]): number {
  let open = -1;
  for (let i = 0; i < events.length; i++) {
    const evt = events[i]!;
    if (evt.type === 'compaction/start') open = i;
    else if (evt.type === 'compaction/end') open = -1;
  }
  return open;
}
