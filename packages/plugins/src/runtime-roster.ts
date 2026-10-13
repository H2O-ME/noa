/**
 * The roster: turn the desired plugin tree into loaded plugins.
 *
 * The heavy lifting lives elsewhere on purpose:
 *
 *  - `plugin-tree.ts` decides WHICH rows exist and whether each one is on,
 *    from the plugins' own manifests plus the operator's `plugins.entries`;
 *  - core's `PluginLoader` owns activation, diffing and teardown.
 *
 * What is left here is the one thing neither of them can know: how to build the
 * in-process plugins for THIS kernel (their options are bound to live kernel
 * facts), and which of them must be rebuilt when the workspace changes.
 *
 * ## Why the candidates are cached
 *
 * The loader diffs by PLUGIN IDENTITY: same object + same config = same
 * activation, so the fiber is kept. Rebuilding the built-in plugins on every
 * roster would therefore replace every row on every workspace switch — exactly
 * the rebuild-everything behaviour the entry tree exists to end. So the
 * in-process objects are built ONCE per kernel and cached on the environment;
 * their options read live state through thunks (`rootDir`, the skill list, the
 * goal reader) precisely so that caching them is correct.
 */
import {
  compaction as compactionKey,
  sessions as sessionsKey,
  type Plugin,
} from '@noa/core';
import { PluginHost, TOOLBOX_ENTRY_ID } from './host.js';
import { kernelCommandsPlugin } from './kernel-commands.js';
import { permissionGatePlugin } from './hooks.js';
import { kernelPlugins } from './runtime-builtins.js';
import { skillsPlugin } from './skills.js';
import { wrapHeadlessCompact } from './headless-compact.js';
import { buildTree, type PluginRow } from './plugin-tree.js';
import { surfacePlugin } from './surface-registry.js';
import type { CreateKernelOptions, PluginDescriptor, PluginRosterEntry } from './runtime-types.js';
import type { Environment } from './runtime-env.js';

/** (Re)build the tool host and load the tree for the current state. */
export function reroster(env: Environment, opts: CreateKernelOptions): Promise<void> {
  // One roster at a time. The body re-reads the operator's rows, re-scans the
  // workspace and then syncs the loader; two of those interleaved would let the
  // OLDER config snapshot be the one that syncs last, rolling the live tree back
  // to a state the file no longer describes.
  const run = env.state.rerosterQueue.then(
    () => runRoster(env, opts),
    () => runRoster(env, opts),
  );
  env.state.rerosterQueue = run.then(noop, noop);
  return run;
}

async function runRoster(env: Environment, opts: CreateKernelOptions): Promise<void> {
  const host = env.state.host ?? new PluginHost(env.state.rootDir, env.root);
  env.state.host = host;
  // The operator's rows are re-read from the document BEFORE the tree is built,
  // whenever this kernel has one to read. The file is the truth: a settings flip
  // wrote it, so the roster that follows the write must see the write. Building
  // from the assembly-time SNAPSHOT instead re-rostered the pre-flip tree, which
  // made every panel switch fail against its own stale answer — in both
  // directions, for every row.
  const live = opts.persist?.readPluginEntries;
  if (live !== undefined) env.state.pluginEntries = await live();
  // Docs + skills are re-read BEFORE the tree: the skills plugin is part of it
  // and the context fragment reads the same list.
  await env.loadWorkspace();
  const skills = env.state.skills;
  const builtins = [
    ...env.state.providers,
    ...cachedBuiltins(env, opts),
    ...surfaceRows(env, opts),
    cachedKernelCommands(env),
    ...(skills.length > 0 ? [skillsPlugin(skills)] : []),
    permissionGatePlugin,
  ];
  const rows = await buildTree(builtins, env.state.pluginEntries, opts);
  // Every row goes to the loader, switched-off ones included: `disabled` keeps
  // its place on the panel without creating a fiber, which is exactly what
  // "off" means. A row that could not even be IMPORTED has nothing to activate
  // and is left out — its reason is reported from the tree instead.
  await host.sync(rows.filter((row) => row.error === undefined).map((row) => row.options));
  // Published only AFTER the sync: `describePlugins` reads these rows against the
  // live loader, so handing them over before the fibers exist would report every
  // row as disabled/failed for the duration of the load.
  env.state.rows = rows;
  if (opts.config.autoCompactTokenLimit !== undefined && opts.perRequestCompact === true) {
    wrapHeadlessCompact(env.hooks(), {
      limit: opts.config.autoCompactTokenLimit,
      compact: (options) => env.root.must(compactionKey).run(options),
      client: env.provider,
      target: () => env.root.get(sessionsKey)?.current() ?? undefined,
      notice: (code, text) => env.root.get(sessionsKey)?.current()?.notice(code, text),
    });
  }
}

function noop(): void {}

/**
 * This build's in-process plugins, built ONCE for the kernel's lifetime.
 *
 * The loader diffs by plugin identity, so handing it freshly built objects on
 * every roster would replace every row on every workspace switch — exactly the
 * rebuild-everything behaviour the entry tree exists to end. Everything the
 * built-ins read (the workspace root, the trusted roots, the goal, the answerer)
 * is a live thunk over kernel state, and their own SETTINGS now arrive through
 * each row's `config` (`apply(ctx, config)`), which the loader diffs itself — so
 * a stable object per row is both correct and sufficient. There is no longer a
 * fingerprint to compare and no list of "configurable" plugin names to keep.
 */
