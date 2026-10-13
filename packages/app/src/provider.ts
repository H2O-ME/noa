/**
 * `~/.noa/config.json` → the two things the kernel needs: the OpenAI-
 * compatible client, and the model id a request will actually carry.
 *
 * Ported from nova's `packages/cli/src/kernel-config.ts` +
 * `provider-model-resolve.ts`, with the multi-endpoint store left behind: this
 * product has ONE endpoint, and the provider block is where it lives.
 */
import { OpenAICompatClient } from '@noa/ai';
import { resolveModelId } from '@noa/core';
import { PLACEHOLDER } from './channel-row.js';
import type { Config } from './config.js';

/**
 * The sentence a boot with no endpoint reads as. It is deliberately the ONLY
 * place this product says "you have not configured it": the failure is a missing
 * config key, not a client-constructor stack trace.
 */
export const NO_PROVIDER_MESSAGE =
  '还没有配置模型端点：请在 ~/.noa/config.json 里填好 provider.baseURL / provider.apiKey / provider.model'
  + '（apiKey 可用 {env:NAME} 引用环境变量）。';

/**
 * Wall-clock budget for the boot-time id reconciliation.
 *
 * `GET /models` is the first external call of a boot and it runs before anything
 * else can serve traffic: a dead endpoint must not hold the start for the
 * request timeout (120s). Losing the reconciliation only means "use the
 * configured spelling", so the budget is tight.
 */
export const MODEL_RESOLVE_TIMEOUT_MS = 5_000;

/**
 * Build the wire client from config. Returns the concrete class (not the
 * `ChatProvider` interface) because the session plumbing and the title model
 * retarget THIS instance in place.
 * @param config - the loaded config.
 * @returns the client, already reconciled against the endpoint's own catalog.
 */
export async function createProvider(config: Config): Promise<OpenAICompatClient> {
  const endpoint = config.provider;
  if (endpoint === undefined) throw new Error(NO_PROVIDER_MESSAGE);
  // `noa init` writes a starter file whose key is a placeholder. Booting with
  // it would spend a request (and a `GET /models` round trip) to be told "401"
  // from a host that is not the operator's endpoint, so the placeholder is named
  // as what it is: an unconfigured endpoint.
  if (endpoint.apiKey === PLACEHOLDER || endpoint.model === PLACEHOLDER) throw new Error(NO_PROVIDER_MESSAGE);
  const client = new OpenAICompatClient({
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
    model: endpoint.model ?? '',
    ...(endpoint.temperature !== undefined ? { temperature: endpoint.temperature } : {}),
    ...(endpoint.maxTokens !== undefined ? { maxTokens: endpoint.maxTokens } : {}),
  });
  await resolveProviderModel(client);
  return client;
}

/** The model id the config names, as written. */
export function configuredModel(config: Config): string | undefined {
  return config.provider?.model;
}

/**
 * The session-TITLE model's client: another model on the SAME endpoint.
 *
 * Not `setModel` on the main client — that instance is shared by the kernel, the
 * sessions and the running turn, and rewriting it would fight whichever turn is
 * in flight. No id reconciliation either: a title is best-effort, and one more
 * `GET /models` per start is not worth it.
 * @param config - the loaded config.
 * @returns undefined when no endpoint or no title model is configured.
 */
export function createTitleProvider(config: Config): OpenAICompatClient | undefined {
  const endpoint = config.provider;
  if (endpoint === undefined || config.titleModel === undefined) return undefined;
  return new OpenAICompatClient({
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
    model: config.titleModel,
    // A title is a label; the endpoint default is a runaway budget for one line.
    maxTokens: 200,
  });
}

/**
 * Align the configured model name with the endpoint's own spelling.
 *
 * An endpoint's id is its own vocabulary and most gateways compare it verbatim:
 * a name differing only in case is not "close", it is "no such model", and the
 * 5xx that comes back reads exactly like a broken provider. So the request name
 * follows `GET /models`. The judgement itself lives in `core/model-id.ts`
 * (`resolveModelId`) — the ONE definition.
 *
 * **best-effort, never throws**: offline / timeout / auth failure all fall back
 * to the configured spelling and let the endpoint's own error name the model.
 * @param client - the client whose `model` is reconciled IN PLACE (`setModel`).
 * @returns the reconciled id plus whether it differs from the configured one.
 */
export async function resolveProviderModel(
  client: OpenAICompatClient,
): Promise<{ model: string; corrected: boolean }> {
  const configured = client.model;
  const available = await client.listModels(MODEL_RESOLVE_TIMEOUT_MS).catch(() => [] as string[]);
  const model = resolveModelId(configured, available);
  if (model !== configured) client.setModel(model);
  return { model, corrected: model !== configured };
}
