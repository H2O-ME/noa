import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { newId } from './ids.js';
import { readEvents, upgradeToV2 } from './session/session-log.js';
import { compactionSurface, findOrphanCompaction } from './session/session-projection.js';
import type { RunStats } from './kernel/metrics.js';
import type { AgentMessage } from './types.js';
import type { Goal } from './goal.js';

/**
 * Re-exported so a consumer of the log also gets the projections over it: the
 * two are halves of one vocabulary, and every reader of `Session` needs both.
 * The implementations live in `session-projection.ts` (pure, no I/O).
 */
export {
  anchoredRunStats,
  COMPACT_SUMMARY_PREFIX,
  compactionSummaryMessage,
  compactionSurface,
  findOrphanCompaction,
  parseEventLine,
} from './session/session-projection.js';

/**
 * Session log format v2: the file is an append-only event stream, not a
 * message transcript. "Model-visible means logged" — every message the model
 * sees is a logged `message` event, and compaction NEVER rewrites history:
 * it appends log-only events and the model-visible surface is *projected*
 * (dsh-style surface replacement). Replay, resume, audits and telemetry all
 * derive from this one stream.
 */
export const SESSION_VERSION = 2;

export interface SessionHeader {
  type: 'session';
  v: number;
  id: string;
  createdAt: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export type SessionEvent =
  | { type: 'message'; message: AgentMessage }
  | { type: 'compaction/start'; trigger: 'auto' | 'manual'; at: number }
  | {
      type: 'compaction/summary';
      /** Full handoff summary text; the projection synthesizes the marker message from it. */
      summary: string;
      /** Indices into the full message-event stream kept verbatim on the surface (fragment first, then recents). */
      keep: number[];
      /**
       * Message ids of the kept entries (same set as `keep`, written alongside
       * since M7.8). When present, the projection resolves by ID — a corrupt
       * middle line shifts positional indices, and id resolution keeps the
       * restored surface aligned with what was actually kept.
       */
      keepIds?: string[];
      /** Estimated token count of the replaced surface. */
      shadowedTokenCount: number;
      at: number;
    }
  | { type: 'compaction/end'; at: number; error?: string }
  /** Log-only durable todo snapshot; never joins the model surface. */
  | { type: 'todo/write'; todos: TodoItem[]; at: number }
  /**
   * A durable goal snapshot — log-only like `todo/write`, and for the same reason:
   * the goal must survive a resume without becoming context the model pays for
   * every turn. `null` records a CLEAR, so "no goal" has exactly one spelling on
   * the wire and in the log.
   */
  | { type: 'goal/change'; goal: Goal | null; at: number }
  /** Log-only approval audit pair record; never joins the model surface. */
  | { type: 'approval'; toolName: string; kind: string; outcome: 'allow' | 'deny' | 'always'; at: number }
  /** Log-only workspace marker (session switching restores the tools' root
   * from it); never joins the model surface. */
  | { type: 'workspace'; path: string; at: number }
  /**
   * Log-only session-title marker (see `session-title.ts`); never joins the
   * model surface. Written once per conversation by the title model, and read
   * by every session LISTING — the newest marker wins, so a regenerated title
   * is a second marker, not an edit.
   */
  | { type: 'title'; title: string; at: number }
  /**
   * Log-only PTC sub-dispatch audit record: one per settled `run_code`
   * binding call (dsh tool/code-dispatch). The only durable trace of what a
   * program actually did — intermediate results never enter the model
   * surface, so without this record a PTC turn would be unreconstructable.
   * Args and result are preview-capped string copies; the byte budgets keep
   * a program's fan-out from flooding the log.
   */
  | {
      type: 'code-dispatch';
      toolName: string;
      argsPreview: string;
      isError: boolean;
      resultPreview: string;
      at: number;
    }
  /**
   * Log-only measurement of one run (the same numbers the live `run_stats`
   * event carries). Timing and throughput are the ONLY per-turn facts a reader
   * cannot re-derive from the messages, and they are measured once, in the run
   * loop — so without this record every resumed session would lose its per-turn
   * rows and its session totals. Never joins the model surface.
   */
  | {
      type: 'run/stats';
      stats: RunStats;
      /**
       * Id of the message the run ended on (the row anchor: the surface draws
       * these numbers right after that message). Absent when the run appended
       * no message at all — there is then nothing to anchor to.
       */
      afterMessageId?: string;
      at: number;
    };


/**
 * Append-only JSONL session event log. v1 files (bare message lines) are
 * atomically upgraded to v2 on open; everything after that is v2-only.
 */
export class Session {
  readonly file: string;
  readonly id: string;
  readonly createdAt: number;
  /** Full loaded event stream; appended events land here and in the file. */
  readonly events: SessionEvent[] = [];
  /** Non-fatal problems noticed on open (e.g. orphaned compaction lock). */
  readonly warnings: string[] = [];
  /**
   * Set once the session is closed (the surface deleted or replaced it).
   *
   * Closing must SEAL the log, not merely stop reading it: `appendFile` creates
   * a missing file, so a session whose log was deleted while a run was still in
   * flight would resurrect it on the next commit — a log holding only the events
   * logged after the delete. `appendEvent` therefore refuses once sealed, which
   * makes "the delete was the last word on this log" a property of the store
   * rather than something each surface has to remember at the right moment.
   */
  private sealed = false;
  /**
   * Serializes appends. The log is an ORDERED stream, and two concurrent
   * `appendEvent` calls would otherwise race their `appendFile` writes — the
   * file could hold them in one order and `events` in another. Chaining every
   * write through one promise makes "the order callers asked for" the order on
   * disk and in memory.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  private constructor(file: string, id: string, createdAt: number, events: SessionEvent[], warnings: string[]) {
    this.file = file;
    this.id = id;
    this.createdAt = createdAt;
    this.events.push(...events);
    this.warnings.push(...warnings);
  }

  static async create(dir: string, id: string = newId('sess')): Promise<Session> {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    const createdAt = Date.now();
    const header: SessionHeader = { type: 'session', v: SESSION_VERSION, id, createdAt };
    await appendFile(file, `${JSON.stringify(header)}\n`, 'utf8');
    return new Session(file, id, createdAt, [], []);
  }

  static async open(file: string): Promise<Session> {
    const { header, events, warnings } = await readEvents(file, { repairTail: true });
    if (header.v < SESSION_VERSION) {
      await upgradeToV2(file, header, events);
    }
    if (findOrphanCompaction(events) !== -1) {
      warnings.push('检测到未完成的压缩（孤儿锁）：该次压缩被丢弃，历史消息保持完整。');
    }
    return new Session(file, header.id, header.createdAt, events, warnings);
  }

  /** Current header format version (v1 files report 2 after in-memory upgrade). */
  get version(): number {
    return SESSION_VERSION;
  }

