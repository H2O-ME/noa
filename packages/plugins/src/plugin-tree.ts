/**
 * The plugin TREE: how the shipped plugins, the optional packages and the
 * operator's own entries become one ordered list of rows.
 *
 * This module replaces two things that made "add a plugin" a source change:
 *
 *  - the tier/label TABLES keyed by plugin name (`CORE_PLUGINS`,
 *    `ADVANCED_PLUGINS`, `PLUGIN_LABELS`, `enabledByTier`), which meant the host
 *    had to know every plugin by name to draw its row or decide its default;
 *  - the per-name factory `switch` in `extensions.ts`, which meant every new
 *    optional package needed a new `case`.
 *
 * Now a row comes from the plugin itself: its `name` is the id, its `manifest`
 * supplies the operator-facing title/description/tier, and its tier supplies the
 * default enabled state (`core`/`standard` on, `advanced` off). The only list
 * the product still ships is WHICH package specifiers exist — a composition
 * fact, not a per-plugin behaviour branch.
 *
 * ## Identity
 *
 * An entry's `id` is either a built-in plugin's `name` (`bash`, `fs-read`) or a
 * module specifier (`./my-plugin.mjs`, `@noa/plugin-ptc`). Resolution is
 * deliberately ordered: every in-process built-in is placed first, so a spec can
 * never shadow a shipped row by accident; every remaining id is treated as a
 * module spec and resolved by the ONE spec rule (`module-spec.ts`).
 *
 * ## Importing is not activating
 *
 * A spec module is imported even when its row is off, because its manifest is
 * what draws the row. No `apply` runs and no fiber is created for a disabled
 * row, so a disabled plugin starts nothing — the rule the QQ channel violated
 * when the host dialed it from a candidate object it had kept around. A plugin
 * module must therefore stay import-side-effect-free.
 */
import {
  errMessage,
  manifestOf,
  pluginName,
  rowEnabled,
  type AnyPlugin,
  type PluginEntryOptions,
  type PluginManifest,
} from '@noa/core';
import { resolveModuleSpec } from './module-spec.js';
import type { CreateKernelOptions, PluginOrigin } from './runtime-types.js';

/**
 * The optional packages this product ships as part of its own distribution.
 *
 * These three are the product's OWN extension packages (`plugin-*`): kernel-
 * adjacent code that the product builds and lists so an operator can discover
 * and switch on a feature they have not opted into yet. Their specifiers live
 * here because the kernel must be able to name what it ships; a manifest decides
 * whether each is on (`advanced` = off), so adding one is a distribution
 * statement and needs no `case` anywhere in behaviour code.
 *
 * NOT here: the QQ channel package, and deliberately. It is the THIRD-PARTY
 * authoring example (see AGENTS.md §4) — it depends on this package, not the
 * other way round, and its credentials and settings live in its own config row,
 * so an operator who wants a QQ channel writes a row either way. Listing it here
 * would make the kernel name a downstream package: a declared cycle, a gate
 * exception, and a privilege no third-party plugin gets.
 *
 * Order is load order, and it is load-bearing for at least one pair: a PTC-mode
 * SDK projection is generated against a registry that already contains the
 * subagent tool.
 */
export const SHIPPED_PACKAGES: readonly string[] = [
  '@noa/plugin-subagent',
  '@noa/plugin-ptc',
  '@noa/plugin-memory',
];

/**
 * One row of the operator's plugin config (`plugins.entries[]`).
 */
export interface PluginEntryConfig {
  /** A built-in plugin's name, or a module specifier. */
  readonly id: string;
  /** Off rows keep their place on the panel but never activate. */
  readonly enabled?: boolean;
  /** Raw config, validated by the plugin's own `Config` schema. */
  readonly config?: unknown;
}

