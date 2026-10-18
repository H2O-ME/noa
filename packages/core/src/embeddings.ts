/**
 * The embedding seam: text in, vectors out.
 *
 * A capability key rather than a field on `ChatProvider` for two reasons that
 * are the same reason: the embedding model is a DIFFERENT model from the chat
 * model (an endpoint that serves one usually serves the other, but never under
 * the same id), and the consumer here is a plugin, which cannot read the host's
 * provider config — it can only declare what it needs and read the service.
 *
 * So the host constructs the client (it is the only layer holding `baseURL` and
 * `apiKey`) and provides it under this key; a plugin that wants vectors lists
 * the key in `inject` and reads it with `ctx.get(...)`. `get`, not `must`: an
 * install with no `embedModel` configured provides NOTHING, and a consumer is
 * then expected to degrade (the memory plugin falls back to keyword scoring)
 * rather than fail to load.
 *
 * The interface is deliberately minimal — one call, no batching policy, no
 * dimension query. Batching belongs to the implementation (the wire has an
 * inputs-per-request limit that is the provider's business), and the dimension
 * is discovered from the first response, which is the only honest source.
 */
import { key, type ServiceKey } from './plugin/types.js';

/** What a consumer of the embedding seam needs: vectors for texts, in order. */
export interface EmbeddingClient {
  /**
   * The model id in force, as the endpoint spells it. Read by consumers that
   * must invalidate a stored vector when the model changes — vectors from two
   * different models are not comparable, and a silent mix would rank garbage.
   */
  readonly model: string;
  /**
   * Embed each text, returning one vector per input IN THE SAME ORDER.
   *
   * @param texts - the texts to embed. An empty array resolves to `[]` without
   *   a request.
   * @returns one vector per input, same order, same length.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/**
 * The embedding client, when the install has one.
 *
 * Absent (no provider / no `embedModel`) is a supported state, not a
 * misconfiguration: read it with `ctx.get` and degrade.
 */
export const embeddings: ServiceKey<EmbeddingClient> = key<EmbeddingClient>('embeddings');
