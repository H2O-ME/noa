/**
 * The background-job REGISTRY: identity, lifecycle state, output cursors, and
 * the completion-notice queue (dsh jobs seam, reduced to one in-process registry
 * per process). Producers own execution resources.
 *
 * The job's SHAPES, the ownership rule and the notice text live in
 * `job-types.ts` — data and pure functions, so a surface that only reads a
 * snapshot does not have to import this runtime. The registry is one per
 * KERNEL, not per session (a job must outlive the turn that spawned it and
 * survives a session switch), which is exactly why every read here is scoped by
 * `sessionId`: an unscoped read is the cross-talk bug.
 */
import { errMessage } from './errors.js';
import {
  DEFAULT_JOB_OUTPUT_LIMIT,
  jobBelongsTo,
  snapshotOf,
  type JobEntry,
  type JobNotice,
  type JobSnapshot,
  type JobStart,
} from './job-types.js';
import { truncateUtf8Tail } from './utf8.js';

export class JobRegistry {
  private readonly jobs = new Map<string, JobEntry>();
  /** Terminal jobs (completed/failed) awaiting announcement; drainFinished consumes. */
  private pendingNotices: JobNotice[] = [];
  private counter = 0;
  /**
   * Live-transition listener (kernel `job_update` events). Fired on start,
   * settle and stop-request with a fresh snapshot; best-effort — a throwing
   * listener never corrupts job bookkeeping.
   */
  private listener: ((job: JobSnapshot) => void) | undefined;

  setListener(listener: ((job: JobSnapshot) => void) | undefined): void {
    this.listener = listener;
  }

  private announce(entry: JobEntry): void {
    if (this.listener === undefined) return;
    try {
      this.listener(snapshotOf(entry));
    } catch {
      // visibility is best-effort by contract
    }
  }

  /** Register a started job; returns its model-facing snapshot. */
  start(start: JobStart): JobSnapshot {
    this.counter += 1;
    const id = `${start.kind}-${this.counter}`;
    const entry: JobEntry = {
      id,
      kind: start.kind,
      label: start.label,
      status: 'running',
      startedAt: Date.now(),
      // Normalized at the boundary: a JavaScript caller that omits the owner
      // gets the documented fail-open `''`, not `undefined` (which the scoped
      // reads would treat as "belongs to nobody" and silently hide).
      sessionId: start.sessionId ?? '',
      ...(start.outputLimitBytes !== undefined ? { outputLimitBytes: start.outputLimitBytes } : {}),
      cancel: start.cancel,
      ...(start.readOutput !== undefined ? { readOutput: start.readOutput } : {}),
      ...(start.progress !== undefined ? { progress: start.progress } : {}),
      done: start.done,
    };
    this.jobs.set(id, entry);
    this.announce(entry);
    void start.done
      .then((outcome) => {
        // Natural completion/failure is announced once; a stop-initiated kill
        // (entry was 'stopping') is not — the caller already knows it stopped.
        if (entry.status !== 'stopping') {
          entry.status = outcome.status;
          if (outcome.status !== 'killed') {
            this.pendingNotices.push({
              id,
              kind: entry.kind,
              label: entry.label,
              status: outcome.status,
              sessionId: entry.sessionId,
              ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
            });
          }
        } else {
          entry.status = 'killed';
        }
        if (outcome.detail !== undefined) entry.detail = outcome.detail;
        entry.finishedAt = Date.now();
        this.announce(entry);
      })
      .catch((err: unknown) => {
        // A rejecting done promise is a producer bug (contract: never reject);
        // record failure instead of leaving the job stuck as running.
        entry.status = 'failed';
        entry.detail = errMessage(err);
        entry.finishedAt = Date.now();
        this.pendingNotices.push({
          id,
          kind: entry.kind,
          label: entry.label,
          status: 'failed',
          sessionId: entry.sessionId,
          detail: entry.detail,
        });
        this.announce(entry);
      });
    return snapshotOf(entry);
  }

  /**
   * Whether a job belongs to the asking session.
   *
   * The ONE ownership rule's local entry point, shared by `list` / `get` /
   * `readOutput` / `stop` / `drainFinished`; the exported `jobBelongsTo` is the
   * same function for callers outside the registry (the kernel's live listener).
   * @param entry - the registry entry (or notice) to test.
   * @param sessionId - the asking session, or undefined for a process-wide read.
   */
  private owns(entry: { sessionId: string }, sessionId: string | undefined): boolean {
    return jobBelongsTo(entry, sessionId);
  }

  /**
   * Every known job, or only one session's.
   *
   * `sessionId` is optional rather than required so the registry stays usable
   * for a process-wide audit; every SESSION-SCOPED caller (the handle's
   * `jobSnapshots`, the model's `jobs` tool) passes it, because a job list that
   * spans sessions is the cross-talk bug.
   * @param sessionId - restrict to the jobs this session owns.
   */
  list(sessionId?: string): JobSnapshot[] {
    const all = [...this.jobs.values()].filter((entry) => this.owns(entry, sessionId));
    return all.map(snapshotOf);
  }

