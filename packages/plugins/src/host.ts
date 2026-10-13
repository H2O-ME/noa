/**
 * `PluginHost` — the kernel's view of the plugin tree.
 *
 * There is ONE plugin protocol: core's `Plugin`
 * (`{ name, manifest?, Config?, inject?, apply(ctx, config) }`), the same shape
 * the container loads and the same shape a third-party module exports. Lifecycle
 * belongs to `PluginLoader` (core), which reconciles a tree of stable entries.
 *
 * This class is a thin projection: it owns the shared root `Context` and the
 * loader, provides the loader AS a service (so a plugin can add, restart and drop
 * rows itself), and exposes the registries the loop and the surfaces read. It
 * owns no activation logic of its own — an entry that is not in the tree is not
 * loaded, and a disabled entry starts nothing.
 */
import {
  commands as commandsKey,
  loader as loaderKey,
  tools as toolsKey,
  Context,
  PluginLoader,
  type AgentHooks,
  type CommandEntry,
  type PluginEntry,
  type PluginEntryOptions,
  type ToolDefinition,
  type ToolEntry,
  type ToolPermissionKind,
} from '@noa/core';
import { composeHooks } from './hooks.js';
import { toolboxPlugin } from './toolbox.js';

/** The registry every plugin registers into: always the first row of the tree. */
export const TOOLBOX_ENTRY_ID = 'toolbox';

export class PluginHost {
  /** The container this host speaks for — the kernel shares this root. */
  readonly context: Context;
  private readonly loader: PluginLoader;

  constructor(
    readonly rootDir: string,
    context?: Context,
  ) {
    this.context = context ?? Context.createRoot();
    this.loader = new PluginLoader(this.context);
    // The loader is a SERVICE, not a host-private object: a plugin that wants to
    // contribute rows at runtime, restart a misbehaving neighbour, or ship an
    // installable capability uses exactly the operations the host does. There is
    // no separate "plugin API" for plugins to be limited by.
    this.context.provide(loaderKey, this.loader);
  }

  /**
   * Converge on an EXPLICIT tree.
   *
   * Entries carry the stable ids the config uses, so a workspace switch or a
   * settings flip is a diff against the previous tree rather than a rebuild of
   * all of it. Never rejects for a plugin's own failure: the failing row keeps
   * its place with a reason (see `PluginLoader`).
   */
  sync(entries: readonly PluginEntryOptions[]): Promise<void> {
    return this.loader
      .reconcile([{ id: TOOLBOX_ENTRY_ID, plugin: toolboxPlugin }, ...entries])
      .then(() => undefined);
  }

  /** Unload every row, newest first. */
  dispose(): Promise<void> {
    return this.loader.dispose();
  }

  /** One row's failure reason, when it has one — what a switch reports. */
  errorOf(id: string): string | undefined {
    return this.loader.get(id)?.error;
  }

  /**
   * One row as the LOADER holds it, addressed by the id the config uses.
   *
   * Distinct from `roster()`: that is keyed by the plugin's own `name`, a ROW by
   * its entry id — different for every spec-loaded package (`…plugin-context` vs
   * `context`). Anything reporting on a row must ask here, or an active plugin
   * reads as missing. `entries()` is the whole list, off and failed rows too.
   */
  entry(id: string): PluginEntry | undefined {
    return this.loader.get(id);
  }

  entries(): readonly PluginEntry[] {
    return this.loader.list();
  }

  get tools(): ToolDefinition[] {
    // Deliberately the stable snapshot: the loop asks every turn and the ai
    // client keys its wire cache on array identity.
    return this.context.must(toolsKey).all() as ToolDefinition[];
  }

  get toolEntries(): readonly ToolEntry[] {
    return this.context.must(toolsKey).entries();
  }

  get commandEntries(): readonly CommandEntry[] {
    return this.context.must(commandsKey).entries();
  }

  permissionFor(toolName: string, args?: Record<string, unknown>): Promise<ToolPermissionKind | undefined> {
    return this.context.must(toolsKey).permissionFor(toolName, args);
  }

  /**
   * Compose the live chains into the `AgentHooks` the loop consumes. The
   * approval gate is not passed in: it is a plugin (`permissionGatePlugin`)
   * loaded by the tree, so it reloads with its providers instead of being
   * re-wired by hand on every assembly.
   */
  agentHooks(): AgentHooks {
    return composeHooks(this.context);
  }

  /** What is actually loaded — name, state, declared dependencies. */
  roster(): ReturnType<Context['roster']> {
    return this.context.roster();
  }
}
