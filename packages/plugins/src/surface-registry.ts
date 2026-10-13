/**
 * The surface registry: the live home of `AgentSurface` plugins. The cli reads
 * `~/.noa/config.json` `surfaces` (module specs), `loadSurfacePlugins`
 * dynamically imports each, and a registry built with `createSurfaceRegistry`
 * resolves which one claims an invocation — so a surface is a config row, not a
 * hardcoded entry.
 *
 * Mirrors the kernel-plugin tree's discipline (one spec-resolution rule, loud
 * failure on a missing export) so surface and plugin loading agree on what a
 * config string means.
 *
 * The `surfaces` capability ServiceKey: the registry INSTANCE is built by the
 * caller and must exist before the kernel does (the kernel is assembled after
 * surfaces load, and the roster needs the same instance to register each
 * surface as an ordinary plugin row). The assembly provides it INTO the
 * container (`surfaceRegistryProvider` in `services.ts`), and `surfacePlugin`
 * below is the row that consumes it — so a configured surface shows up in
 * `/plugins`, sits in the tier table and can be switched like any plugin.
 */
import {
  errMessage,
  manifestOf,
  rowEnabled,
  surfaces as surfacesKey,
  type AgentSurface,
  type AgentSurfaceRequest,
  type Context,
  type Plugin as CorePlugin,
  type SurfaceRegistry,
} from '@noa/core';
import { resolveModuleSpec } from './module-spec.js';
import type { PluginEntryConfig } from './plugin-tree.js';

/** An empty registry a caller populates via `register()` (or `loadSurfacePlugins`). */
export function createSurfaceRegistry(): SurfaceRegistry {
  const list: AgentSurface[] = [];
  let claimed: AgentSurface | undefined;
  return {
    all: () => [...list],
    resolve: (request: AgentSurfaceRequest) => {
      // Record the winner as a side effect of resolving: the `userQuestions`
      // service only has the registry, so this is how "the surface in force"
      // reaches it without the resolution result being threaded through the
      // kernel assembly by hand.
      claimed = list.find((surface) => surface.claim(request));
      return claimed;
    },
    register: (surface) => {
      // Idempotent per INSTANCE: there are two honest registration paths for one
      // surface — the shell registers every loaded surface before the kernel
      // exists (resolution has to see them), and the surface's own plugin ROW
      // registers the SAME object again when its fiber activates
      // (`surfacePlugin` below). A second list entry would make `all()` report
      // one surface twice, and would make a disposer's `indexOf` remove the
      // OTHER copy. First registration keeps the precedence slot. Two DISTINCT
      // surfaces sharing a name stay listed separately: that is a config error
      // the resolver should still see, not a duplicate to absorb.
      if (list.includes(surface)) return () => undefined;
      list.push(surface);
      return () => {
        const index = list.indexOf(surface);
        if (index >= 0) list.splice(index, 1);
      };
    },
    current: () => claimed,
  };
}

/**
 * Load `surfaces`: module specifiers (absolute, relative to cwd, or bare
 * package names) whose `default` (or `surface`) export is an `AgentSurface`.
 * A module that does not export one fails loudly with its specifier, mirroring
 * a `plugins.entries` row that will not load — a silently ignored surface is
 * worse than a broken boot.
 * @param specs - the `surfaces` rows, in config order.
 * @param cwd - the base for relative rows.
 * @param appModulesUrl - the host application's own module URL, the same anchor
 *   bare names resolve against in the plugin tree (`module-spec.ts`).
 */
export async function loadSurfacePlugins(
  specs: readonly string[],
  cwd: string,
  appModulesUrl?: string,
): Promise<AgentSurface[]> {
  const out: AgentSurface[] = [];
  for (const spec of specs) {
    const target = resolveModuleSpec(spec, cwd, undefined, appModulesUrl);
    let module: Record<string, unknown>;
    try {
      module = (await import(target)) as Record<string, unknown>;
    } catch (err) {
      // The config row names the module, so only the operator can fix a dead
      // spec — say HOW, or the boot failure reads like a bug in the product.
      throw new Error(
        `surfaces: cannot load "${spec}": ${errMessage(err)}（若该 surface 已卸载，请从 ~/.noa/config.json 的 surfaces 行移除它）`,
      );
    }
    const candidate = module['default'] ?? module['surface'];
    if (!isAgentSurface(candidate)) {
      throw new Error(`surfaces: "${spec}" does not export a surface (default or "surface")`);
    }
    out.push(candidate);
  }
  return out;
}

function isAgentSurface(value: unknown): value is AgentSurface {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { claim?: unknown }).claim === 'function' &&
    typeof (value as { start?: unknown }).start === 'function'
  );
}

/**
 * Adapt one surface module to the container-native plugin protocol.
 *
 * The row registers the surface through the injected `surfaces` service. It does
 * not use the legacy `{ name, activate }` facade: that facade is only the
 * compatibility path for existing tool/command plugins. Keeping this adapter
 * native gives a surface the same `inject`/`apply` lifecycle as any kernel
 * plugin and makes disposal part of the owning fiber.
 *
 * @param surface - loaded surface implementation.
 * @param registry - registry instance provided by the assembly.
 * @returns a container plugin row.
 */
export function surfacePlugin(surface: AgentSurface, registry: SurfaceRegistry): CorePlugin {
  return {
    name: surface.name,
    inject: [surfacesKey],
    apply: (ctx: Context): void => {
      const service = ctx.must(surfacesKey);
      ctx.effect(() => service.register(surface), `surface(${surface.name})`);
      if (service !== registry) {
        throw new Error(`surface ${surface.name} received a different registry instance`);
      }
    },
  };
}

/**
 * Whether a loaded surface's ROW is on — asked by the shell BEFORE it registers
 * that surface into the resolver's registry.
 *
 * Resolution happens before any kernel exists, so whatever sits in the registry
 * CLAIMS the invocation. A row the operator closed must therefore stay out of
 * it, or the closed surface keeps winning `resolve()` and running `start()` on
 * every restart — the switch would decide only what the panel showed, never what
 * ran. The row itself must survive: `SurfaceRows.loaded` still carries it, so
 * the roster draws its panel row and the operator can switch it back on.
 *
 * The answer comes from the ONE enabled rule (`core`'s `rowEnabled`) applied to
 * the very row the roster will build (`surfacePlugin`) and the operator's
 * `plugins.entries` row for `surface.name` — the id the roster uses and the id
 * the panel writes. Override lookup matches `buildTree`'s own map (the last row
 * for an id wins): a hand-edited duplicate must not give the two readers
 * different answers. A surface row declares no manifest, so it takes the
 * `standard` default.
 * @param surface - the loaded surface.
 * @param registry - the registry instance its row registers onto.
 * @param entries - the operator's `plugins.entries`, in document order.
 * @returns whether the surface may claim (and be registered for) this run.
 */
export function surfaceRowEnabled(
  surface: AgentSurface,
  registry: SurfaceRegistry,
  entries: readonly PluginEntryConfig[],
): boolean {
  const override = new Map(entries.map((entry) => [entry.id, entry])).get(surface.name);
  return rowEnabled(manifestOf(surfacePlugin(surface, registry)), override);
}

