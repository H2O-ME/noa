/**
 * Plugin vocabulary — the shapes a plugin may take and the config contract it
 * declares. Kept free of any dependency on the rest of the kernel so a plugin
 * author needs only these types.
 */
import type { Context } from './context.js';

/** Anything that can be undone when its owning plugin unloads. */
export type Dispose = () => void | Promise<void>;
export type Awaitable<T> = T | Promise<T>;

/**
 * A tagged service key: the single, greppable name a capability is registered
 * and resolved under, carrying its type in the generic. Plugins declare what
 * they need by listing keys in `inject`, and read them with `ctx.must(key)`.
 */
export interface ServiceKey<T> {
  readonly name: string;
  /** Phantom field — never read, only makes the key invariant in T. */
  readonly __type?: T;
}

/** Declare a service key. The name is the cross-package contract. */
export function key<T>(name: string): ServiceKey<T> {
  return { name };
}

/** The type a declared key resolves to; `string` declarations stay untyped. */
export type ServiceOf<K> = K extends ServiceKey<infer T> ? T : unknown;
export type AnyServiceKey = ServiceKey<never> | ServiceKey<unknown>;

/**
 * Structural Standard-Schema validator (`~standard.validate`). Declared here
 * instead of depending on the spec package so core stays dependency-free; any
 * conforming library (zod, valibot, schemastery) satisfies it.
 */
export interface ConfigSchema<T> {
  readonly '~standard': {
    readonly validate: (value: unknown) => StandardResult<T> | Promise<StandardResult<T>>;
  };
}

export type StandardResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/**
 * What a plugin says about ITSELF to the operator.
 *
 * This lives on the plugin rather than in a host-side table keyed by plugin
 * name, because a table is exactly what made adding a plugin a source change:
 * the host had to know the name to draw its row, group it, and decide whether it
 * could be switched off. A plugin that carries its own manifest is a plugin the
 * host has never heard of and can still list, group and switch.
 */
export interface PluginManifest {
  /** Operator-facing title (Chinese). Never the identifier. */
  readonly title: string;
  /** One line, in the operator's language, about what the plugin does. */
  readonly description: string;
  /**
   * The layer this plugin belongs to, as the operator sees it.
   *
   *  - `core` — load-bearing: registries and capability providers, plus the
   *    tools that ARE the agent's reach. No switch is drawn and the switch
   *    refuses, because dropping one takes the tool surface (or the panel's
   *    own ability to re-roster) down with it.
   *  - `standard` — ships on, may be turned off.
   *  - `advanced` — ships OFF until the operator asks for it, which is what
   *    "按需开启" means for whole execution modes and external channels.
   */
  readonly tier: PluginTier;
  /**
   * Whether the plugin answers a settings `page` operation.
   *
   * It is declared rather than discovered so the browser can draw the settings
   * navigation from the roster — without asking every plugin, and without the
   * host keeping a list of which plugins have a page. A plugin that says yes and
   * then fails to answer shows the failure in its own section, which is the same
   * treatment every other plugin fault gets.
   */
  readonly page?: boolean;
  /**
   * The plugin's BROWSER-side bundle, when it ships one. Absent means a
   * server-only plugin — the common case, since most plugins extend the kernel
   * container with tools/services and need nothing in the browser. Declaring it
   * puts the plugin on the browser's boot graph, which fetches and registers the
   * bundle on boot; the URL and cache rules are the roster row's
   * (`PluginRosterEntry.clientBundle`).
   */
  readonly clientBundle?: PluginClientBundle;
}

/**
 * Where one plugin's browser bundle lives, as the plugin itself declares it.
 *
 * One shape for both halves of the same fact — the manifest's declaration and
 * the roster row's boot-graph entry — so a plugin author writes it once and the
 * browser reads exactly what was written.
 */
export interface PluginClientBundle {
  /** Path under the plugin's `/plugins/<name>/` prefix; defaults to `client.js`. */
  readonly path?: string;
  /** Content rev (a hash or version string) for cache busting. */
  readonly rev?: string;
}

/** Where a plugin sits in the operator's mental model, and its default state. */
export type PluginTier = 'core' | 'standard' | 'advanced';

export interface PluginBase<T = unknown> {
  /** Human-readable identity; used in logs and dependency errors. */
  name?: string;
  /**
   * One line about what the plugin is for, in the operator's language.
   *
   * It is metadata, never logic: the plugin manager shows it as a row's body and
   * falls back to a built-in label table for names it knows. Part of the protocol
   * (rather than a side channel the manager reaches for) because a third-party
   * module has no other way to describe itself — the loader would otherwise have
   * to know the field by convention.
   */
  description?: string;
  /**
   * The operator-facing row for this plugin. Absent for a plugin nothing lists
   * (a test fixture, an embedded helper): the manager then draws the plugin's
   * own identifier and its MODEL-facing description, and treats it as
   * `standard` — switchable, on by default. That fallback is the fail-open side
   * on purpose: a third-party plugin must stay switchable, and grouping an
   * unknown name with the load-bearing tier would make it impossible to turn
   * off.
   */
  manifest?: PluginManifest;
  /** Validator applied to the config before the plugin body runs. */
  Config?: ConfigSchema<T>;
  /**
   * Services this plugin reads. Declaring them buys two things: a clear error
   * naming the missing service when one is absent, and an automatic reload
   * when the provider is replaced (so swapping a backend re-points dependents
   * instead of stranding them on a dead reference).
   */
  inject?: readonly (AnyServiceKey | string)[];
}

