/**
 * The kernel's model control (see core's `kernel/model.ts` for the shapes).
 *
 * Two authorities meet here and neither is duplicated:
 *
 *  - **The endpoint owns the ids.** `ChatProvider.listModels()` is the catalog
 *    (`GET /models` on an OpenAI-compatible gateway), so a deployment that adds
 *    or retires a model changes what the picker offers with no release here.
 *  - **The surface owns the metadata.** Display names and context windows come
 *    from the `ModelCatalogPort` the assembly was handed (the cli's models.dev
 *    store), because an endpoint reports ids and nothing else.
 *
 * The switch itself is in-place on the one client instance every consumer
 * already holds (`ChatProvider.setModel`), so nothing is rebuilt: the session
 * handles, the roster's subagent tool and the cache-affinity binding all keep
 * pointing at the same live client, and only the model id moves. The session
 * then ANNOUNCES the change on the kernel event stream, which is what makes a
 * switch made in one surface visible in the others.
 */
import {
  canSwitchModels,
  catalogIds,
  llm as llmKey,
  sessions as sessionsKey,
  type ModelCatalogPort,
  type ModelControl,
  type ModelOption,
} from '@noa/core';
import type { Environment } from './runtime-env.js';

/**
 * Build the control, or `undefined` when this kernel cannot switch models:
 * no catalog port (a surface that never shows a picker), no retargetable
 * client (a scripted provider, a shim). Absence is a first-class answer — the
 * seat stays unrendered instead of opening onto a list it cannot apply.
 */
export function modelControl(env: Environment, port: ModelCatalogPort): ModelControl | undefined {
  const provider = env.provider;
  if (!canSwitchModels(provider)) return undefined;
  const current = (): string => env.root.must(llmKey).model;

  /**
   * One row: the port's metadata, falling back to the raw id.
   *
   * `capabilities` rides along so a settings page can SHOW and EDIT each field
   * without a second lookup — a second lookup would be a second implementation
   * of the override → models.dev → unknown precedence, and the page could then
   * display a window the request would not use.
   */
  const option = async (id: string): Promise<ModelOption> => {
    const meta = await port.describe(id).catch(() => undefined);
    const capabilities = await port.capabilities?.(id).catch(() => undefined);
    return {
      id,
      name: meta?.name ?? id,
      ...(meta?.contextWindow !== undefined ? { contextWindow: meta.contextWindow } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
    };
  };

  return {
    current,
    published: async () =>
      provider.listModels === undefined ? [] : await provider.listModels().catch(() => []),
    automatic: async (model) => await port.automatic?.(model).catch(() => undefined),
    list: async () => {
      const configured = (await port.configured?.()) ?? [];
      // A failure to ask the endpoint is only a failure when its answer was
      // NEEDED. With the operator's own `models[]` in force the menu is already
      // decided, so a dead or unauthorized endpoint must not blank a list the
      // operator wrote — that is exactly the self-hosted case the list exists
      // for. Without one, the endpoint IS the menu, and swallowing its error
      // would render "this site publishes nothing" for what is really "could not
      // ask" — opposite facts, and only one of them is worth a Retry.
      let published: readonly string[] = [];
      if (provider.listModels !== undefined) {
        published = configured.length > 0
          ? await provider.listModels().catch(() => [] as string[])
          : await provider.listModels();
      }
      // The operator's list wins when they wrote one: it is then the WHOLE menu,
      // so a self-hosted or alias id the endpoint does not publish is still
      // selectable and a model they removed is not. The in-force model is always
      // included, because the menu must answer "what am I talking to".
      const ids = catalogIds(configured, published, current());
      if (ids.length === 0) return [];
      return [{ id: 'endpoint', name: port.label, models: await Promise.all(ids.map(option)) }];
    },
    select: async (model) => {
      provider.setModel(model);
      const chosen = await option(model);
      env.root
        .get(sessionsKey)
        ?.current()
        ?.announceModel(model, { name: chosen.name, ...(chosen.contextWindow !== undefined ? { contextWindow: chosen.contextWindow } : {}) });
      return chosen;
    },
  };
}