function cachedBuiltins(env: Environment, opts: CreateKernelOptions): readonly Plugin[] {
  env.state.builtins ??= kernelPlugins(env, opts);
  return env.state.builtins;
}

/** The kernel's own slash commands: bound to live registries, so also reused. */
function cachedKernelCommands(env: Environment): Plugin {
  env.state.kernelCommands ??= kernelCommandsPlugin(env);
  return env.state.kernelCommands;
}

/**
 * The configured surfaces, wrapped as ordinary plugin rows.
 *
 * EVERY loaded surface gets a row, switched-off ones included: the row is what
 * the panel draws and what the operator switches back on, so dropping a closed
 * surface here would hide it forever. Whether the row is ON is decided by the
 * tree from the operator's `plugins.entries` (core's `rowEnabled`), and a closed
 * row creates no fiber — so its `apply` never runs and it never re-registers
 * itself onto the registry. An OPEN row does register the same instance again
 * (the shell already put it there before this kernel existed); the registry
 * absorbs that by identity, so `all()` lists the surface once and its
 * precedence slot stays where the shell put it. Disposal therefore cannot
 * unseat a surface that already resolved and started this invocation — a row
 * flip takes effect on the NEXT start, for the serving surface and for any
 * other alike.
 *
 * Cached per surface object for the same identity reason as the built-ins: the
 * loader must see the SAME row plugin across rosters, or a workspace switch
 * would unregister and re-register the surface registry on every move.
 */
export function surfaceRows(env: Environment, opts: CreateKernelOptions): readonly Plugin[] {
  const rows = opts.surfaces;
  if (rows === undefined) return [];
  env.state.surfacePlugins ??= rows.loaded.map((surface) => surfacePlugin(surface, rows.registry));
  return env.state.surfacePlugins;
}

/**
 * Every known row, loaded or not, as the management panel reads it.
 *
 * A switched-off or unloadable row has no fiber, so its row comes from the tree
 * the roster built — build this from the LIVE plugins instead and a turned-off
 * plugin would vanish from the very page that turns it back on.
 *
 * The live half is read from the LOADER by row id, not from `root.roster()`.
 * Those two keyings differ for every spec-loaded package: the container knows a
 * fiber by the plugin's own `name` (`context`), while the ROW — the thing the
 * operator's config names, switches, and reads errors from — is keyed by the
 * entry id (`@noa/plugin-context`). Matching on the container's key made
 * an active plugin report `disabled`, which then hid its settings page (nav is
 * derived from `page && enabled`) and made its switch unverifiable.
 * @param env - the live environment.
 * @returns one entry per row, with its live container state when it has one.
 */
export function describePlugins(env: Environment): PluginRosterEntry[] {
  return env.state.rows.map((row) => {
    const live = env.state.host?.entry(row.id);
    const fiber = live?.fiber;
    // A row can fail twice over: the module never imported (the tree knows) or
    // the body threw while applying (the loader knows). Both are the same fact to
    // the operator, and the loader's answer is the live one — a plugin that
    // started failing on a reload must not keep reporting its boot-time reason.
    const error = live?.error ?? row.error;
    const base: PluginDescriptor = {
      name: row.id,
      origin: row.origin,
      tier: row.manifest.tier,
      // `manifestOf` copies a DECLARED manifest through verbatim, so neither
      // field below may be assumed present. `title` is a slot every row fills, so
      // it falls back to the row id — the same fallback `manifestOf` applies to a
      // plugin with no manifest at all. `description` is a SUPPLEMENT, not a slot,
      // so a missing one stays ABSENT (the `clientBundle` discipline below), and
      // the guard keeps its pre-refactor form because the declared `string` is a
      // promise the runtime cannot hold a JS plugin to.
      title: row.manifest.title ?? row.id,
      ...(row.manifest.description !== undefined && row.manifest.description.length > 0 ? { description: row.manifest.description } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(row.manifest.page === true ? { page: true } : {}),
      // The boot graph's producer half: a plugin that declares a browser bundle
      // is copied through verbatim, and one that declares none keeps the field
      // ABSENT. `undefined` would be the same JSON on the wire but a different
      // fact for every reader that asks `'clientBundle' in row`.
      ...(row.manifest.clientBundle !== undefined ? { clientBundle: row.manifest.clientBundle } : {}),
    };
    if (fiber === undefined) {
      // An enabled row with no fiber is FAILED, not off: the panel's failed
      // treatment (group count, sort-to-top, 失败 label) is what the reader
      // needs, with `error` saying why.
      return {
        ...base,
        state: error !== undefined ? 'failed' : 'disabled',
        inject: [],
        enabled: false,
      };
    }
    return {
      ...base,
      state: fiber.state,
      inject: fiber.inject,
      enabled: true,
    };
  });
}

/** One row's tree entry, for callers that need the plugin object (surfaces). */
export function rowOf(env: Environment, id: string): PluginRow | undefined {
  if (id === TOOLBOX_ENTRY_ID) return undefined;
  return env.state.rows.find((row) => row.id === id);
}

/** The toolbox is not a configurable row; expose its id so callers can skip it. */
export { TOOLBOX_ENTRY_ID };
