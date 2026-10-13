/**
 * The plugin LOADER — the one owner of plugin-tree lifecycle, and a SERVICE.
 *
 * A running kernel is a TREE of entries. An entry has a stable `id`, a plugin
 * object (or nested rows, when it is a group), raw config, an enabled state, and
 * optionally a private scope for the services it isolates or wraps. The loader is
 * the only component that turns a desired tree into live fibers and back.
 *
 * ## Why this exists instead of the array the host used to keep
 *
 *  - **Identity.** A re-roster (workspace switch, a settings flip, a config
 *    reload) is a DIFF, not a rebuild. An entry whose plugin and config are
 *    unchanged keeps its fiber, so its tools, services and event listeners are
 *    never torn down and re-registered.
 *  - **Disabled means NOT ACTIVATED.** A disabled entry keeps its row (the
 *    management page has to be able to switch it back on) but runs no `apply` and
 *    creates no fiber, so it can start nothing — no socket, no worker, no timer.
 *  - **Resources belong to the fiber.** Everything a plugin creates must be
 *    registered through `ctx.effect()`. The loader therefore does not know what a
 *    plugin owns — it only disposes the fiber, and correct teardown follows from
 *    construction rather than from a host-side cleanup branch per plugin.
 *
 * ## Plugins are not guests
 *
 * `PluginLoader` is provided as the `loader` service, so a plugin reaches the
 * same operations the host does: `create` / `update` / `remove` add, restart and
 * drop other rows at runtime, under its own row. Combined with `isolate` and
 * `intercept` (see `Context.scope`), that is the whole extension model — a plugin
 * can substitute or wrap any service, contribute its own subtree, and take the
 * whole thing down again, without the host exposing a curated API per capability.
 *
 * ## A failing plugin is DATA
 *
 * Import and activation failures are recorded on the entry (`error`) and logged;
 * they are never thrown out of `reconcile`/`create`/`update`. A broken plugin
 * therefore cannot stop the boot, cannot stop another row from loading, and
 * cannot take down the process — the operator sees the failed row and the reason.
 * Only PROGRAMMING errors throw: an unknown id, a duplicate id, a group row with
 * no children. That split is what "one plugin cannot crash the host" means in
 * code.
 *
 * Deliberately NOT here: module resolution, import-cache invalidation, and the
 * dependency graph a code HMR system needs. This loader reconciles a CONFIG tree
 * (add/update/remove rows); replacing the code of an already-imported module is a
 * different project. See `docs/plugin-architecture-refactor.md`.
 */
import type { Context } from './context.js';
import type { Fiber } from './fiber.js';
import { errMessage } from '../errors.js';
import { sameConfig } from './config-equal.js';
import type { ServiceInterceptor } from './store.js';
import type { AnyPlugin } from './types.js';

/** One row of the desired tree. `id` is the identity that survives a reconcile. */
export interface PluginEntryOptions {
  /**
   * Stable identity: the roster row, the diagnostics name, the RPC namespace,
   * and the key the operator's config entry uses.
   */
  readonly id: string;
  /** The row's plugin. Absent exactly when `group` is set. */
  readonly plugin?: AnyPlugin;
  /** Raw config handed to the plugin's own `Config` schema by the fiber. */
  readonly config?: unknown;
  /** Off rows stay on the list and keep their row, but never activate. */
  readonly disabled?: boolean;
  /** A row that only carries other rows (`entries`) and applies nothing itself. */
  readonly group?: boolean;
  /** Nested rows. A group's children live under the group's own scope. */
  readonly entries?: readonly PluginEntryOptions[];
  /**
   * Service names this row's subtree resolves PRIVATELY, so the provider it
   * registers replaces what its subtree reads. The name is untouched outside.
   */
  readonly isolate?: readonly string[];
  /**
   * Services this row's subtree reads THROUGH the given wrapper. The nearest row
   * that declares one for a name decides for its subtree; the wrapper receives
   * the value it wraps plus the reading context.
   */
  readonly intercept?: Readonly<Record<string, ServiceInterceptor>>;
}

/** One live row. A disabled row has no fiber — that IS what disabled means. */
export interface PluginEntry {
  readonly id: string;
  readonly plugin: AnyPlugin | undefined;
  readonly config: unknown;
  readonly disabled: boolean;
  readonly group: boolean;
  /** Nested rows, in activation order. */
  readonly entries: readonly PluginEntry[];
  /** The row's own context, when it has one (groups and active plugins alike). */
  readonly context: Context;
  /** Absent for a group, for a disabled row, and for one that failed to apply. */
  readonly fiber: Fiber | undefined;
  /** Why an enabled, non-group row has no fiber: its plugin threw or did not load. */
  readonly error: string | undefined;
  /** The owning group's id, when this row is nested. */
  readonly parentId: string | undefined;
}

