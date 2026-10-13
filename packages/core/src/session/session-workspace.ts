/**
 * The log-only `workspace` marker: which directory a session belongs to.
 *
 * Split from `session-index.ts` (the catalog API) because the two answer
 * different questions for different readers: a listing asks "what sessions
 * exist" and changes with the enumeration contract, while these three ask
 * "where does this session live" and change with the log's marker format.
 *
 * The marker never joins the model surface — it exists so a session switch can
 * re-point the tool roots at the directory the session was created in.
 */
import type { Session } from '../session.js';

/**
 * Append the log-only workspace marker so a later session switch can re-point
 * the tools at the workspace the session was created in.
 */
export async function recordSessionWorkspace(session: Session, rootDir: string): Promise<void> {
  await session.appendEvent({ type: 'workspace', path: rootDir, at: Date.now() });
}

/**
 * Point an open session at a new workspace, recording it only when the log does
 * not already name that directory.
 *
 * A surface files a session by the NEWEST marker in its log, so a session still
 * running in a new directory while its log names the old one is listed under a
 * workspace it left. The skip matters for the common case: resuming re-points
 * the tools at the workspace the session recorded, which must not append a line
 * on every switch.
 */
export async function moveSessionWorkspace(session: Session, rootDir: string): Promise<void> {
  if (sessionWorkspace(session) !== rootDir) await recordSessionWorkspace(session, rootDir);
}

/**
 * The workspace a session belongs to: the newest `workspace` marker in the
 * log; sessions created before the marker existed fall back to the `cwd=`
 * line of their seeded `<environment>` fragment.
 */
export function sessionWorkspace(session: Session): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const evt = session.events[i];
    if (evt !== undefined && evt.type === 'workspace') return evt.path;
  }
  for (const msg of session.allMessages()) {
    if (msg.role !== 'user' || !msg.content.startsWith('<environment>')) continue;
    const match = /^cwd=(.+)$/m.exec(msg.content);
    return match?.[1]?.trim();
  }
  return undefined;
}
