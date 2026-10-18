/**
 * The transcription seam: audio in, text out.
 *
 * A capability key rather than a field on `ChatProvider`, for exactly the reason
 * `embeddings.ts` gives: the transcription model is a DIFFERENT model from the
 * chat model (an endpoint that serves one may serve the other, but never under
 * the same id), and the consumer here is a plugin — which cannot read the host's
 * provider config, only declare what it needs and read the service.
 *
 * So the host constructs the client (it is the only layer holding `baseURL` and
 * `apiKey`) and provides it under this key; a plugin that wants transcripts lists
 * the key in `inject` and reads it with `ctx.get(...)`. `get`, not `must`: an
 * install with no `sttModel` configured provides NOTHING, and the consumer is
 * then expected to degrade (the QQ channel answers "voice received, transcription
 * not configured" and keeps the rest of the message) rather than fail to load.
 *
 * Deliberately no SILK decoding and no audio conversion here. The platform hands
 * us a pre-converted WAV URL for voice messages, and QQ's own `asr_refer_text` is
 * free — a decoder would be a dependency this product does not take on.
 */
import { key, type ServiceKey } from './plugin/types.js';

/** One audio clip's identity, as hints for the endpoint. */
export interface TranscribeHints {
  /** The clip's media type when it is known (`audio/wav`, `voice`, …). */
  readonly mediaType?: string;
  /** The clip's filename when it is known; used to pick an extension on the wire. */
  readonly filename?: string;
}

/** What a consumer of the transcription seam needs: text for audio bytes. */
export interface TranscriptionClient {
  /**
   * The model id in force, as the endpoint spells it. Read by consumers that must
   * label which engine produced a transcript.
   */
  readonly model: string;
  /**
   * Transcribe one clip.
   * @param bytes - the audio bytes.
   * @param hints - optional media type / filename for the multipart part.
   * @returns the transcript; an empty string means the engine heard nothing.
   */
  transcribe(bytes: Uint8Array, hints?: TranscribeHints): Promise<string>;
}

/**
 * The transcription client, when the install has one.
 *
 * Absent (no provider / no `sttModel`) is a supported state, not a
 * misconfiguration: read it with `ctx.get` and degrade.
 */
export const transcription: ServiceKey<TranscriptionClient> = key<TranscriptionClient>('transcription');
