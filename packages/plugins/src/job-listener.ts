/**
 * The `job_update` listener: which session a background job's updates reach.
 *
 * Its own module because it is the one piece of the kernel's job wiring that is
 * neither a session-open concern nor part of the environment's construction — it
 * is a ROUTING rule, and the fixing of a real cross-talk bug (a job started in
 * one session announcing itself into another after a switch). Keeping it in its
 * own file means the rule is readable in one place instead of being a footnote in
 * whichever module happened to grow too long.
 */
import { jobBelongsTo, sessions as sessionsKey, type JobSnapshot } from '@noa/core';
import type { Environment } from './runtime-env.js';
/**
 * The `job_update` listener, built once so every path that re-binds it (a new
 * session, a switch) routes by the same rule.
 *
 * The registry is per-PROCESS — a job must outlive the turn that spawned it, and
 * survives a session switch — so "which session is current" has to be resolved
 * at ANNOUNCE time, not at registration time. Two consequences, both handled
 * here rather than by the caller:
 *
 * 1. Resolving per announce is why a listener bound to one session at creation
 *    was wrong: after a switch it would keep publishing into the session the
 *    user left.
 * 2. The job must ALSO belong to the session that is now current. Otherwise a
 *    job started in A announces itself into B the moment the user switches,
 *    and B's transcript grows a row for work it never asked for. A job that is
 *    not current is not lost: its row is rebuilt from `jobSnapshots()` on the
 *    next `ready`, which is the same contract the transcript uses.
 * @param env - the kernel environment (the registry and the sessions provider).
 * @returns the listener to hand to `jobs.setListener`.
 */
export function jobListener(env: Environment): (job: JobSnapshot) => void {
  return (job) => {
    const session = env.root.get(sessionsKey)?.current();
    if (session === undefined) return;
    if (!jobBelongsTo(job, session.session.id)) return;
    session.observeJob(job);
  };
}
