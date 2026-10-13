/**
 * The model catalog's SELECTION rules: which ids a menu offers, and what each
 * one's capabilities resolve to.
 *
 * Split from `model-id.ts` because these answer a different question. That file
 * asks "what spelling does the endpoint accept"; this one asks "what should the
 * menu show, and what is true about each row". Both are pure and offline, and
 * both are consulted by the settings page as well as the picker — which is the
 * point: the page must DISPLAY the same values a request is built from, so the
 * precedence cannot live at a call site.
 */
import type { ModelCapabilities } from './kernel/model.js';
import { resolveModelId } from './model-id.js';

/**
 * The capability fields of one discovered-metadata record, or of one configured
 * entry. Both shapes carry them inline beside their identity fields (id,
 * provider, name), and the merge below only cares about the capability half.
 */
export type DiscoveredCapabilities = ModelCapabilities & {
  contextWindow: number;
};

/**
 * The capability half of a configured `models[]` entry — everything except the
 * identity fields, which are not capabilities.
 *
 * Written out field by field rather than spread so that adding an identity field
 * to `ConfiguredModel` cannot silently start feeding it to the merge (where an
 * `id` would be a type error, but a future `provider` string would not).
 * @param entry - the operator's entry.
 * @returns only its capability overrides.
 */
export function entryCapabilities(entry: ModelCapabilities): ModelCapabilities {
  return {
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
    ...(entry.maxOutput !== undefined ? { maxOutput: entry.maxOutput } : {}),
    ...(entry.inputModalities !== undefined ? { inputModalities: entry.inputModalities } : {}),
    ...(entry.outputModalities !== undefined ? { outputModalities: entry.outputModalities } : {}),
    ...(entry.attachment !== undefined ? { attachment: entry.attachment } : {}),
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.toolCall !== undefined ? { toolCall: entry.toolCall } : {}),
  };
}

/**
 * Resolve one model's capabilities from the three authorities, in order.
 *
 * Per FIELD, not per model: an operator who overrides only `contextWindow` still
 * gets the modality list from models.dev. That matters because an override is
 * meant to be a small correction to automatic metadata, not a re-statement of it.
 *
 * `undefined` (unknown) is a real answer and is preserved as one: the gauge
 * draws no percentage rather than dividing by a guessed window.
 * @param override - the operator's entry for this id, when there is one.
 * @param discovered - what models.dev reported, when it knew the id.
 * @returns the merged capabilities, with unknown fields simply absent.
 */
export function resolveCapabilities(
  override: ModelCapabilities | undefined,
  discovered: ModelCapabilities | undefined,
): ModelCapabilities {
  // `??` rather than `||` so an explicit `false` / `0` in the override survives
  // instead of falling through to the discovered value: "off" and "unset" are
  // different facts, and an operator who disabled attachments means it.
  const pick = <K extends keyof ModelCapabilities>(key: K): ModelCapabilities[K] | undefined =>
    override?.[key] ?? discovered?.[key];

  const merged: ModelCapabilities = {};
  const contextWindow = pick('contextWindow');
  if (contextWindow !== undefined) merged.contextWindow = contextWindow;
  const maxOutput = pick('maxOutput');
  if (maxOutput !== undefined) merged.maxOutput = maxOutput;
  const inputModalities = pick('inputModalities');
  if (inputModalities !== undefined) merged.inputModalities = inputModalities;
  const outputModalities = pick('outputModalities');
  if (outputModalities !== undefined) merged.outputModalities = outputModalities;
  const attachment = pick('attachment');
  if (attachment !== undefined) merged.attachment = attachment;
  const reasoning = pick('reasoning');
  if (reasoning !== undefined) merged.reasoning = reasoning;
  const toolCall = pick('toolCall');
  if (toolCall !== undefined) merged.toolCall = toolCall;
  return merged;
}

/**
 * The ids a menu should offer, given the operator's list and the endpoint's.
 *
 * The operator's list WINS when it is non-empty: `models` in the config is the
 * whole menu then, so a model the endpoint does not publish can still be used
 * (a self-hosted deployment, a gateway alias) and a model the operator does not
 * want cannot be selected. An empty or absent list means "ask the endpoint".
 *
 * A configured id is reconciled against the endpoint's spellings so the entry
 * keeps working whatever casing the operator typed; the model in force is
 * always present, because the menu must answer "what am I talking to".
 * @param configured - the operator's `models[]` entries, in their order.
 * @param published - the endpoint's `GET /models` ids.
 * @param current - the id in force.
 * @returns the ids to offer, deduplicated and in a stable order.
 */
export function catalogIds(
  configured: readonly string[],
  published: readonly string[],
  current: string,
): string[] {
  const base = configured.length > 0 ? configured : published;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of base) {
    const resolved = resolveModelId(id, published);
    if (resolved === '' || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  // The model in force is always a row: it is the picker's check mark, and an
  // endpoint that stopped advertising it must not leave the menu unable to say
  // what this session is talking to.
  if (current !== '' && !seen.has(current)) out.unshift(current);
  return out;
}
