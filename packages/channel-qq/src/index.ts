/**
 * The QQ bot package: a standard plugin that owns its channel, plus the argv
 * surface for `noa`.
 *
 * The plugin half is what a host loads (by spec, from its own row): `plugin` /
 * `default` satisfy core's `Plugin` protocol and its `Config` validates the row's
 * settings. The surface half is only the claim-and-wait shape — it starts
 * nothing, because the channel belongs to the plugin's fiber.
 *
 * `default` is re-exported alongside `plugin` on purpose: the plugin tree unwraps
 * a spec-loaded module as `default ?? plugin`, and a module that offers both
 * cannot be loaded by one rule and rejected by the other.
 */
export * from './protocol.js';
export * from './types.js';
export * from './runtime.js';
export * from './media-inbound.js';
export { default } from './plugin.js';
export * from './plugin.js';
export * from './probe.js';
export * from './surface/index.js';