/** One resolved row: the plugin plus everything the panel needs to draw it. */
export interface PluginRow {
  readonly id: string;
  readonly plugin: AnyPlugin;
  readonly enabled: boolean;
  readonly config: unknown;
  readonly origin: PluginOrigin;
  readonly manifest: PluginManifest;
  /** Why a row cannot load (a package that could not be imported). */
  readonly error?: string;
  /**
   * The row as the loader takes it, carrying whatever the contributor supplied
   * beyond a plugin: nested `entries`, `isolate`, `intercept`. The tree does not
   * interpret those — a plugin's own extension of the tree is its business.
   */
  readonly options: PluginEntryOptions;
}

/**
 * Import one module spec and unwrap its plugin export.
 *
 * ONE rule for every spec-loaded plugin — a `default` (or `plugin`) export
 * satisfying the core protocol. No name is consulted, so no new package needs a
 * new branch here.
 * @param spec - the module specifier from config or `SHIPPED_PACKAGES`.
 * @param appModulesUrl - the host application's own module URL, the anchor bare
 *   names resolve against (`module-spec.ts`); omitted means library-level.
 * @returns the exported plugin.
 */
export async function loadPluginModule(spec: string, appModulesUrl?: string): Promise<AnyPlugin> {
  const target = resolveModuleSpec(spec, process.cwd(), undefined, appModulesUrl);
  let module: Record<string, unknown>;
  try {
    module = (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`cannot load plugin "${spec}": ${errMessage(err)}`);
  }
  const candidate = module['default'] ?? module['plugin'];
  if (!isPluginExport(candidate)) {
    throw new Error(
      `plugin "${spec}" does not export a plugin (default or "plugin") — expected `
        + '{ name, inject?, manifest?, Config?, apply(ctx, config) }',
    );
  }
  return candidate;
}

/**
 * The plugin shape a module must export.
 *
 * A module still written against the removed `{ name, activate(ctx) }` facade is
 * rejected with its own message rather than silently registering nothing.
 */
export function isPluginExport(value: unknown): value is AnyPlugin {
  if (typeof value === 'function') return true;
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as { apply?: unknown; activate?: unknown };
  if (typeof shape.activate === 'function' && typeof shape.apply !== 'function') {
    throw new Error(
      'this module uses the removed { name, activate(ctx) } plugin API — '
        + 'rewrite it as { name, manifest?, Config?, apply(ctx, config) }',
    );
  }
  return typeof shape.apply === 'function';
}

/** A plugin row that carries no behaviour: the placeholder for an unloadable row. */
function placeholder(id: string): AnyPlugin {
  return { name: id, apply: () => undefined };
}

/**
 * Resolve the desired tree.
 *
 * Sources, in load order: the in-process built-ins, the surface's own
 * contributions, the shipped optional packages, then every spec the operator
 * added. `entries` is applied LAST and by id, so it only ever overrides — it
 * never reorders the shipped tree, and an id matching nothing becomes a visible
 * marked row instead of a silent no-op.
 *
 * `entries` is a PARAMETER rather than a read of `opts.config`: the caller holds
 * the live list, which a config write refreshes (see `reroster`). Reaching for
 * the assembly snapshot here is what made a settings flip re-roster the tree it
 * had before the flip.
 *
 * @param builtins - this build's in-process plugins, already option-bound.
 * @param entries - the operator's `plugins.entries`, currently in force.
 * @param opts - the assembly options (surface contributions are read from here).
 * @returns the rows, in activation order, including off and unloadable ones.
 */
