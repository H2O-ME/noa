/**
 * Durable image attachments: the ONE kind of content this product sends to a
 * model as bytes rather than as text.
 *
 * The distinction from a file reference is the whole point of this module. A
 * file already has a path, and the model reads it with its own tools, so it
 * crosses the wire as a TEXT handle (`@path`) and never as bytes. An image the
 * user PASTED has no path anywhere — a browser hands over clipboard bytes and
 * nothing else — so if those bytes are not sent to the model, no amount of
 * later file reading can recover them. Images are therefore the single case
 * where a copy is not duplication but the only representation that exists.
 *
 * Storage is content-addressed by the digest of the exact bytes, which makes
 * re-pasting the same image a no-op and makes a reference self-verifying.
 */

/** Raster formats the request path accepts. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** Every accepted media type, in a stable order (menus and errors read it). */
export const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * One durable image reference, as it is logged and as it crosses the wire.
 *
 * Carries no path and no bytes: the path is a storage-layout detail this module
 * owns, and the bytes are fetched only at request assembly. A reference stays
 * valid across sessions because `id` is the digest of the content.
 */
export interface ImageAttachmentRef {
  /** Content digest, `sha256:<hex>`. Also the stored object's leaf name. */
  id: string;
  /** Media type verified from the stored bytes, never the caller's claim. */
  mediaType: ImageMediaType;
  /** Exact byte length. */
  bytes: number;
  /** Display name from the source, when it had one. Never a path. */
  name?: string;
}

/**
 * Declared limits. Deliberately conservative: an image is resent on every
 * request in the conversation, so an oversized one taxes every later turn.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;

/** Why an image was refused, as a machine-readable code. */
export type ImageRefusal =
  | 'too-large'
  | 'unsupported-type'
  | 'too-many'
  | 'empty';

/**
 * Identify an image from its leading bytes, ignoring any caller-supplied type.
 *
 * A declared MIME type is a claim by whoever sent it; the bytes are the fact.
 * A `text/plain` body announcing itself as PNG must not be stored as one, and
 * an extension is not consulted at all.
 * @param bytes - the leading bytes of the candidate.
 * @returns the verified media type, or `undefined` when it is not a raster image.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  // RIFF….WEBP — the four size bytes between the two tags are not inspected:
  // they describe a container length, not the format, and a mismatch there is
  // the decoder's business rather than this gate's.
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/**
 * What to do with an image, given the model's declared input modalities.
 *
 * Three states, not two, because the two ways of "sending it" are not equally
 * trustworthy:
 *
 *  - `inline` — the model DECLARED it takes images. Send the bytes and say
 *    nothing extra; the picture is the message.
 *  - `inline-unverified` — nobody declared anything (see {@link acceptsImages}).
 *    Send the bytes, and ALSO name the file's path, because this is the one case
 *    where the request can silently fail: a gateway that does not support image
 *    parts may drop them and return 200 anyway, leaving the model with a question
 *    about a picture it was never given. Observed in the field — the model then
 *    answered as if no attachment had arrived and invented capabilities to
 *    explain it. Naming the path costs one line and gives the model something
 *    true to say instead.
 *  - `omit` — the model DECLARED text only. The bytes are not sent at all, and
 *    the path is the whole of what the model gets.
 */
export type ImagePolicy = 'inline' | 'inline-unverified' | 'omit';

/**
 * The policy for one model's declared input modalities.
 *
 * An ABSENT declaration means SEND IT, not "do not": the modalities table is a
 * third-party lookup that fails to resolve perfectly ordinary gateway aliases,
 * and treating "we could not find out" as "this model is blind" would silently
 * downgrade a perfectly capable vision model. The declared-negative case is the
 * only one worth acting on — hence `inline-unverified` rather than `omit`.
 * @param inputModalities - the resolved declaration, when one exists.
 * @returns what to do with an image.
 */
export function imagePolicy(inputModalities: readonly string[] | undefined): ImagePolicy {
  if (inputModalities === undefined) return 'inline-unverified';
  return inputModalities.includes('image') ? 'inline' : 'omit';
}

/**
 * Whether one model's declared input modalities allow native image content.
 *
 * The binary reading of {@link imagePolicy}, for callers that only need to know
 * whether the bytes go out — the projection needs the third state, because it
 * also has to decide what to SAY.
 * @param inputModalities - the resolved declaration, when one exists.
 * @returns whether image bytes may be sent natively.
 */
export function acceptsImages(inputModalities: readonly string[] | undefined): boolean {
  return imagePolicy(inputModalities) !== 'omit';
}

/**
 * The text an image becomes when the model in force cannot accept it.
 *
 * The model is told an image existed and was withheld, rather than being handed
 * a silently empty turn — a model that cannot see the image can still say so,
 * and the user learns the model is the reason.
 *
 * The path is included because the alternative is a dead end: told only "an
 * image was withheld", the model can do nothing but apologise. Told where the
 * file is, it can say where the attachment went, and a tool that can read files
 * has something to work with.
 * @param ref - the withheld image.
 * @param path - where its bytes live, when the caller can say.
 * @returns a stable placeholder naming the image and its location.
 */
export function imageOmittedText(ref: ImageAttachmentRef, path?: string): string {
  const where = path === undefined ? `attachment ${shortDigest(ref)}` : `saved at ${path}`;
  return `[image${imageLabel(ref)} omitted because this model accepts text only; ${where}]`;
}

/**
 * The text appended to an image whose acceptance could not be CONFIRMED.
 *
 * Sent alongside the bytes, never instead of them. It exists because the
 * failure it guards against is invisible from here: a gateway that ignores
 * image parts answers 200, so nothing in this process can tell "the model saw
 * it" from "the model was handed a question about nothing". Naming the path and
 * asking for a plain admission is the only signal available.
 * @param ref - the image being sent.
 * @param path - where its bytes live.
 * @returns the one-line note appended after the user's own words.
 */
export function imageUnverifiedText(ref: ImageAttachmentRef, path: string): string {
  return `[image${imageLabel(ref)} is attached above and also saved at ${path}; `
    + 'if you cannot see it, say so plainly instead of guessing at its contents]';
}

/**
 * The text an image becomes when its bytes are gone.
 *
 * Kept distinct from {@link imageOmittedText} because the reason differs and the
 * model must not be told otherwise: here the model COULD have accepted the
 * image, so blaming its capabilities would write a false statement into the
 * transcript that every later turn repeats. "No longer available" is the honest
 * claim, and it tells the reader that re-attaching would work. No path here on
 * purpose: the file is gone, so naming a location would be a second false claim.
 * @param ref - the lost image.
 * @returns a stable placeholder naming the image and its digest.
 */
export function imageLostText(ref: ImageAttachmentRef): string {
  return `[image${imageLabel(ref)} is no longer available and was not sent; attachment ${shortDigest(ref)}]`;
}

/** ` name` for a named image, empty otherwise. */
function imageLabel(ref: ImageAttachmentRef): string {
  return ref.name === undefined ? '' : ` ${ref.name}`;
}

/** The digest, shortened: this lands in a prompt on every later turn. */
function shortDigest(ref: ImageAttachmentRef): string {
  const hex = ref.id.startsWith('sha256:') ? ref.id.slice(7) : ref.id;
  return `sha256:${hex.slice(0, 8)}`;
}
