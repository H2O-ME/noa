import { type Plugin } from '@noa/core';
import { askUserPlugin, type AskUserPluginOptions } from './ask-user.js';
import { bashPlugin } from './bash.js';
import { fsReadPlugin, fsWritePlugin } from './fs.js';
import { goalPlugin, type GoalPluginOptions } from './goal.js';
import { jobsPlugin } from './jobs.js';
import { searchPlugin } from './search.js';
import { todoPlugin } from './todo.js';
import { workspacePlugin, type WorkspacePluginOptions } from './workspace.js';

export { askUserPlugin, parseQuestions, type AskUserPluginOptions } from './ask-user.js';

export interface BuiltinOptions {
  /**
   * The LIVE workspace root every workspace-bound tool grades against. A thunk
   * for the same reason `workspace.onChange` is a callback: `switch_workspace`
   * re-points the root mid-session, and a tool holding the boot value would keep
   * reading and writing the directory the session has already left.
   */
  rootDir: () => string;
  /**
   * The auto-readable roots outside the workspace, as ONE live list.
   *
   * A thunk, not an array, because a root can come from a service: the spill
   * directory is provided by a row of the plugin tree, and the built-ins are
   * constructed BEFORE that tree loads. Reading it eagerly would ask a store that
   * is still empty by construction — which is exactly the `ServiceUnavailable`
   * crash this thunk prevents. The spill root is an ordinary member of the list,
   * not a special case of it, so fs and search both receive one array.
   */
  trustedReadRoots?: () => readonly string[];
  /**
   * The model's question tool. Always registered — a surface with no human to ask
   * gets the typed `NO_PROVIDER` refusal rather than a silently missing tool, so
   * the model learns the difference instead of guessing — but the answerer itself
   * comes from the `userQuestions` container service, which the surface in force
   * decides.
   */
  askUser?: AskUserPluginOptions;
  /**
   * The durable goal: its live reader and its log writer.
   *
   * Required for the goal tools to exist, and wired at the ASSEMBLY point because
   * the goal lives in the session log, which is a kernel fact rather than a tool
   * option. Omitted ⇒ no goal plugin, which is honest — a surface with no session
   * cannot persist one.
   */
  goal?: GoalPluginOptions;
  /**
   * Wires the model-facing `switch_workspace` tool. The tool is registered only
   * when a runner-side callback is supplied, because without one it would
   * validate a switch and then silently do nothing — worse than absent.
   */
  workspace?: WorkspacePluginOptions;
}

/**
 * First-party tool plugins; loaded through the same API as third-party ones.
 *
 * Every row here is unconditional: whether it LOADS is the operator's entry in
 * the plugin tree (`{ id, enabled }`), not an option of this function. A
 * built-in is therefore always buildable, and the loader is the only thing that
 * decides if it runs.
 * @param options - the build's options (live kernel facts and row settings).
 * @returns the built-in plugins, in load order.
 */
export function builtinPlugins(options: BuiltinOptions): Plugin[] {
  const rootDir = options.rootDir;
  // Filtered at READ time, not here: an empty root would match every path, and
  // the list is live so "which roots are in force" is only known per call.
  const trustedReadRoots = (): readonly string[] =>
    (options.trustedReadRoots?.() ?? []).filter((root) => root.length > 0);
  const plugins: Plugin[] = [
    fsReadPlugin({ trustedReadRoots, rootDir }),
    fsWritePlugin({ rootDir }),
    searchPlugin({ trustedReadRoots, rootDir }),
    bashPlugin(),
    jobsPlugin(),
    todoPlugin(),
  ];
  // Present only when the assembly supplied a live-goal reader and a log writer
  // (see `BuiltinOptions.goal`): without them the tools could report a goal no
  // resume would ever recover.
  if (options.goal !== undefined) plugins.push(goalPlugin(options.goal));
  // Unconditional (see `BuiltinOptions.askUser`): the tool is the model's only
  // way to learn that this surface has no answerer.
  plugins.push(askUserPlugin(options.askUser ?? {}));
  const workspace = options.workspace;
  if (workspace !== undefined) {
    plugins.push(workspacePlugin(workspace));
  }
  // The optional PACKAGES (subagent / context / ptc) are NOT here: they load from
  // their own packages by specifier (see `plugin-tree.ts`), because they must be
  // absentable — this file is the in-process base tree.
  return plugins;
}
