import nodeModule from 'node:module';

/**
 * Whether this Node exposes `node:module.stripTypeScriptTypes` (>= 22.19 /
 * >= 24) — i.e. whether a `.ts` worker entry can be loaded through native type
 * stripping in the source world.
 *
 * ONE definition for every seam that gates on it: the search worker (the
 * plugins package) and the PTC worker (the PTC extension package) both spawn
 * `.ts` entries in the source world, and two probes could disagree about which
 * runtime they are on. The handle itself (for actually stripping) stays with
 * its caller; this answers only the availability question.
 */
export function typeStrippingAvailable(): boolean {
  return typeof (nodeModule as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes === 'function';
}
