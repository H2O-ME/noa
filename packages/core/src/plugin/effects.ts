/**
 * Undo bookkeeping shared by the two scopes that own registrations.
 *
 * A scope undoes what it registered newest-first, and one failing undo must not
 * stop the rest — but it must not vanish either. It used to: `Fiber` and
 * `Context` each carried a byte-identical copy of this loop with a bare
 * `catch {}`, so a plugin whose teardown threw left no trace anywhere while the
 * system went on reporting itself healthy. Both copies now REPORT through the
 * caller's logger and continue, which is the point — a teardown that only
 * half-ran is a fact an operator has to be able to see.
 *
 * The two scopes still supply their own `report` because their wording differs
 * (a fiber knows the plugin's name and the effect's label; the root scope has
 * neither), not because the loop does.
 */
import type { Dispose } from './types.js';

/** A registration's undo may be one function, several, or nothing at all. */
export function normalize(value: Dispose | readonly Dispose[] | undefined): Dispose[] {
  if (value === undefined) return [];
  return typeof value === 'function' ? [value] : [...value];
}

/**
 * Run undos newest-first, reporting each failure and carrying on.
 * @param disposers - the undos, in registration order.
 * @param report - handed every undo that threw; must not throw itself.
 */
export async function runReverse(
  disposers: readonly Dispose[],
  report: (error: unknown) => void,
): Promise<void> {
  for (const dispose of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (error) {
      // A failing undo must not stop the remaining ones — but it is still a
      // failure, and swallowing it is how "the plugin unloaded cleanly" became
      // an unfalsifiable claim.
      report(error);
    }
  }
}