/**
 * Is this row the same as the one already loaded?
 *
 * `config` is compared by VALUE (see `config-equal.ts`): it is data re-read from
 * the config document on every roster, so identity comparison would read an
 * unchanged file as an edit to every row. `plugin` / `isolate` / `intercept`
 * stay identity-compared — those are CODE, and a caller that builds an
 * equivalent wrapper inline has declared a different scope.
 */
function sameRow(current: ManagedEntry, next: PluginEntryOptions): boolean {
  return (
    current.options.plugin === next.plugin &&
    sameConfig(current.options.config, next.config) &&
    (current.options.disabled === true) === (next.disabled === true) &&
    (current.options.group === true) === (next.group === true) &&
    current.options.isolate === next.isolate &&
    current.options.intercept === next.intercept
  );
}

interface ManagedEntry {
  options: PluginEntryOptions;
  parentId: string | undefined;
  children: string[];
  context: Context;
  fiber: Fiber | undefined;
  error: string | undefined;
}

export class PluginLoader {
  private readonly rows = new Map<string, ManagedEntry>();
  /** Top-level ids, in order. */
  private roots: string[] = [];
  /**
   * The serialization queue. Every public mutation goes through it, so a settings
   * flip, a workspace switch and a plugin's own runtime install can never
   * interleave two half-applied trees.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly context: Context) {}

  /** Every row, depth-first in activation order. */
  list(): readonly PluginEntry[] {
    const out: PluginEntry[] = [];
    const visit = (id: string): void => {
      const managed = this.rows.get(id);
      if (managed === undefined) return;
      out.push(this.project(managed));
      for (const child of managed.children) visit(child);
    };
    for (const id of this.roots) visit(id);
    return out;
  }

  /** The top-level rows only (what the operator's config lists). */
  top(): readonly PluginEntry[] {
    return this.roots
      .map((id) => this.rows.get(id))
      .filter((managed): managed is ManagedEntry => managed !== undefined)
      .map((managed) => this.project(managed));
  }

  get(id: string): PluginEntry | undefined {
    const managed = this.rows.get(id);
    return managed === undefined ? undefined : this.project(managed);
  }

  /** Activate one row under `parentId` (a group id, or the root when omitted). */
  create(options: PluginEntryOptions, parentId?: string): Promise<PluginEntry> {
    return this.transaction(async () => {
      if (this.rows.has(options.id)) throw new Error(`plugin entry "${options.id}" already exists`);
      await this.activate(options, parentId);
      return this.get(options.id)!;
    });
  }

  /** Replace one row in place. See `replace` for the restore-on-failure rule. */
  update(id: string, options: Omit<PluginEntryOptions, 'id'>): Promise<PluginEntry> {
    return this.transaction(async () => {
      const previous = this.rows.get(id);
      if (previous === undefined) throw new Error(`unknown plugin entry "${id}"`);
      const next: PluginEntryOptions = { ...options, id };
      if (sameRow(previous, next)) return this.project(previous);
      await this.replace(next, previous);
      return this.get(id)!;
    });
  }

  /** Remove one row and its subtree. Idempotent. */
  remove(id: string): Promise<void> {
    return this.transaction(() => this.drop(id));
  }

  /**
   * Converge on `options`: activate new rows, replace changed ones, drop the
   * rest. Unchanged rows keep their identity and their live registrations, and
   * a group's children are reconciled IN PLACE rather than rebuilt.
   *
   * Never rejects for a plugin's own failure — see the file header. The returned
   * entries carry `error` for the rows that failed, which is how a caller reports
   * a bad row without the kernel dying to say so.
   * @param options - the desired top-level rows.
   * @returns the resulting top-level rows.
   */
  reconcile(options: readonly PluginEntryOptions[]): Promise<readonly PluginEntry[]> {
    return this.transaction(async () => {
      await this.converge(this.roots, options, undefined);
      return this.top();
    });
  }

  /** Unload every row, deepest last. */
  dispose(): Promise<void> {
    return this.transaction(async () => {
      for (const id of [...this.roots].reverse()) await this.drop(id);
    });
  }

