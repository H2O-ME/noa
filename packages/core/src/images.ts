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
 * Whether one model's declared input modalities allow native image content.
 *
 * An ABSENT declaration means YES, not no: the modalities table is a
 * third-party lookup that fails to resolve perfectly ordinary gateway aliases,
 * and treating "we could not find out" as "this model is blind" would silently
 * downgrade a perfectly capable vision model. The declared-negative case is the
 * only one worth acting on.
 * @param inputModalities - the resolved declaration, when one exists.
 * @returns whether image bytes may be sent natively.
 */
export function acceptsImages(inputModalities: readonly string[] | undefined): boolean {
  return inputModalities === undefined || inputModalities.includes('image');
}

/**
 * The text an image becomes when the model in force cannot accept it.
 *
 * The model is told an image existed and was withheld, rather than being handed
 * a silently empty turn — a model that cannot see the image can still say so,
 * and the user learns the model is the reason.
 * @param ref - the withheld image.
 * @returns a stable placeholder naming the image and its digest.
 */
export function imageOmittedText(ref: ImageAttachmentRef): string {
  return `[image${imageLabel(ref)} omitted because this model accepts text only; attachment ${shortDigest(ref)}]`;
}

/**
 * The text an image becomes when its bytes are gone.
 *
 * Kept distinct from {@link imageOmittedText} because the reason differs and the
 * model must not be told otherwise: here the model COULD have accepted the
 * image, so blaming its capabilities would write a false statement into the
 * transcript that every later turn repeats. "No longer available" is the honest
 * claim, and it tells the reader that re-attaching would work.
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
