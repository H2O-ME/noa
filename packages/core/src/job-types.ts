/**
 * What a background job IS: its shapes, the one ownership rule, and the
 * model-facing rendering of a finished job.
 *
 * Split from `jobs.ts` (which owns the registry) because the two answer
 * different questions. This file is pure data and pure functions — no registry,
 * no lifecycle, no I/O — so it can be imported by a surface that only needs to
 * read a snapshot, and by `ai`/`web` without dragging the runtime in. The
 * ownership rule lives here rather than in the registry because it is a fact
 * about the DATA (which session a job belongs to), and the registry is only its
 * first consumer; the kernel's live `job_update` listener is the second.
 */
export type JobKind = 'bash' | 'subagent';

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  /** One-line model-facing label (the command, the delegation description). */
  label: string;
  status: JobStatus;
  /** Producer-specific detail rendered into status lines ('exit code: 3'). */
  detail?: string;
  /** Wall-clock start (ms epoch); UIs derive elapsed time from it. */
  startedAt?: number;
  /**
   * Wall-clock settle (ms epoch), set when the producer's outcome lands.
   *
   * A surface that lists finished jobs orders them by this (newest first) and
   * renders their duration as `finishedAt - startedAt`; without it, a settled
   * row's elapsed time keeps growing on every repaint and the ordering has
   * nothing to sort on but the start times of work that may have begun long
   * before it ended.
   */
  finishedAt?: number;
  /** Latest activity line sampled from the producer (UI live rows). */
  progress?: string;
  /**
   * The session that started this job.
   *
   * Load-bearing, not decorative: the registry is per-PROCESS (a job must
   * outlive the turn that spawned it, and survives a session switch), so
   * without an owner every session's surface would list every other session's
   * jobs. A surface filters on this; the model-facing `jobs` tool reads the
   * caller's own session, so it never sees a foreign job either.
   */
  sessionId: string;
}

export interface JobOutcome {
  status: 'completed' | 'killed' | 'failed';
  detail?: string;
}

/**
 * A job that reached a natural terminal state and has not yet been announced.
 * `killed` is deliberately absent: that outcome only ever follows an explicit
 * `stop()`/dispose (the model already knows, or the session is over), so there
 * is nothing to announce. Consumers drain these and inject them into the next
 * LLM request, replacing the need for the model to poll `jobs output`.
 */
export interface JobNotice {
  id: string;
  kind: JobKind;
  label: string;
  status: 'completed' | 'failed';
  detail?: string;
  /**
   * The session that owns this job.
   *
   * Carried so the notice reaches the conversation that started the work and no
   * other: the queue is per-registry (per process), and draining it from every
   * session would tell a conversation about a job it never ran.
   */
  sessionId: string;
}

export interface JobStart {
  kind: JobKind;
  label: string;
  /**
   * The session that owns the job. REQUIRED, because an unowned job on a
   * per-process registry is exactly the leak this field exists to prevent: it
   * would be listed by every session and announced into whichever one happened
   * to be open when it finished.
   */
  sessionId: string;
  /** Hard cap on the bytes retained in the output ring per job. */
  outputLimitBytes?: number;
  /** Request termination. Must be synchronous and idempotent. */
  cancel(reason?: string): void;
  /**
   * Resolves after the producer releases its resources (not merely when work
   * finishes); the registry converts the settled outcome into final status.
   */
  done: Promise<JobOutcome>;
  /** Consume output produced since the previous call; absence marks a final-output-only job. */
  readOutput?(): string;
  /**
   * One-line latest-activity sample for UI live rows, read FRESH on every
   * snapshot (list/get). Unlike readOutput this is a peek: it never drains
   * the model-facing output cursor.
   */
  progress?(): string | undefined;
}

/** A registered job: the snapshot's fields plus the live producer handles. */
export interface JobEntry extends Omit<JobSnapshot, 'progress'> {
  outputLimitBytes?: number;
  cancel: (reason?: string) => void;
  readOutput?(): string;
  /** Accessor form on the entry; snapshots carry the sampled string. */
  progress?(): string | undefined;
  done: Promise<JobOutcome>;
}

export const DEFAULT_JOB_OUTPUT_LIMIT = 256 * 1024;

/**
 * Whether a job update belongs to the asking session.
 *
 * Exported because the routing decision is needed OUTSIDE the registry too: the
 * kernel's `job_update` listener resolves "which session is current" and must
 * drop an announcement whose owner is not that session. Keeping one predicate
 * means the registry's reads and the live listener can never disagree about who
 * owns what.
 *
 * An UNOWNED job (`sessionId` missing or `''`) belongs to every caller. That is
 * the fail-open choice, and it is deliberate: only a third-party tool that never
 * passed an owner can produce one, and hiding it would leave the job running
 * invisibly — its row unrendered, its completion notice undelivered — which
 * loses the work outright. Showing it everywhere is noisy; hiding it is broken.
 * @param job - the entry or notice to test.
 * @param sessionId - the asking session, or undefined for a process-wide read.
 */
export function jobBelongsTo(job: { sessionId: string | undefined }, sessionId: string | undefined): boolean {
  if (sessionId === undefined) return true;
  // `''` and a missing owner are the SAME fact ("nobody claimed this") and both
  // fail open. The type requires the field, but the registry is public API that a
  // third-party plugin may call from plain JavaScript, so the runtime check
  // cannot lean on the compiler.
  return job.sessionId === undefined || job.sessionId === '' || job.sessionId === sessionId;
}

/** One live entry → the immutable shape a surface or the model reads. */
export function snapshotOf(entry: JobEntry): JobSnapshot {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    status: entry.status,
    // Carried so a snapshot is self-describing: the live `job_update` listener
    // routes on it, and a surface that receives one can tell whose it is.
    sessionId: entry.sessionId,
    startedAt: entry.startedAt,
    ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.progress !== undefined ? { progress: entry.progress() } : {}),
  };
}

/** Cap for a job label inside a notice: the raw command can be very long. */
const JOB_NOTICE_LABEL_MAX = 80;

/**
 * One model-facing body per drain: a line per finished job in the same shape
 * as the `jobs` tool's list rows (`- bash-1 [completed] sleep 10 (exit code:
 * 0)`), so the injected notice reads like tool output the model already knows.
 * Output itself stays behind the `jobs output` cursor — the notice only says
 * a job is done, keeping the context lean.
 */
export function formatJobNotices(notices: JobNotice[]): string {
  const body = notices
    .map((n) => {
      const label = n.label.length > JOB_NOTICE_LABEL_MAX ? `${n.label.slice(0, JOB_NOTICE_LABEL_MAX - 1)}…` : n.label;
      const detail = n.detail !== undefined ? ` (${n.detail})` : '';
      return `- ${n.id} [${n.status}] ${label}${detail}`;
    })
    .join('\n');
  return [
    `Background job${notices.length === 1 ? '' : 's'} finished:`,
    body,
    'Read the output with the jobs tool (action=output, id=<id>) as needed.',
  ].join('\n');
}