  /** Serialize one mutation against every other one. */
  transaction<T>(body: () => Promise<T>): Promise<T> {
    const run = this.queue.then(body);
    // The queue must survive a failed mutation, or one bad plugin would wedge
    // every later switch. The caller still sees the rejection through `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Diff one level of the tree: drop, create, replace, and recurse into groups. */
  private async converge(
    currentIds: readonly string[],
    wanted: readonly PluginEntryOptions[],
    parentId: string | undefined,
  ): Promise<void> {
    const byId = new Map(wanted.map((option) => [option.id, option]));
    // Dropping first frees the ids a later row might reuse, and unloads
    // dependents before the providers they inject.
    //
    // No copy of `currentIds` is needed: `drop` → `detach` REBINDS the owner's
    // list (`this.roots = this.roots.filter(...)`, `parent.children = …`) rather
    // than splicing it, so the array being iterated here cannot change under us.
    for (const id of currentIds) {
      if (!byId.has(id)) await this.drop(id);
    }
    for (const option of wanted) {
      const managed = this.rows.get(option.id);
      if (managed === undefined) {
        await this.activate(option, parentId);
        continue;
      }
      if (!sameRow(managed, option)) {
        await this.replace(option, managed);
        continue;
      }
      // Unchanged row: still reconcile its children, so a nested edit does not
      // require tearing down the group (and with it every sibling).
      if (managed.options.group === true) await this.converge(managed.children, option.entries ?? [], option.id);
    }
  }

  /** Bring one row (and a group's children) up. Records failure instead of throwing. */
  private async activate(options: PluginEntryOptions, parentId: string | undefined): Promise<void> {
    if (options.group !== true && options.plugin === undefined) {
      throw new Error(`plugin entry "${options.id}" has no plugin and is not a group`);
    }
    const parentContext = parentId === undefined ? this.context : this.rows.get(parentId)?.context;
    if (parentContext === undefined) throw new Error(`unknown parent group "${parentId}" for entry "${options.id}"`);
    const scope = parentContext.scope({ isolate: options.isolate, intercept: options.intercept });
    const context = scope.labelled(options.id);
    const managed: ManagedEntry = {
      options,
      parentId,
      children: [],
      context,
      fiber: undefined,
      error: undefined,
    };
    this.rows.set(options.id, managed);
    this.attach(options.id, parentId);
    // The row exists from here on, even when its plugin is off or throws: the
    // panel draws it, the operator can switch it, and the reason is recorded.
    if (options.disabled === true) return;
    if (options.group === true) {
      await this.converge(managed.children, options.entries ?? [], options.id);
      return;
    }
    const fiber = context.plugin(options.plugin as AnyPlugin, options.config, options.id, options.id);
    managed.fiber = fiber;
    // A reload that fails at RUNTIME (a provider swap) must land on the row the
    // panel reads, exactly like a boot-time failure does — otherwise a plugin
    // that only breaks on reload keeps showing as healthy.
    fiber.onSettled = (error) => {
      managed.error = error;
      if (error !== undefined) this.context.log('error', `plugin "${options.id}" failed to reload: ${error}`);
    };
    try {
      await fiber.ready;
    } catch (err) {
      managed.error = errMessage(err);
      this.context.log('error', `plugin "${options.id}" failed to load: ${managed.error}`);
    }
  }

  /** Dispose and forget one row, children first. */
  private async drop(id: string): Promise<void> {
    const managed = this.rows.get(id);
    if (managed === undefined) return;
    for (const child of [...managed.children].reverse()) await this.drop(child);
    this.rows.delete(id);
    this.detach(id, managed.parentId);
    await managed.fiber?.dispose();
  }

  /**
   * Swap one row's activation.
   *
   * A failed activation is not the same as a failed EDIT: the operator changed
   * something, the new plugin body threw, and the honest outcome is a ROW that
   * says so — with its reason — rather than a kernel that lost a capability
   * silently. The previous row is NOT restored (the doc here used to claim it
   * was): restoring it would run code the config no longer describes, so the
   * new row keeps its place on the panel carrying `error`.
   */
  private async replace(options: PluginEntryOptions, previous: ManagedEntry): Promise<void> {
    const parentId = previous.parentId;
    await this.drop(options.id);
    await this.activate(options, parentId);
    const failed = this.rows.get(options.id)?.error;
    if (failed === undefined) return;
    // The new row is on the list with its reason (the operator asked for it, and
    // hiding the failure would be worse). The PREVIOUS row is not restored: it
    // would run different code than the config now describes.
    this.context.log('warn', `plugin "${options.id}" kept its row after a failed reload: ${failed}`);
  }

  private attach(id: string, parentId: string | undefined): void {
    if (parentId === undefined) {
      if (!this.roots.includes(id)) this.roots.push(id);
      return;
    }
    const parent = this.rows.get(parentId);
    if (parent !== undefined && !parent.children.includes(id)) parent.children.push(id);
  }

  private detach(id: string, parentId: string | undefined): void {
    if (parentId === undefined) {
      this.roots = this.roots.filter((root) => root !== id);
      return;
    }
    const parent = this.rows.get(parentId);
    if (parent !== undefined) parent.children = parent.children.filter((child) => child !== id);
  }

  private project(managed: ManagedEntry): PluginEntry {
    return {
      id: managed.options.id,
      plugin: managed.options.plugin,
      config: managed.options.config,
      disabled: managed.options.disabled === true,
      group: managed.options.group === true,
      entries: managed.children
        .map((child) => this.rows.get(child))
        .filter((child): child is ManagedEntry => child !== undefined)
        .map((child) => this.project(child)),
      context: managed.context,
      fiber: managed.fiber,
      error: managed.error,
      parentId: managed.parentId,
    };
  }
}