  /**
   * One job by id, or `undefined` when it is unknown OR owned by another
   * session. Folding "not yours" into "not found" is deliberate: the caller is
   * always a session-scoped path, and distinguishing the two would let one
   * conversation probe another's job ids.
   * @param id - the job id.
   * @param sessionId - the asking session, or undefined for a process-wide read.
   */
  get(id: string, sessionId?: string): JobSnapshot | undefined {
    const entry = this.jobs.get(id);
    if (entry === undefined || !this.owns(entry, sessionId)) return undefined;
    return snapshotOf(entry);
  }

  /**
   * Consume and clear the terminal-job notices queued since the last call.
   * One drain = one announcement per job, UNLESS the carrying request dies
   * before the model acknowledges it (the runner requeues, making delivery
   * at-least-once). The runner calls this right before each LLM request and
   * injects the result.
   *
   * Notices for OTHER sessions stay queued: this registry is per-process, and
   * draining a foreign notice here would announce another conversation's job
   * into this one's model request.
   * @param sessionId - drain only the notices this session owns.
   */
  drainFinished(sessionId?: string): JobNotice[] {
    if (this.pendingNotices.length === 0) return [];
    if (sessionId === undefined) return this.pendingNotices.splice(0);
    const mine: JobNotice[] = [];
    const rest: JobNotice[] = [];
    for (const notice of this.pendingNotices) {
      (this.owns(notice, sessionId) ? mine : rest).push(notice);
    }
    this.pendingNotices = rest;
    return mine;
  }

  /**
   * Put notices back at the queue head when the request that carried them
   * failed or was aborted before its assistant reply was committed — the
   * model never got to act on them, so "drain-once" would silence the
   * announcement forever. A requeued batch announces at-least-once; a rare
   * duplicate costs one idle line, a lost one costs a stalled task.
   */
  requeue(notices: JobNotice[]): void {
    if (notices.length === 0) return;
    this.pendingNotices.unshift(...notices);
  }

  /**
   * Consume output produced since the previous call, with a per-read cap.
   * @param id - the job id.
   * @param maxBytes - retention cap for one read.
   * @param sessionId - the asking session; a foreign job reads as unknown.
   */
  readOutput(id: string, maxBytes = DEFAULT_JOB_OUTPUT_LIMIT, sessionId?: string): string | undefined {
    const entry = this.jobs.get(id);
    if (entry === undefined || !this.owns(entry, sessionId)) return undefined;
    if (entry.readOutput === undefined) return undefined;
    const text = entry.readOutput();
    // Tail-keep like the loop's truncation: recent output matters most.
    if (new TextEncoder().encode(text).length <= maxBytes) return text;
    return `…[earlier output dropped]\n${truncateUtf8Tail(text, maxBytes)}`;
  }

  /**
   * Request termination and wait for the producer to release its resources.
   * @param id - the job id.
   * @param reason - recorded cancellation reason.
   * @param sessionId - the asking session; a foreign job cannot be stopped here.
   */
  async stop(id: string, reason?: string, sessionId?: string): Promise<JobSnapshot | undefined> {
    const entry = this.jobs.get(id);
    if (entry === undefined || !this.owns(entry, sessionId)) return undefined;
    if (entry.status === 'running') {
      entry.status = 'stopping';
      this.announce(entry);
      entry.cancel(reason);
    }
    return snapshotOf(entry);
  }

  /**
   * Cancel only the jobs one session still owns and wait for their producers.
   *
   * Session teardown must not stop ANOTHER session's work: the registry is
   * per-process, and `dispose()` (everything) is the kernel's shutdown, not a
   * session's. This is what the handle calls when a session is closed.
   * @param sessionId - the session whose running jobs are cancelled.
   */
  async disposeSession(sessionId: string): Promise<void> {
    await this.cancelAll([...this.jobs.values()].filter((entry) => this.owns(entry, sessionId)));
  }

  /** Cancel everything and wait for all producers to settle (process teardown). */
  async dispose(): Promise<void> {
    await this.cancelAll([...this.jobs.values()]);
  }

  /**
   * Mark each running entry stopped and wait for its producer to let go.
   *
   * One implementation for `dispose` and `disposeSession`: the two differ only in
   * WHICH entries they select, and a second copy of the cancel-and-await loop is
   * where the two would drift (one forgetting to await, the other to announce).
   * @param entries - the entries to cancel.
   */
  private async cancelAll(entries: JobEntry[]): Promise<void> {
    for (const entry of entries) {
      if (entry.status === 'running') {
        entry.status = 'stopping';
        entry.cancel('session ended');
      }
    }
    await Promise.allSettled(entries.map((entry) => entry.done));
  }
}
