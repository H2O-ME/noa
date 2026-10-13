/**
 * The surface half of this package, now down to one thing: `noa`.
 *
 * The four files that used to live here (a bridge the Web surface started, a
 * settings-page seam, a credential probe, an activation step) existed because the
 * HOST drove the channel — and that is precisely what the plugin now owns, so they
 * were folded into the plugin (`src/plugin.ts`, `src/settings.ts`, `src/probe.ts`)
 * instead of surviving as a second way to start one.
 */
export * from './mode.js';