export async function buildTree(
  builtins: readonly AnyPlugin[],
  entries: readonly PluginEntryConfig[],
  opts: CreateKernelOptions,
): Promise<PluginRow[]> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rows: PluginRow[] = [];
  const seen = new Set<string>();

  const place = (
    id: string,
    plugin: AnyPlugin,
    origin: PluginOrigin,
    extra: Omit<PluginEntryOptions, 'id' | 'plugin' | 'config' | 'disabled'> = {},
    error?: string,
  ): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const override = byId.get(id);
    const manifest = manifestOf(plugin);
    // Whether a row is ON is ONE rule, shared with every other reader of that
    // question (core's `rowEnabled`): `core` rows cannot be switched off, and
    // every other row follows the operator's override — which a contributor's
    // intent can seed into `byId` above — else its tier's default.
    const enabled = rowEnabled(manifest, override);
    const config = override?.config;
    rows.push({
      id,
      plugin,
      enabled,
      config,
      origin,
      manifest,
      ...(error !== undefined ? { error } : {}),
      options: {
        id,
        plugin,
        ...(config !== undefined ? { config } : {}),
        disabled: !enabled,
        ...extra,
      },
    });
  };

  for (const plugin of builtins) place(pluginName(plugin, 'anonymous'), plugin, 'builtin');
  for (const contribution of opts.extraPlugins ?? []) {
    const { id, plugin, config, disabled, ...rest } = contribution;
    // A contributed row must carry a PLUGIN, and one that does not is refused
    // loudly rather than dropped. The `continue` that used to stand here was the
    // silent-drop failure this file exists to remove, and `group: true` was the
    // way to reach it — the exact shape the old comment beside it promised.
    //
    // Why a contributed GROUP is refused rather than expanded, written down so it
    // is a decision and not a gap: the LOADER supports groups (it gives such a row
    // no fiber and converges its `entries`), but this TREE cannot describe one.
    // Every `PluginRow` carries a plugin and a manifest (`manifestOf(plugin)`),
    // which a group has neither of; and `describePlugins` reads every fiberless
    // row as `disabled`, so a group whose subtree really is running would be drawn
    // on the panel as an OFF row — a new false statement in place of a silent one.
    // Drawing a group honestly belongs to `runtime-roster.ts`, outside this
    // change's range. Until then, refusing it BY NAME is the honest answer.
    if (plugin === undefined) {
      throw new Error(
        `plugin row "${id}" carries no plugin — a contributed row must carry one. A `
          + '`group: true` subtree cannot be contributed yet: its children would run while '
          + 'its own row renders as off',
      );
    }
    const before = rows.length;
    place(
      id,
      plugin,
      'surface',
      {
        ...rest,
        ...(config !== undefined ? { config } : {}),
      },
    );
    const row = rows[before];
    /**
     * A contributor's `disabled` is a row-level DEFAULT, not a second switch.
     *
     * Dropping it (destructuring it and never reading it, as this loop used to)
     * breached the public `PluginEntryOptions.disabled`: the contributor said
     * "do not activate this row" and the row activated anyway. Honoured, it means
     * for a contributed row exactly what it means for the operator's own — the row
     * STAYS (the panel must be able to reopen it), no fiber is created and `apply`
     * never runs.
     *
     * Priority: the OPERATOR outvotes the contributor. `plugins.entries` is the
     * final intent (`enabled` is the only switch), so a contribution can never pin
     * a feature against the config document — `disabled` fills only the operator's
     * SILENCE (a row they never named, or named without `enabled`). Under both
     * sits the plugin's own tier default. The decision is not re-derived here: it
     * goes to the same ONE rule `place` calls (`rowEnabled`), with the
     * contributor's intent as the override, so a `core` row still cannot be
     * switched off.
     *
     * `place` skips a duplicate id without pushing a row, which is how the absent
     * `row` reports "this call placed nothing".
     */
    const silent = byId.get(id)?.enabled === undefined;
    if (row === undefined || disabled === undefined || !silent) continue;
    const enabled = rowEnabled(row.manifest, { enabled: !disabled });
    rows[before] = { ...row, enabled, options: { ...row.options, disabled: !enabled } };
  }

  for (const spec of [...SHIPPED_PACKAGES, ...entries.map((entry) => entry.id)]) {
    if (seen.has(spec)) continue;
    try {
      place(spec, await loadPluginModule(spec, opts.appModulesUrl), 'extra');
    } catch (err) {
      const override = byId.get(spec);
      // A shipped package that is simply absent must not paint an error on a
      // panel nobody touched. Anything the operator NAMED, and anything this
      // build claims to ship, has to say why it is not there.
      if (override === undefined && !SHIPPED_PACKAGES.includes(spec)) continue;
      seen.add(spec);
      /**
       * OPERATOR intent decides whether this row is OFF or BROKEN, and the two
       * must not be conflated: `describePlugins` reads a reasonless, fiberless
       * row as `disabled`, so carrying an error here is what painted a red 失败
       * on a row nobody was ever going to load.
       *
       * "Is this row OFF?" is ONE question with ONE rule, and it is NOT
       * re-derived here. The module is what failed, so its `manifest` is exactly
       * what is unavailable: the tier therefore comes from `failedRowTier` (a
       * fact of this build, stated once at the bottom of this file), and the
       * decision itself is handed to the very same `rowEnabled` the activation
       * path calls (`place` above, same `byId` override). That is what makes the
       * three ways a row can be off agree by construction instead of by
       * coincidence: an explicit `enabled: false`, a tier whose default is off
       * (`advanced`, which is what a shipped extension package is), and a row the
       * operator never wrote at all.
       *
       * The consequence is the contract: an OFF row carries NO reason — it is not
       * meant to load, so its load failure is not news — while an OPEN row keeps
       * it, which is where the reason can be acted on. The panel draws it, the
       * startup banner prints it, and re-opening a closed row rebuilds this row
       * with the intent to load, bringing the reason back with it.
       */
      const manifest: PluginManifest = { title: spec, description: '', tier: failedRowTier(spec) };
      const open = rowEnabled(manifest, override);
      rows.push({
        id: spec,
        plugin: placeholder(spec),
        // `false` is the FACT (no module, so nothing is loaded and no fiber
        // exists); `open` above is the operator's intent, and only the intent
        // decides whether the reason is this row's news.
        enabled: false,
        config: override?.config,
        origin: 'extra',
        manifest,
        ...(open ? { error: errMessage(err) } : {}),
        // A row that could not be imported has nothing to activate; it exists so
        // the panel can say why. `manifests` still draws it.
        options: { id: spec, plugin: placeholder(spec), disabled: true },
      });
    }
  }

  return rows;
}

