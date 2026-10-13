/**
 * The image rule: what a model in force receives for an attached image.
 *
 * The gate is the behaviour worth pinning hardest, because getting it wrong is
 * silent in both directions — sending bytes to a text-only model produces a
 * provider error the user cannot act on, and dropping bytes for a vision model
 * produces an answer about a picture the model never saw.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admitsOnlyRaster, pngBytes } from './helpers/image-bytes.js';
import { acceptsImages, imageOmittedText, sniffImageMediaType } from '../src/images.js';
import { admitImage, imageDigest, readImage } from '../src/image-store.js';
import { projectRequestImages } from '../src/image-projection.js';
import type { ImageAttachmentRef, UserMessage } from '../src/index.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'nova-img-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function userMessage(content: string, images?: readonly ImageAttachmentRef[]): UserMessage {
  return { id: 'msg_1', ts: 1, role: 'user', content, ...(images === undefined ? {} : { images }) };
}

describe('sniffImageMediaType', () => {
  it('identifies each accepted raster format from its leading bytes', () => {
    expect(sniffImageMediaType(pngBytes())).toBe('image/png');
    expect(sniffImageMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMediaType(new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0))))).toBe('image/gif');
    expect(sniffImageMediaType(new Uint8Array([...'GIF87a'].map((c) => c.charCodeAt(0))))).toBe('image/gif');
    const webp = new Uint8Array(12);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
    expect(sniffImageMediaType(webp)).toBe('image/webp');
  });

  it('refuses a body that only claims to be an image', () => {
    // The decisive case: a caller-supplied MIME type is a claim, and the bytes
    // are the fact. Text announcing itself as PNG must not be stored as one.
    expect(sniffImageMediaType(new TextEncoder().encode('not an image at all'))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
    // Truncated signatures are not partial matches.
    expect(sniffImageMediaType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeUndefined();
  });
});

describe('acceptsImages', () => {
  it('treats an undeclared capability as accepting', () => {
    // The modalities table is a third-party lookup that does not resolve every
    // gateway alias. Reading "unknown" as "blind" would break working vision
    // models, so only a declared negative acts.
    expect(acceptsImages(undefined)).toBe(true);
  });

  it('reads the declaration when there is one', () => {
    expect(acceptsImages(['text', 'image'])).toBe(true);
    expect(acceptsImages(['text'])).toBe(false);
    expect(acceptsImages(['text', 'video'])).toBe(false);
  });
});

describe('admitImage', () => {
  it('stores by content digest and reports the sniffed type', async () => {
    const bytes = pngBytes();
    const result = await admitImage(bytes, 'shot.png', home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ref.mediaType).toBe('image/png');
    expect(result.ref.bytes).toBe(bytes.length);
    expect(result.ref.id).toBe(imageDigest(bytes));
    expect(result.ref.name).toBe('shot.png');
  });

  it('is a no-op for content already stored, so re-pasting costs nothing', async () => {
    const bytes = pngBytes();
    const first = await admitImage(bytes, undefined, home);
    const second = await admitImage(bytes, undefined, home);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.ref.id).toBe(first.ref.id);
  });

  it('refuses empty, oversized and non-raster bodies', async () => {
    expect(await admitImage(new Uint8Array(0), undefined, home)).toEqual({ ok: false, reason: 'empty' });
    expect(await admitImage(new TextEncoder().encode('plain text'), undefined, home))
      .toEqual({ ok: false, reason: 'unsupported-type' });
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    huge.set(pngBytes().subarray(0, 8), 0);
    expect(await admitImage(huge, undefined, home)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('round-trips the exact bytes', async () => {
    const bytes = pngBytes();
    const result = await admitImage(bytes, undefined, home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await readImage(result.ref, home)).toEqual(bytes);
  });

  it('verifies the digest on read, so a corrupted object is not served', async () => {
    const bytes = pngBytes('original');
    const result = await admitImage(bytes, undefined, home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Overwrite the object AT ITS OWN PATH with different bytes. The path
    // exists and is readable, so only the digest comparison can reject it —
    // a test that merely pointed at a missing file would pass without any
    // verification at all.
    const { imagesDir } = await import('../src/image-store.js');
    const leaf = result.ref.id.replace('sha256:', '');
    const other = pngBytes('tampered');
    await writeFile(path.join(imagesDir(home), leaf), other);
    expect(imageDigest(other)).not.toBe(result.ref.id);
    expect(await readImage(result.ref, home)).toBeUndefined();
  });

  it('serves intact bytes back unchanged', async () => {
    // The positive half: verification must not reject a good object.
    const bytes = pngBytes('intact');
    const result = await admitImage(bytes, undefined, home);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await readImage(result.ref, home)).toEqual(bytes);
  });
});

describe('projectRequestImages', () => {
  it('returns the SAME array when no message has images', async () => {
    // Reference identity matters: the auto-compact hook relies on the request
    // messages aliasing the log, so a needless copy would break it.
    const messages = [userMessage('hello')];
    const projected = await projectRequestImages(messages, () => Promise.resolve(['text']), home);
    expect(projected.messages).toBe(messages);
  });

  it('inlines bytes for a model that accepts images', async () => {
    const admitted = await admitImage(pngBytes(), undefined, home);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const projected = await projectRequestImages(
      [userMessage('what is this?', [admitted.ref])],
      () => Promise.resolve(['text', 'image']),
      home,
    );
    const message = projected.messages[0];
    expect(message.role).toBe('user');
    if (message.role !== 'user') return;
    expect(message.content).toBe('what is this?');
    expect(message.resolvedImages).toHaveLength(1);
    expect(message.resolvedImages?.[0]?.mediaType).toBe('image/png');
    expect(message.resolvedImages?.[0]?.data).toBe(Buffer.from(pngBytes()).toString('base64'));
    // The reference survives for the provider's benefit; it is the wire layer
    // that reads `resolvedImages`.
    expect(message.images).toBeUndefined();
  });

  it('replaces every image with an explained placeholder for a text-only model', async () => {
    const admitted = await admitImage(pngBytes(), 'cat.png', home);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const projected = await projectRequestImages(
      [userMessage('what is this?', [admitted.ref])],
      () => Promise.resolve(['text']),
      home,
    );
    const message = projected.messages[0];
    expect(message.role).toBe('user');
    if (message.role !== 'user') return;
    // The user's own words stay first; the placeholder explains the absence.
    expect(message.content.startsWith('what is this?\n')).toBe(true);
    expect(message.content).toContain('text only');
    expect(message.content).toContain('cat.png');
    // No bytes are sent, and the reference is no longer on the wire message.
    expect(message.resolvedImages).toBeUndefined();
    expect(message.images).toBeUndefined();
  });

  it('omits the image for a text-only model even when the bytes are on disk', async () => {
    // Proves the gate reads the CAPABILITY, not merely whether an object exists.
    const admitted = await admitImage(pngBytes(), undefined, home);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(await readImage(admitted.ref, home)).toBeDefined();
    const projected = await projectRequestImages(
      [userMessage('look', [admitted.ref])],
      () => Promise.resolve(['text']),
      home,
    );
    const message = projected.messages[0];
    expect(message.role === 'user' && message.resolvedImages).toBeUndefined();
  });

  it('names an image whose bytes are gone rather than failing the turn', async () => {
    // One lost image must not make an otherwise valid conversation unsendable.
    const ghost: ImageAttachmentRef = { id: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 10 };
    const projected = await projectRequestImages(
      [userMessage('see', [ghost])],
      () => Promise.resolve(['text', 'image']),
      home,
    );
    expect(projected.missing).toEqual([ghost]);
    const message = projected.messages[0];
    expect(message.role).toBe('user');
    if (message.role !== 'user') return;
    // The reason must be the LOST one, not the capability one: this model COULD
    // have accepted the image, and blaming its capabilities would be false.
    expect(message.content).toContain('no longer available');
    expect(message.content).not.toContain('text only');
    expect(message.resolvedImages).toBeUndefined();
  });

  it('resolves one shared image once across messages', async () => {
    const admitted = await admitImage(pngBytes(), undefined, home);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const projected = await projectRequestImages(
      [userMessage('first', [admitted.ref]), userMessage('again', [admitted.ref])],
      () => Promise.resolve(['text', 'image']),
      home,
    );
    for (const message of projected.messages) {
      expect(message.role === 'user' && message.resolvedImages?.[0]?.data)
        .toBe(Buffer.from(pngBytes()).toString('base64'));
    }
  });

  it('reads the capability LIVE, so a mid-session model switch changes the wire form', async () => {
    // The decisive ordering property: an image is attached while a vision model
    // is selected, then the user switches to a text-only one. The SAME logged
    // message must project differently without being rewritten — otherwise the
    // conversation becomes unsendable the moment the model changes.
    const admitted = await admitImage(pngBytes(), undefined, home);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const log = [userMessage('look at this', [admitted.ref])];

    let modalities: readonly string[] | undefined = ['text', 'image'];
    const read = (): Promise<readonly string[] | undefined> => Promise.resolve(modalities);

    const first = await projectRequestImages(log, read, home);
    const firstUser = first.messages[0];
    expect(firstUser.role === 'user' && firstUser.resolvedImages).toHaveLength(1);

    // Switch to a text-only model and re-project the SAME log.
    modalities = ['text'];
    const second = await projectRequestImages(log, read, home);
    const secondUser = second.messages[0];
    expect(secondUser.role === 'user' && secondUser.resolvedImages).toBeUndefined();
    expect(secondUser.role === 'user' && secondUser.content).toContain('text only');
    // The log itself is untouched: references survive for a later switch back.
    expect(log[0]?.images).toHaveLength(1);

    // Switching back restores the bytes, from the same unmodified log.
    modalities = ['text', 'image'];
    const third = await projectRequestImages(log, read, home);
    expect(third.messages[0]?.role === 'user' && third.messages[0].resolvedImages).toHaveLength(1);
  });

  it('never asks for the capability when no message carries an image', async () => {
    // The lookup is a catalog call; a text-only conversation must not pay for it.
    let asked = 0;
    const messages = [userMessage('plain text')];
    await projectRequestImages(messages, () => {
      asked++;
      return Promise.resolve(['text']);
    }, home);
    expect(asked).toBe(0);
  });

  it('leaves assistant and tool messages untouched', async () => {
    const admitted = await admitImage(pngBytes(), undefined, home);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const projected = await projectRequestImages(
      [
        { id: 'a', ts: 2, role: 'assistant', content: 'ok' },
        { id: 't', ts: 3, role: 'tool', toolCallId: 'c', name: 'n', content: 'out' },
        userMessage('img', [admitted.ref]),
      ],
      () => Promise.resolve(['text', 'image']),
      home,
    );
    expect(projected.messages[0]).toMatchObject({ role: 'assistant', content: 'ok' });
    expect(projected.messages[1]).toMatchObject({ role: 'tool', content: 'out' });
  });
});

describe('imageOmittedText', () => {
  it('names the image and the reason, with a short digest', () => {
    const text = imageOmittedText({
      id: `sha256:${'b'.repeat(64)}`,
      mediaType: 'image/png',
      bytes: 1,
      name: 'x.png',
    });
    expect(text).toContain('x.png');
    expect(text).toContain('text only');
    expect(text).toContain('bbbbbbbb');
    // Not the whole digest: this lands in a prompt on every later turn.
    expect(text).not.toContain('b'.repeat(64));
  });

  it('reads sensibly with no name', () => {
    const text = imageOmittedText({ id: 'sha256:abcd1234', mediaType: 'image/png', bytes: 1 });
    expect(text).toContain('omitted');
    expect(text).toContain('abcd1234');
  });
});

describe('helper sanity', () => {
  it('the fixture really is a PNG', () => {
    expect(admitsOnlyRaster()).toBe(true);
  });
});
