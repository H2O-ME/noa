/**
 * Moving the kernel's workspace: keeping the session log and the seeded context
 * fragment in agreement with the tool root.
 *
 * Its own module because the fragment is append-only, so a move has to decide
 * whether the CURRENT session still tells the truth about where it runs. Every
 * surface's move path (the Web `set_workspace` frame, the REPL's model-facing
 * `switch_workspace` tool, any future one) comes through here.
 */
import {
  isBlankSession,
  moveSessionWorkspace,
  sessions as sessionsKey,
  sessionWorkspace,
} from '@noa/core';
import type { SkillMetadata } from './skills.js';
import type { Environment } from './runtime-env.js';

/**
 * Re-point the tool root, the docs and the skills at `dir`, and keep the live
 * session consistent with the move: the re-roster reloads the AGENTS.md chain
 * and skill index, the `workspace` marker is appended (a surface files a session
 * by the NEWEST marker in its log; log-only, so the model surface is untouched),
 * and a session nobody has spoken to yet is replaced so its first prompt builds
 * a fragment naming the new workspace.
 *
 * That last step is why this is shared code. The fragment is appended ONCE, at
 * session creation, so leaving a just-moved blank session alone would send the
 * OLD cwd and AGENTS.md chain on its first prompt. Only a blank session may be
 * replaced — `isBlankSession` means no user has spoken, so nothing is lost; one
 * with real turns keeps its fragment, which truthfully records where it ran.
 * A session already belonging to `dir` (the resume path) is not re-seeded: its
 * log is a durable artifact the reader chose to open, and replacing it would
 * discard that choice.
 * @param env - the assembled kernel environment.
 * @param dir - the new workspace root.
 * @returns the skills loaded for the new root.
 */
export async function setWorkspace(env: Environment, dir: string): Promise<SkillMetadata[]> {
  const moved = dir !== env.state.rootDir;
  env.state.rootDir = dir;
  await env.reroster();
  const current = env.root.get(sessionsKey)?.current();
  if (current !== undefined) {
    // Read BEFORE appending this move's marker: a session that already belongs
    // to `dir` (the resume path) needs no re-seed. This is the same read the
    // marker step itself uses, so "where does this session live" has one rule.
    const belonged = sessionWorkspace(current.session) === dir;
    await moveSessionWorkspace(current.session, dir);
    if (moved && !belonged && isBlankSession(current.messages)) await env.openCurrent();
  }
  return env.state.skills;
}