/**
 * The tier to draw a row under when its module could NOT be imported.
 *
 * ## Why this exists at all
 *
 * Reaching the `catch` above means `import()` failed, and a plugin's manifest
 * lives INSIDE the module that failed — there is no `manifestOf(plugin)` to ask.
 * The row used to be hardcoded `standard`, which is a declaration contradicting
 * the product's own knowledge in two ways at once: it decided whether the row was
 * OFF (it cannot — `standard` is ON by default) and it drew the row in the
 * `standard` group, for an `advanced` package the product knows ships OFF. So the
 * one row this failure path exists to describe was described wrongly, in both of
 * the fields that decide what the operator sees.
 *
 * ## Why this source (option B, chosen over "report every unreadable row")
 *
 * The specifiers in `SHIPPED_PACKAGES` are built by THIS repository and listed
 * here on purpose, so their tier is a fact of the build — statable without the
 * module, exactly as their manifests state it. Every one of them is an extension
 * package, and every extension package ships `advanced` (default off); the
 * fallback is stated rather than listed per-name so this stays ONE list that
 * cannot drift from itself. The conservative alternative (report a failure for
 * every row whose manifest cannot be read) would leave the reported defect in
 * place: a missing shipped package would keep printing a failure line, on every
 * start, for a row the operator never opened.
 *
 * A THIRD-PARTY spec gets `standard` — the same fail-open default core gives a
 * manifest-less plugin (`manifestOf`). That is safe here precisely because it is
 * fail-open in the LOUD direction: `standard` is ON by default, so a third-party
 * row the operator named still reports its load failure. Silencing a real failure
 * would take an id this build claims to ship.
 *
 * The copy is not left to rot: `test/plugin-tree.test.ts` compares this answer
 * with the tier the package itself declares.
 * @param spec - the module specifier that failed to import.
 * @returns the tier to draw the row under, and the default its switch follows.
 */
function failedRowTier(spec: string): PluginManifest['tier'] {
  return SHIPPED_PACKAGES.includes(spec) ? 'advanced' : 'standard';
}
