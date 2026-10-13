/**
 * The RUNTIME half of the model picker: the port a surface implements, and the
 * handle the kernel exposes.
 *
 * Split from `model.ts` (the data shapes) because these describe behavior, and
 * the split is the one that keeps each file readable: `model.ts` answers "what
 * is a model, and what can it do", this answers "who supplies that, and who may
 * change it".
 *
 * Two authorities meet here and neither is duplicated:
 *  - **the endpoint owns the ids** (`ChatProvider.listModels`), so a gateway that
 *    adds a model needs no release of this product;
 *  - **the surface owns the metadata** (display names, windows, modalities),
 *    because an endpoint reports ids and nothing else.
 *
 * Switching is a property of the SESSION: the surface rewrites the provider in
 * place (`ChatProvider.setModel`), then calls `AgentSession.announceModel` to
 * publish the `model` event.
 */
import type { ModelCapabilities, ModelGroup, ModelOption } from './model.js';
import type { ChatProvider } from '../types.js';

/**
 * What the owning surface contributes to the picker. The model IDS are not here
 * by default: they come from the endpoint itself, so a gateway that adds a model
 * does not need this product re-released. This port answers the questions the
 * endpoint cannot — how to label the group, and what each id means.
 */
export interface ModelCatalogPort {
  /** Heading for the endpoint's models (e.g. the gateway host or provider name). */
  readonly label: string;
  /**
   * Display name + context window for one id, when the surface knows it.
   * Never throws in practice (metadata is best-effort) — an unknown id simply
   * renders as itself with no percentage on the gauge.
   */
  describe(model: string): Promise<{ name?: string; contextWindow?: number } | undefined>;
  /**
   * Everything the surface's metadata knows about one id, when it can be asked
   * for more than a label and a window. Optional: a port that only implements
   * `describe` is still a complete port, and `describe` is then the answer.
   */
  capabilities?(model: string): Promise<ModelCapabilities | undefined>;
  /**
   * The AUTOMATIC capabilities for one id — models.dev's answer, with the
   * operator's overrides deliberately NOT applied.
   *
   * The settings page needs both halves to be useful: what is in force (so a
   * field shows its real value) and what the automatic source would give (so an
   * untouched field can show it as a placeholder and the operator knows what
   * they are departing from). Computing that in the browser would duplicate the
   * precedence rule this port exists to own.
   */
  automatic?(model: string): Promise<ModelCapabilities | undefined>;
  /**
   * The operator's own model list (config `models[]`), read LIVE.
   *
   * A function rather than an array because the settings page rewrites this list
   * while the process runs: a captured array would leave the composer's menu
   * showing the old catalog until the next restart, which reads as a save that
   * did nothing. Asynchronous because reading it means reading the config file.
   * NON-EMPTY means it IS the menu — the endpoint is then consulted only for
   * spelling, so a model it does not publish can still be offered and one the
   * operator removed cannot be selected. Empty means "ask the endpoint".
   */
  configured?: () => Promise<readonly string[]>;
}

/**
 * The kernel-side model handle. `select` THROWS with a renderable reason when
 * the switch cannot happen (a provider that cannot retarget, an id the endpoint
 * refuses) — surfaces show the reason instead of a silent no-op.
 */
export interface ModelControl {
  /** The model in force right now. */
  current(): string;
  /** The selectable catalog (live: it may change as the endpoint does). */
  list(): Promise<readonly ModelGroup[]>;
  /**
   * The endpoint's OWN published ids, before the operator's `models[]` is
   * applied.
   *
   * Distinct from `list()` on purpose: `list()` answers "what may I pick", which
   * is the operator's list once they wrote one. The settings page asks the other
   * question — "what does this endpoint serve" — so that an id the operator
   * removed can be added back instead of being unreachable from the UI.
   */
  published(): Promise<readonly string[]>;
  /**
   * What models.dev reports for one id, WITHOUT the operator's overrides. The
   * settings page shows these as the per-field placeholder ("自动") so the
   * operator can see what they are departing from; resolving them in the browser
   * would duplicate the override → automatic → unknown precedence.
   */
  automatic(model: string): Promise<ModelCapabilities | undefined>;
  /** Retarget the session's model and announce it on the kernel event stream. */
  select(model: string): Promise<ModelOption>;
}

/** The provider side of a switch, as a capability test (see `ChatProvider`). */
export function canSwitchModels(provider: ChatProvider): provider is ChatProvider & {
  setModel(model: string): void;
} {
  return typeof (provider as { setModel?: unknown }).setModel === 'function';
}
