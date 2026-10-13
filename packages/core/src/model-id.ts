/**
 * Which spelling of a model id a request should carry.
 *
 * An endpoint's model ids are its own private vocabulary: `GET /models` reports
 * the exact strings it accepts, and many gateways compare them literally. A
 * configured name that differs only in case is therefore not a near miss — it is
 * an unknown model, answered with a 5xx/404 that reads like an outage. That
 * failure is indistinguishable from a dead provider at the point where the
 * reader meets it, which is why the spelling is reconciled HERE rather than left
 * to whoever wrote the config file.
 *
 * The endpoint is the authority, so this function answers "what should the
 * request say", never "is the configured name good". Three passes, cheapest
 * first, and a refusal beats a guess:
 *
 *  1. an exact match is already the endpoint's spelling;
 *  2. a case-insensitive match differing only in case (`deepseek-v4-flash` →
 *     `DeepSeek-V4-Flash`) is the common gateway habit;
 *  3. a normalized match ignoring `-`, `_`, `.` and spaces catches the rest
 *     (`gpt-4o` ↔ `gpt4o`).
 *
 * Passes 2 and 3 only win when they are UNIQUE: if two published ids both
 * answer, the choice would be arbitrary and the configured name is kept so the
 * endpoint's own error names the model the operator asked for.
 *
 * Pure and offline — the caller supplies the list it already fetched.
 *
 * The SELECTION rules (which ids a menu offers, what each one's capabilities
 * resolve to) live in `model-catalog-rules.ts`: same "pure and offline"
 * property, different question. This file only answers "what spelling does the
 * endpoint accept".
 */

/** Case- and punctuation-insensitive key for the loosest comparison pass. */
function looseKey(id: string): string {
  return id.toLowerCase().replace(/[\s\-_.]/g, '');
}

/**
 * Whether two spellings denote the same model. Case is the only variation
 * treated as "same": punctuation is too lossy to decide identity (a gateway can
 * legitimately serve both `gpt-4o` and `gpt4o` as different models), while a
 * casing difference never does.
 *
 * This is the one definition of the question, so the boot-time reconciliation
 * and the metadata lookup (which decides whether the configured context-window
 * override still applies to the model in force) cannot disagree about it.
 * @param a - one id.
 * @param b - the other id.
 * @returns true when they are the same model spelled differently.
 */
export function sameModelId(a: string, b: string): boolean {
  // An empty name means "no model named", and two absences are not a match:
  // the guard is on the values, not just on the case-folding branch, or an
  // unreconciled empty id would inherit another model's metadata.
  if (a === '' || b === '') return false;
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * The id to put in a request, given what the operator configured and what the
 * endpoint publishes.
 * @param configured - the model name from config (or a picker's choice).
 * @param available - the endpoint's published ids (`ChatProvider.listModels`).
 * @returns the endpoint's own spelling when it can be determined, else `configured`.
 */
export function resolveModelId(configured: string, available: readonly string[]): string {
  if (configured === '' || available.length === 0) return configured;
  if (available.includes(configured)) return configured;

  // `toLowerCase` is not `toLocaleLowerCase` on purpose: a Turkish locale would
  // map `I` to `ı` and break the very comparison this exists to make, and model
  // ids are ASCII identifiers, not prose.
  const folded = configured.toLowerCase();
  const ci = available.filter((id) => id.toLowerCase() === folded);
  if (ci.length === 1) return ci[0] as string;

  // When case alone was ambiguous, the punctuation pass cannot do better: the
  // same collision would decide it. Keep the configured spelling.
  if (ci.length > 1) return configured;
  const key = looseKey(configured);
  const loose = available.filter((id) => looseKey(id) === key);
  return loose.length === 1 ? (loose[0] as string) : configured;
}
