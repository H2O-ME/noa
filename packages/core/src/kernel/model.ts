/**
 * The model catalog's DATA shapes: what a model is, what it can do, and how a
 * menu is grouped.
 *
 * Kept apart from the wire client that actually streams (`ChatProvider`),
 * because listing models is a different authority than speaking to one — and
 * apart from the RUNTIME interfaces (`model-control.ts`: the port a surface
 * implements and the handle the kernel exposes), because these are pure data
 * with no behavior to describe.
 *
 * Nothing here is model-facing: no field reaches a request, so a catalog lookup
 * cannot move the prefix-cache bytes.
 */

/**
 * What a model can do, as far as this product can tell. Every field is
 * optional because there are three sources of truth with different authority,
 * resolved in this order: what the operator wrote in `models[].<field>`, what
 * models.dev reports for the id, and finally "unknown" — which is a real answer
 * (the gauge draws no percentage rather than guessing a window).
 */
export interface ModelCapabilities {
  /** Prompt-token window (the context gauge's denominator). */
  contextWindow?: number;
  /** Per-response completion cap. */
  maxOutput?: number;
  /** What the model accepts (`text` / `image` / `audio` / `video` / `pdf`). */
  inputModalities?: readonly string[];
  /** What it can emit. */
  outputModalities?: readonly string[];
  /** Whether it accepts file attachments at all. */
  attachment?: boolean;
  /** Whether it emits a reasoning stream. */
  reasoning?: boolean;
  /** Whether it supports tool/function calling. */
  toolCall?: boolean;
}

/**
 * One entry of the config's `models` list — the operator's own catalog.
 *
 * Presence of the list is what matters: a non-empty `models` array IS the
 * menu (add and remove freely, whether or not the endpoint publishes the id),
 * and an absent list falls back to the endpoint's `GET /models` plus models.dev
 * metadata. Per-entry fields are OVERRIDES, not a re-statement: an entry naming
 * only `id` still gets its window and modalities from models.dev, so hand-editing
 * a capability is opt-in per field rather than per model.
 */
export interface ConfiguredModel extends ModelCapabilities {
  /** The id a request carries (the endpoint's own spelling is preferred). */
  id: string;
  /** Display name for the menus; falls back to the metadata, then the id. */
  name?: string;
}

/** One selectable model: the id the endpoint knows plus display metadata. */
export interface ModelOption {
  /** Model id as the endpoint knows it (what a request carries). */
  id: string;
  /** Display name — the catalog's, else the id. */
  name: string;
  /** Context window when the surface's metadata knows it (the gauge's denominator). */
  contextWindow?: number;
  /**
   * Everything known about what this model can do, already resolved through the
   * override → models.dev → unknown chain. Carried on the option so the
   * settings page can SHOW and EDIT each field without a second lookup, which
   * would be a second implementation of the same precedence rule.
   */
  capabilities?: ModelCapabilities;
}

/** One menu group: a heading and its rows. */
export interface ModelGroup {
  id: string;
  name: string;
  models: readonly ModelOption[];
}
