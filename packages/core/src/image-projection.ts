/**
 * Image projection for one request: the point where the model in force decides
 * what an image becomes.
 *
 * The decision is made HERE, per request, and not when the image was captured.
 * That ordering is the whole design: the user may attach an image while a
 * vision model is selected and then switch to a text-only one, and the
 * conversation must stay replayable rather than becoming un-sendable. dsh
 * reaches the same place from the same reasoning (`llm/src/index.ts`, the
 * `inputModalities` guard) — the durable log keeps the image, and only the wire
 * form changes.
 *
 * Two branches, and the asymmetry is deliberate:
 *
 *  - **The model accepts images** → the bytes are inlined as data URIs, so the
 *    model actually sees the picture.
 *  - **It does not** → every image becomes `imageOmittedText`, a placeholder
 *    that NAMES the image and says why it is absent. Dropping it silently would
 *    leave the model answering a question about a picture it cannot see with no
 *    indication anything was withheld, which reads to the user as the model
 *    being obtuse rather than blind.
 *
 * An UNDECLARED capability counts as accepting (see `acceptsImages`): the
 * modalities table is a third-party lookup that does not resolve every gateway
 * alias, and guessing "blind" from "unknown" would break vision models that
 * work perfectly well.
 */
import { acceptsImages, imageLostText, imageOmittedText, type ImageAttachmentRef } from './images.js';
import type { AgentMessage, ResolvedImage } from './types.js';
import { readImage } from './image-store.js';

/** Read the stored bytes for one reference and encode them for the wire. */
async function resolveOne(
  ref: ImageAttachmentRef,
  homedir: string | undefined,
): Promise<ResolvedImage | undefined> {
  const bytes = await readImage(ref, homedir);
  // A missing object is not fatal: the message degrades to its placeholder
  // text rather than failing the whole turn, because one lost image must not
  // make an otherwise valid conversation un-sendable.
  if (bytes === undefined) return undefined;
  return { mediaType: ref.mediaType, data: Buffer.from(bytes).toString('base64') };
}

/**
 * Project one request's messages for the model in force.
 *
 * Returns the SAME array when nothing needed projecting, so the common
 * text-only conversation allocates nothing and stays reference-identical to
 * `opts.messages` (the auto-compact hook relies on that identity). The
 * capability lookup is ASYNC and consulted only when a message actually carries
 * an image, so a conversation without images never pays for it.
 * @param messages - the request's messages, in log form.
 * @param readModalities - reads the model's declared input modalities, when the
 *   assembly can answer. Async because the answer comes from the model catalog,
 *   and a cached SYNCHRONOUS value could be stale in the dangerous direction: a
 *   switch to a text-only model would keep sending bytes that model rejects.
 * @param homedir - override for tests.
 * @returns messages ready for the provider, plus every image that could not be
 *   resolved (so the caller can report a real data loss rather than hide it).
 */
export async function projectRequestImages(
  messages: readonly AgentMessage[],
  readModalities?: () => Promise<readonly string[] | undefined>,
  homedir?: string,
): Promise<{ messages: readonly AgentMessage[]; missing: readonly ImageAttachmentRef[] }> {
  const withImages = messages.filter(
    (m): m is Extract<AgentMessage, { role: 'user' }> =>
      m.role === 'user' && m.images !== undefined && m.images.length > 0,
  );
  if (withImages.length === 0) return { messages, missing: [] };

  // Asked only now, and asked LIVE: the model may have been switched since the
  // image was attached, and this is the one decision that must follow it.
  const inputModalities = readModalities === undefined ? undefined : await readModalities();
  const native = acceptsImages(inputModalities);
  const missing: ImageAttachmentRef[] = [];
  const resolved = new Map<string, ResolvedImage>();

  if (native) {
    // Resolve each distinct image once even when several messages share it.
    const distinct = new Map<string, ImageAttachmentRef>();
    for (const message of withImages) {
      for (const ref of message.images ?? []) distinct.set(ref.id, ref);
    }
    for (const [id, ref] of distinct) {
      const image = await resolveOne(ref, homedir);
      if (image === undefined) missing.push(ref);
      else resolved.set(id, image);
    }
  }

  return {
    missing,
    messages: messages.map((message) => {
      if (message.role !== 'user' || message.images === undefined || message.images.length === 0) {
        return message;
      }
      const { images, ...rest } = message;
      // Text-only model: every image becomes a placeholder, appended after the
      // words the user typed so their sentence still reads first.
      if (!native) {
        const omitted = images.map(imageOmittedText).join('\n');
        return { ...rest, content: `${message.content}\n${omitted}` };
      }
      // Native model: resolved images become content, and anything that failed
      // to resolve becomes a placeholder rather than silently vanishing — the
      // model should know an attachment was lost, and so should the caller.
      const usable: ResolvedImage[] = [];
      const lost: ImageAttachmentRef[] = [];
      for (const ref of images) {
        const image = resolved.get(ref.id);
        if (image === undefined) lost.push(ref);
        else usable.push(image);
      }
      if (usable.length === 0) {
        const lostText = lost.map(imageLostText).join('\n');
        return { ...rest, content: `${message.content}\n${lostText}` };
      }
      return {
        ...rest,
        resolvedImages: usable,
        content: lost.length === 0
          ? message.content
          : `${message.content}\n${lost.map(imageLostText).join('\n')}`,
      };
    }),
  };
}