  /** True while a compaction is open without its closing compaction/end. */
  get hasOpenCompaction(): boolean {
    return findOrphanCompaction(this.events) !== -1;
  }

  /**
   * Append one raw event; returns its seq (index in the event stream).
   *
   * Rejects once the session is closed (see `sealed`). Callers that append
   * best-effort already swallow the rejection; a caller that does not gets an
   * error instead of a recreated log, which is the honest outcome.
   */
  async appendEvent(evt: SessionEvent): Promise<number> {
    if (this.sealed) throw new Error('session is closed; the log was sealed and cannot be appended');
    const run = this.writeChain.then(async () => {
      // Re-checked INSIDE the critical section: a `seal()` that landed while
      // this write was queued must win. Without it a disposed session could
      // still append — the exact resurrection `seal()` exists to prevent, just
      // one microtask later.
      if (this.sealed) throw new Error('session is closed; the log was sealed and cannot be appended');
      // Disk first, memory second: if the write throws (full disk, killed
      // mid-flush), in-memory state still matches what a resume will replay
      // instead of diverging with a phantom event that never hit the log.
      await appendFile(this.file, `${JSON.stringify(evt)}\n`, 'utf8');
      this.events.push(evt);
      return this.events.length - 1;
    });
    // The chain must survive a rejected write, or every later append inherits
    // the failure.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Wait for every queued append to settle. Used by `dispose` so a closed
   * session has no write still in flight; it never rejects (the chain swallows
   * failures, which the original caller already saw).
   */
  async drain(): Promise<void> {
    await this.writeChain;
  }

  /**
   * Seal the log: no further append will ever reach this file.
   *
   * Called when the owning session is closed. Idempotent, and deliberately not
   * reversible — reopening a deleted log is exactly the bug this prevents.
   */
  seal(): void {
    this.sealed = true;
  }

  /** Whether the log is sealed (see `seal`). */
  get isSealed(): boolean {
    return this.sealed;
  }

  /** Sugar for appending a model-visible message event. */
  async append(message: AgentMessage): Promise<void> {
    await this.appendEvent({ type: 'message', message });
  }

  /** Every message event ever logged, in order (NOT the model surface). */
  allMessages(): AgentMessage[] {
    return this.events.filter((evt): evt is Extract<SessionEvent, { type: 'message' }> => evt.type === 'message').map(
      (evt) => evt.message,
    );
  }

  /**
   * Project the model-visible surface from the log. An UNCLOSED compaction is
   * discarded — only that transaction: its summary never committed. Every
   * message written after the crash stays (the old slice-at-orphan dropped it).
   */
  deriveMessages(): AgentMessage[] {
    const orphan = findOrphanCompaction(this.events);

    const all: AgentMessage[] = [];
    let surface: AgentMessage[] = [];
    for (let i = 0; i < this.events.length; i++) {
      const evt = this.events[i]!;
      if (evt.type === 'message') {
        all.push(evt.message);
        surface.push(evt.message);
        continue;
      }
      if (evt.type === 'compaction/summary') {
        // Skip a summary that belongs to the unclosed compaction; apply the
        // ones from earlier, properly-closed compactions.
        if (orphan !== -1 && i > orphan) continue;
        // Replace the whole surface: kept originals (context fragment, recent
        // user messages) plus the synthesized summary message — the SAME
        // construction the live compaction path uses (compactionSurface).
        surface = compactionSurface(evt, all, i);
      }
    }
    return surface;
  }

  /** Latest durable todo snapshot, or undefined when none was written. */
  latestTodos(): TodoItem[] | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const evt = this.events[i]!;
      if (evt.type === 'todo/write') return evt.todos;
    }
    return undefined;
  }

  /**
   * Latest durable goal snapshot, or undefined when none was ever written.
   *
   * Same shape as `latestTodos` above because the two are the same mechanism: the
   * goal is a log-only event carrying the WHOLE value (last write wins), so a
   * resume restores the panel without a separate store. A `goal/change` whose
   * `goal` is `null` records a CLEAR — it returns undefined, which is exactly what
   * "no goal" means, so a cleared goal and a never-set goal read alike.
   */
  latestGoal(): Goal | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const evt = this.events[i]!;
      if (evt.type === 'goal/change') return evt.goal ?? undefined;
    }
    return undefined;
  }

  /**
   * One-shot read helper (tests / audit tooling): open a log file and return
   * its header plus the raw message stream — NOT the projected surface (use
   * `open()` + `deriveMessages()` for that).
   */
  static async replay(file: string): Promise<{ header: SessionHeader; messages: AgentMessage[] }> {
    const { header, events } = await readEvents(file);
    const messages: AgentMessage[] = [];
    for (const evt of events) {
      if (evt.type === 'message') messages.push(evt.message);
    }
    return { header, messages };
  }
}
