/**
 * The test-side bridge from a LIST of plugins to the ENTRY OPTIONS
 * `PluginHost.sync` reconciles.
 *
 * Production has exactly one such bridge — `runtime-roster.ts`, which goes
 * through `buildTree` because it must honour the operator's `plugins.entries`
 * (tiers, overrides, unloadable specs). A test that means "just these plugins,
 * all on" does not: it keys each row by the plugin's own name, which is what the
 * loader's diagnostics and the roster both read.
 */
import { pluginName, type AnyPlugin, type PluginEntryOptions } from '@noa/core';

/** One entry option per plugin, id = the plugin's own name. */
export function rowsOf(plugins: readonly AnyPlugin[]): PluginEntryOptions[] {
  return plugins.map((plugin) => ({ id: pluginName(plugin, 'anonymous'), plugin }));
}

/**
 * The same rows, with each plugin's OWN row settings.
 *
 * Settings reach a plugin through its row's `config` — validated by the
 * plugin's own `Config` schema and handed to `apply(ctx, config)` — so a test
 * that wants a non-default timeout says so HERE, in the same field an operator
 * writes in `plugins.entries`. There is no host-side options bag any more.
 */
export function configuredRowsOf(
  plugins: readonly AnyPlugin[],
  configById: Readonly<Record<string, unknown>>,
): PluginEntryOptions[] {
  return rowsOf(plugins).map((row) =>
    Object.hasOwn(configById, row.id) ? { ...row, config: configById[row.id] } : row,
  );
}
