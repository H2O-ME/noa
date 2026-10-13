/**
 * Image attachment storage: the durable copy of bytes that have no path.
 *
 * Content-addressed by digest, so the same pasted image is stored once no
 * matter how many times it is sent, and a reference verifies itself on read.
 * Writing is atomic (same-directory temp + rename) and `wx`-flagged, so a
 * concurrent writer cannot truncate an object another session is reading.
 *
 * This directory is NOT a trusted read root and is not meant to be opened by
 * tools: it is a request-side store addressed by `ImageAttachmentRef.id`, not a
 * place users keep files.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cacheRoot } from './paths.js';
import {
  MAX_IMAGE_BYTES,
  sniffImageMediaType,
  type ImageAttachmentRef,
  type ImageMediaType,
} from './images.js';

/** `<cache>/images/` — the one directory holding normalized image bytes. */
export function imagesDir(homedir?: string): string {
  return path.join(cacheRoot(homedir), 'images');
}

/** The object path for a digest id. */
function objectPath(id: string, homedir?: string): string {
  return path.join(imagesDir(homedir), id.replace('sha256:', ''));
}

/** Hex digest of some bytes, in the `sha256:<hex>` form references use. */
export function imageDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Outcome of an admit attempt. */
export type AdmitImageResult =
  | { ok: true; ref: ImageAttachmentRef }
  | { ok: false; reason: 'empty' | 'too-large' | 'unsupported-type' };

/**
 * Verify and durably store one image.
 *
 * The media type is SNIFFED from the bytes; a caller-declared type is not a
 * parameter, because accepting one would let a mislabeled body decide how it is
 * later served. An over-limit or unrecognized body is refused before anything
 * touches disk.
 *
 * Content addressing makes the write idempotent: when the object is already
 * present the bytes are by definition identical, so this returns the reference
 * without writing. That check is explicit rather than a caught `EEXIST` because
 * `rename` reports "target exists" with `EPERM` on Windows — the same code as a
 * genuine permission failure, which must still surface.
 * @param bytes - the exact image bytes.
 * @param name - optional display name; never interpreted as a path.
 * @param homedir - override for tests.
 * @returns the durable reference, or the refusal reason.
 */
export async function admitImage(
  bytes: Uint8Array,
  name?: string,
  homedir?: string,
): Promise<AdmitImageResult> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: 'too-large' };
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === undefined) return { ok: false, reason: 'unsupported-type' };

  const id = imageDigest(bytes);
  const ref: ImageAttachmentRef = {
    id,
    mediaType,
    bytes: bytes.length,
    ...(name === undefined ? {} : { name }),
  };
  const dir = imagesDir(homedir);
  const target = objectPath(id, homedir);
  await mkdir(dir, { recursive: true });
  if (await hasImage(ref, homedir)) return { ok: true, ref };

  const part = `${target}.${process.pid}.${Date.now()}.part`;
  try {
    await writeFile(part, bytes, { flag: 'wx' });
    await rename(part, target);
  } catch (err) {
    await unlink(part).catch(() => undefined);
    throw err;
  }
  return { ok: true, ref };
}

/** Read one stored image's bytes back, or `undefined` when it is gone. */
export async function readImage(
  ref: ImageAttachmentRef,
  homedir?: string,
): Promise<Uint8Array | undefined> {
  try {
    const data = await readFile(objectPath(ref.id, homedir));
    // The id is a digest, so verify rather than trust: a truncated or replaced
    // object must not be served as if it were the image the log names.
    if (imageDigest(data) !== ref.id) return undefined;
    return new Uint8Array(data);
  } catch {
    return undefined;
  }
}

/** Whether the stored bytes for one reference are present and intact. */
export async function hasImage(ref: ImageAttachmentRef, homedir?: string): Promise<boolean> {
  return (await readImage(ref, homedir)) !== undefined;
}

/** Exported for tests that need to assert the media type they stored. */
export type { ImageMediaType };