/** `apply(ctx, config)` object form. */
export interface PluginObject<T = unknown> extends PluginBase<T> {
  apply(ctx: Context, config: T): Awaitable<void>;
}

/** Bare function form (metadata rides on the function's own properties). */
export type PluginFunction<T = unknown> = ((
  ctx: Context,
  config: T,
) => Awaitable<void>) &
  PluginBase<T>;

/** Provider form: the constructor itself is the plugin, `new`ed with (ctx, config). */
export interface PluginConstructor<T = unknown> extends PluginBase<T> {
  new (ctx: Context, config: T): unknown;
}

export type Plugin<T = unknown> =
  | PluginObject<T>
  | PluginFunction<T>
  | PluginConstructor<T>;

export type AnyPlugin = Plugin<never> | Plugin<unknown> | PluginObject<never>;

/** The three shapes reduced to one callable plus its metadata. */
export interface ResolvedPlugin {
  name: string;
  inject: readonly string[];
  config: ConfigSchema<unknown> | undefined;
  run: (ctx: Context, config: unknown) => Awaitable<void>;
}

function isClass(value: unknown): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

export function resolvePlugin(plugin: AnyPlugin, fallbackName: string): ResolvedPlugin {
  const meta = plugin as PluginBase<unknown>;
  const name = pluginName(plugin, fallbackName);
  const inject = (meta.inject ?? []).map((entry) =>
    typeof entry === 'string' ? entry : entry.name,
  );
  const base = { name, inject, config: meta.Config };
  if (typeof plugin === 'function' && isClass(plugin)) {
    const Ctor = plugin as unknown as new (c: Context, cfg: unknown) => unknown;
    return { ...base, run: (ctx, config) => void new Ctor(ctx, config) };
  }
  if (typeof plugin === 'function') {
    return { ...base, run: plugin as unknown as ResolvedPlugin['run'] };
  }
  if (typeof plugin === 'object' && plugin !== null) {
    const object = plugin as PluginObject<unknown>;
    return { ...base, run: (ctx, config) => object.apply(ctx, config) };
  }
  throw new Error(`plugin "${name}" is not a function, a class, or an object with apply()`);
}

/**
 * A plugin's identity: an explicitly declared name, else the function/class's
 * own name, else the caller's fallback. An empty string is not a name — a bare
 * arrow function has one, and taking it would put nameless plugins in the
 * roster and in every error message.
 *
 * Exported because `name` is optional in the protocol while several consumers
 * need it eagerly (the roster matches config entries by it, the plugin manager
 * builds a manifest row from it). Those callers must use THIS rule rather than
 * re-deriving one, or the name a plugin is switched off under can drift from
 * the name it is reported under.
 */
export function pluginName(plugin: AnyPlugin, fallback: string): string {
  const declared = (plugin as PluginBase<unknown>).name;
  if (typeof declared === 'string' && declared !== '') return declared;
  const own = (plugin as { name?: unknown }).name;
  if (typeof own === 'string' && own !== '') return own;
  return fallback;
}

/**
 * The operator-facing row for one plugin, with the documented fallback for a
 * plugin that declares none (see `PluginBase.manifest`).
 * @param plugin - the plugin to describe.
 * @returns the manifest to render.
 */
export function manifestOf(plugin: AnyPlugin): PluginManifest {
  const own = (plugin as PluginBase<unknown>).manifest;
  if (own !== undefined) return own;
  const description = (plugin as PluginBase<unknown>).description;
  return {
    title: pluginName(plugin, 'anonymous'),
    description: description ?? '',
    tier: 'standard',
    // No page unless declared: a plugin with no manifest is usually an embedded
    // helper or a fixture, and a settings section for each of those would fill
    // the navigation with pages that answer nothing. Declaring the manifest field
    // is one line, and it is the plugin's own line to write.
  };
}

/** Whether a tier ships on without the operator asking (see `PluginTier`). */
export function enabledByDefault(tier: PluginTier): boolean {
  return tier !== 'advanced';
}

/** Whether a tier is load-bearing and therefore refuses to be switched off. */
export function isRequiredTier(tier: PluginTier): boolean {
  return tier === 'core';
}

/**
 * The one field this rule reads off an operator row (`plugins.entries`): the
 * switch. Structural, so core needs no plugin-config type — the rest of the row
 * belongs to the plugin's own config schema.
 */
export interface PluginSwitch {
  readonly enabled?: boolean;
}

/**
 * THE answer to "does this row load?" — the one implementation of the
 * tier-default / operator-override combination, next to the two tier predicates
 * it combines.
 *
 * It is shared because two readers ask the same question at different times:
 * the plugin tree, one row at a time (`plugin-tree.ts`), and the shell, before
 * any kernel exists (`surfaceRowEnabled` in the plugins package — a surface the
 * operator closed must not claim the invocation). Each caller resolves the
 * override for its own id, with whatever it has (the tree's row map, which a
 * contributor's intent can seed); the DECISION stays here, so the panel's switch
 * and the boot path cannot disagree.
 * @param manifest - the row's manifest; its tier supplies the default.
 * @param override - the operator's row for this id, if any.
 * @returns whether the row loads (a `core` row always does).
 */
export function rowEnabled(manifest: PluginManifest, override?: PluginSwitch): boolean {
  return isRequiredTier(manifest.tier) ? true : (override?.enabled ?? enabledByDefault(manifest.tier));
}
