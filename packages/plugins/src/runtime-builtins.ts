/**
 * The built-in CANDIDATES for one host build: every first-party plugin this
 * kernel could load, with the config expansion done exactly once.
 *
 * Split from `runtime-roster.ts` because the two answer different questions.
 * This module answers "how are `BuiltinOptions` derived from config + live
 * state"; the roster answers "which rows are in force" (from the plugins' own
 * manifests) and hands them to the loader.
 *
 * The optional PACKAGES (subagent / context / ptc / qqbot) are NOT here: they
 * live in their own packages and load by specifier (`plugin-tree.ts`), so this
 * file is the in-process base tree and nothing in it needs a module that could
 * be absent.
 *
 * ## Row config
 *
 * A built-in's settings come from ITS entry in `plugins.entries` (`config`), not
 * from a kernel-shaped field: the kernel does not know that bash has a timeout.
 * Only the two built-ins that actually take settings read one here, and the
 * roster rebuilds this list only when one of those settings CHANGES — otherwise
 * the loader would see new plugin objects on every roster and reload every row.
 */
import { sessions as sessionsKey, spill as spillKey, userQuestions as userQuestionsKey } from '@noa/core';
import type { Plugin } from '@noa/core';
import { builtinPlugins } from './builtin/index.js';
import type { CreateKernelOptions } from './runtime-types.js';
import type { Environment } from './runtime-env.js';

/**
 * Every built-in plugin this build could load, in load order.
 *
 * ## No cache key, and no list of names
 *
 * The in-process plugins are built ONCE and reused for the kernel's lifetime.
 * They used to be rebuilt whenever a fingerprint of a hand-kept list of
 * "configurable" plugin names changed (`CONFIGURED_BUILTINS`) — because each
 * configurable builtin received its settings as constructor arguments. That put
 * a list of plugin names in host code whose only job was to know when to
 * rebuild, and it made "add a configurable setting" a host change.
 *
 * Settings now reach the plugin the way they reach a third-party one: through
 * the row's own `config`, validated by the plugin's own `Config` schema and
 * handed to `apply(ctx, config)`. The loader already diffs on config, so an
 * edited setting re-runs exactly that row's body and nothing else — no
 * fingerprint, no name list, and a stable plugin object per row (which is what
 * keeps a workspace switch from replacing every row).
 *
 * `BuiltinOptions` derivation still lives here and nowhere else: kernel facts
 * are always supplied so the base tree is unconditional, and "may this row run"
 * is decided in ONE place (`plugin-tree.ts`, from the plugin's own manifest and
 * the operator's entry) — two answerers would drift.
 * @param env - the live environment.
 * @param opts - the assembly options.
 * @returns the built-in plugins, ready for the loader.
 */
export function kernelPlugins(env: Environment, opts: CreateKernelOptions): Plugin[] {
  return builtinPlugins({
    // The live root, not a snapshot: `switch_workspace` re-points it and every
    // workspace-bound tool must grade against the directory now in force.
    rootDir: () => env.state.rootDir,
    // Read LAZILY, through the container: the spill directory is provided by a
    // row of the tree, and this function builds the tree — so an eager read asks
    // a store that is empty by construction and throws `ServiceUnavailable`
    // before the providing row has ever run. `read` (not `must`) because a
    // kernel may legitimately have no spill provider; an absent one then simply
    // contributes no trusted root.
    trustedReadRoots: () => {
      const spill = env.root.get(spillKey);
      return spill === undefined ? [] : [spill.dir()];
    },
    ...(opts.workspace !== undefined ? { workspace: opts.workspace } : {}),
    // NOTE: no `bash` / `search` here. Each configurable builtin owns its own
    // `Config` schema and reads its row's settings in `apply(ctx, config)`.
    // Read through the container, lazily (see `userQuestions` in core's
    // capabilities and `userQuestionsProvider`): "can this surface ask a human?"
    // is a SERVICE, so a surface declares it instead of every assembly site
    // hand-copying a boolean. The service is authoritative for surfaces loaded
    // from config (they register in the surface registry).
    //
    // `opts.userQuestions` remains the explicit input for assemblies with no
    // surface registry (kernel tests, embedders): the registry's recorded
    // winner is the primary source for every cli surface (built-in and
    // configured alike — see `cli/src/surface-host.ts`). NEITHER supplying an
    // answerer means nobody can answer: the fail-closed end, where the tool
    // reports NO_PROVIDER instead of parking a run no card can release.
    askUser: {
      ask: (sessionId) => {
        // The conversation that asked owns the question: its broker parks ITS
        // run and its own surface answers over ITS event stream. Routing this
        // through a kernel-wide broker put A's question card on B — and, in the
        // browser case, put a bot peer's question on a stream no human follows.
        const session = sessionId === undefined ? undefined : env.root.get(sessionsKey)?.get(sessionId);
        if (session !== undefined) {
          return session.answersQuestions ? session.questions.asker : undefined;
        }
        // No session (an embedder driving the loop directly): the assembly-level
        // seam answers, and the surface in force decides whether anyone can.
        if (opts.userQuestions === true) return env.questions.asker;
        return env.root.get(userQuestionsKey)?.answerer();
      },
    },
    // The goal's live value is a SESSION fact (the log is its only store), and a
    // plugin's `apply(ctx)` has no session handle, so it is wired at the
    // assembly point like the feed above. `current` is a getter, not a snapshot:
    // the continuation hook runs per request and must see the current goal.
    goal: {
      current: () => env.root.get(sessionsKey)?.current()?.session.latestGoal() ?? null,
      // Through the session's own announce path, not a raw `appendEvent`: one
      // door keeps "logged" and "published" from drifting apart.
      write: (goal) => { env.root.get(sessionsKey)?.current()?.announceGoal(goal); },
    },
  });
}
