/**
 * `~/.noa/config.json` → the two things the kernel needs: the OpenAI-
 * compatible client, and the model id a request will actually carry.
 *
 * Ported from nova's `packages/cli/src/kernel-config.ts` +
 * `provider-model-resolve.ts`, with the multi-endpoint store left behind: this
 * product has ONE endpoint, and the provider block is where it lives.
 */
import { createEmbedClient, createTranscribeClient, OpenAICompatClient } from '@noa/ai';
import { resolveModelId, type EmbeddingClient, type TranscriptionClient } from '@noa/core';
import { REVIEW_MAX_TOKENS } from '@noa/plugins';
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
    ...(endpoint.fallbacks !== undefined ? { fallbacks: endpoint.fallbacks } : {}),
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
 * The smart-approval reviewer's client: another model on the SAME endpoint.
 *
 * Reuses `provider.baseURL` / `apiKey` and takes the model from `reviewModel`,
 * falling back to the main model when it is unset — so an operator who configures
 * nothing still gets a working (if unisolated) reviewer, and one who names a
 * cheap model gets a genuinely separate classifier. `temperature: 0` and a tiny
 * token budget because the answer is one word; no id reconciliation, because a
 * reviewer that names an unknown model fails closed (escalates to the human).
 * @param config - the loaded config.
 * @returns undefined when no endpoint is configured.
 */
export function createReviewProvider(config: Config): OpenAICompatClient | undefined {
  const endpoint = config.provider;
  if (endpoint === undefined) return undefined;
  return new OpenAICompatClient({
    baseURL: endpoint.baseURL,
    apiKey: endpoint.apiKey,
    model: config.reviewModel ?? endpoint.model ?? '',
    temperature: 0,
    maxTokens: REVIEW_MAX_TOKENS,
  });
}

/**
 * The embedding client: a DIFFERENT kind of model on the SAME endpoint.
 *
 * Unlike the reviewer there is NO fallback to the main model. An embedding
 * request carries `input` and returns vectors, and a chat model id sent to
 * `/embeddings` is a 404 — so "no `embedModel` configured" must mean NO
 * EMBEDDING CLIENT, which the memory plugin reads as "degrade to keyword
 * scoring". Falling back would turn an unconfigured install into an install
 * that fails every recall with an endpoint error.
 *
 * No id reconciliation either: a `GET /models` on every boot to correct a name
 * we may not even use is a cost with no matching benefit, and the plugin
 * degrades on the first failure anyway.
 * @param config - the loaded config.
 * @returns undefined when there is no endpoint or no `embedModel`.
 */
export function createEmbedProvider(config: Config): EmbeddingClient | undefined {
  const endpoint = config.provider;
  if (endpoint === undefined) return undefined;
  const model = config.embedModel;
  // The starter file's placeholder is an unconfigured value, exactly as it is for
  // the main model: constructing a client for it would spend a round trip to be
  // told "401" by a host that is not the operator's.
  if (model === undefined || model === PLACEHOLDER) return undefined;
  return createEmbedClient({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, model });
}

/**
 * The transcription client: the same "no fallback" rule as the embedding client.
 *
 * `sttModel` is a DIFFERENT model id from `provider.model`, and a chat model id
 * sent to `/audio/transcriptions` is a 404 — so "no `sttModel` configured" must
 * mean NO TRANSCRIPTION CLIENT, which the QQ channel reads as "answer
 * 「未配置转写」and keep the rest of the message".
 * @param config - the loaded config.
 * @returns undefined when there is no endpoint or no `sttModel`.
 */
export function createTranscribeProvider(config: Config): TranscriptionClient | undefined {
  const endpoint = config.provider;
  if (endpoint === undefined) return undefined;
  const model = config.sttModel;
  if (model === undefined || model === PLACEHOLDER) return undefined;
  return createTranscribeClient({ baseURL: endpoint.baseURL, apiKey: endpoint.apiKey, model });
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
