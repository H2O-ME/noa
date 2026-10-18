/**
 * 入站图片与通道健壮性的三条契约。
 *
 *  1. **一张没有配文的图不是空消息**：`parseInbound` 以前要求 `content` 非空，于是
 *     每个「只发图」的消息都被静静丢掉。这里钉的是它与下游 `replyOnce` 的配合。
 *  2. **附件分类**：`content_type === 'file'` 是显式上传，绝不路由到语音识别；这是
 *     Hermes 里一条容易踩错的正确性细节，值得钉住。
 *  3. **去重有 TTL**：一个永不失效的容量集合会把很久之后复用同一 id 的消息当重复。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from '@noa/core';
import { InboundHandler } from '../src/inbound.js';
import { classifyAttachment, resolveInboundImages, resolveInboundVoice } from '../src/media-inbound.js';
import { parseAttachments, parseInbound } from '../src/types.js';
import type { ReplySink } from '../src/reply.js';
import type { TurnInput } from '../src/types.js';

/** 一段最小的合法 PNG（签名 + IHDR 头即可被 `admitImage` 认作 PNG）。 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

/**
 * 一次性的 home：入站图片是内容寻址落盘的，测试必须把它指到临时目录，否则会往操作者
 * 真实的 `~/.noa/cache/images` 里写东西。
 */
let home: string;
beforeAll(async () => { home = await mkdtemp(path.join(tmpdir(), 'noa-qq-media-')); });
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe('inbound attachments', () => {
  it('treats an image-only message as a message, not an empty one', () => {
    const parsed = parseInbound('C2C_MESSAGE_CREATE', {
      id: 'm1',
      author: { user_openid: 'U1' },
      content: '',
      attachments: [{ content_type: 'image/png', url: 'https://cdn.qq.com/a.png' }],
    });
    expect(parsed?.message.content).toBe('');
    expect(parsed?.message.attachments).toHaveLength(1);
  });

  it('still refuses a payload with neither text nor a usable attachment', () => {
    expect(parseInbound('C2C_MESSAGE_CREATE', { id: 'm1', author: { user_openid: 'U1' }, content: '' }))
      .toBeUndefined();
    // An attachment with no URL is not usable: the message is empty.
    expect(parseInbound('C2C_MESSAGE_CREATE', {
      id: 'm1',
      author: { user_openid: 'U1' },
      content: '',
      attachments: [{ content_type: 'image/png' }],
    })).toBeUndefined();
  });

  it('classifies voice, image and file, and never routes `file` to speech', () => {
    expect(classifyAttachment({ content_type: 'voice' })).toBe('voice');
    expect(classifyAttachment({ content_type: 'audio/amr' })).toBe('voice');
    expect(classifyAttachment({ content_type: 'image/jpeg' })).toBe('image');
    expect(classifyAttachment({ content_type: 'video/mp4' })).toBe('other');
    // The correctness detail: an uploaded .wav is a FILE, not a voice message.
    expect(classifyAttachment({ content_type: 'file', filename: 'a.wav' })).toBe('other');
    // No content_type at all: fall back to the filename.
    expect(classifyAttachment({ filename: 'a.silk' })).toBe('voice');
  });

  it('keeps only attachments that carry a URL', () => {
    const kept = parseAttachments([
      { url: 'https://cdn.qq.com/a.png', content_type: 'image/png', size: 12 },
      { content_type: 'image/png' },
      'nonsense',
      null,
    ]);
    expect(kept).toEqual([{ url: 'https://cdn.qq.com/a.png', content_type: 'image/png', size: 12 }]);
  });

  it('admits a downloaded image into the kernel image store', async () => {
    const resolved = await resolveInboundImages(
      [{ content_type: 'image/png', url: 'https://cdn.qq.com/a.png', filename: 'a.png' }],
      async () => PNG_BYTES,
      home,
    );
    expect(resolved.failures).toEqual([]);
    expect(resolved.images).toHaveLength(1);
    expect(resolved.images[0]?.mediaType).toBe('image/png');
    expect(resolved.images[0]?.name).toBe('a.png');
  });

  it('reports a download failure per image instead of dropping the message', async () => {
    const resolved = await resolveInboundImages(
      [{ content_type: 'image/png', url: 'https://cdn.qq.com/a.png' }],
      async () => { throw new Error('502'); },
      home,
    );
    expect(resolved.images).toEqual([]);
    expect(resolved.failures[0]).toContain('下载失败');
  });
});

describe('inbound images reach the brain', () => {
  /** 记录 brain 收到的 TurnInput，并立即回一句。 */
  function handlerWith(fetchMedia?: (url: string) => Promise<Uint8Array>): { handler: InboundHandler; turns: TurnInput[] } {
    const turns: TurnInput[] = [];
    const reply: ReplySink = { reply: () => Promise.resolve({ ok: true }) };
    const handler = new InboundHandler({
      brain: (turn) => { turns.push(turn); return Promise.resolve({ text: 'ok' }); },
      reply,
      log: () => undefined,
      mediaHomedir: home,
      ...(fetchMedia !== undefined ? { fetchMedia } : {}),
    });
    return { handler, turns };
  }

  /** Image admission does real fs I/O, so a single tick is not enough to see it. */
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  it('passes resolved image references to the brain for an image-only message', async () => {
    const { handler, turns } = handlerWith(async () => PNG_BYTES);
    handler.onDispatch({
      t: 'C2C_MESSAGE_CREATE',
      d: {
        id: 'm1',
        author: { user_openid: 'U1' },
        content: '',
        attachments: [{ content_type: 'image/png', url: 'https://cdn.qq.com/a.png' }],
      },
    });
    await until(() => turns.length > 0);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.text).toBe('');
    expect(turns[0]?.images).toHaveLength(1);
  });

  it('answers honestly when a media-only message has nothing readable', async () => {
    const replies: string[] = [];
    const reply: ReplySink = { reply: (_peerId, content) => { replies.push(content); return Promise.resolve({ ok: true }); } };
    const handler = new InboundHandler({
      brain: () => Promise.resolve({ text: 'should not run' }),
      reply,
      log: () => undefined,
      mediaHomedir: home,
      fetchMedia: async () => { throw new Error('down'); },
    });
    handler.onDispatch({
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'm1', author: { user_openid: 'U1' }, content: '', attachments: [{ content_type: 'image/png', url: 'https://cdn.qq.com/a.png' }] },
    });
    await until(() => replies.length > 0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('没有我能读到的东西');
  });
});

describe('dedupe TTL', () => {
  it('treats a reused msg_id after the window as a new message', async () => {
    // A capacity-bounded Set never forgot, so a message whose id came round again
    // (or a reconnect replay) was silently swallowed.
    const seen: string[] = [];
    const reply: ReplySink = { reply: () => Promise.resolve({ ok: true }) };
    const handler = new InboundHandler({
      brain: (turn) => { seen.push(turn.text); return Promise.resolve({ text: 'ok' }); },
      reply,
      log: () => undefined,
    });
    const message = (content: string): unknown => ({ id: 'SAME', group_openid: 'g1', author: { member_openid: 'u1' }, content });
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: message('first') });
    await settle();
    handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: message('second') });
    await settle();
    // Within the window it is a duplicate: only the first ran.
    expect(seen).toEqual(['first']);

    // Past the TTL, the same id is a new message.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try {
      handler.onDispatch({ t: 'GROUP_AT_MESSAGE_CREATE', d: message('third') });
      await settle();
    } finally {
      Date.now = realNow;
    }
    expect(seen).toEqual(['first', 'third']);
  });
});

describe('inbound voice', () => {
  const noFetch = async (): Promise<Uint8Array> => { throw new Error('must not download'); };

  it("prefers the platform's free asr_refer_text and does not download", async () => {
    const blocks = await resolveInboundVoice(
      [{ content_type: 'voice', url: 'https://cdn.qq.com/a.silk', asr_refer_text: '  你好  ' }],
      noFetch,
      async () => { throw new Error('transcriber must not run when asr_refer_text is present'); },
    );
    expect(blocks.blocks).toEqual(['[语音] 你好']);
  });

  it('transcribes from the pre-converted wav url, avoiding SILK decoding', async () => {
    const fetched: string[] = [];
    const blocks = await resolveInboundVoice(
      [{ content_type: 'voice', url: 'https://cdn.qq.com/a.silk', voice_wav_url: '//cdn.qq.com/a.wav' }],
      async (url) => { fetched.push(url); return Uint8Array.from([1, 2, 3]); },
      async (bytes, hints) => {
        expect(bytes).toEqual(Uint8Array.from([1, 2, 3]));
        expect(hints.mediaType).toBe('voice');
        return '转录结果';
      },
    );
    expect(fetched).toEqual(['https://cdn.qq.com/a.wav']);
    expect(blocks.blocks).toEqual(['[语音] 转录结果']);
  });

  it('degrades honestly when no transcriber is configured', async () => {
    const blocks = await resolveInboundVoice(
      [{ content_type: 'voice', url: 'https://cdn.qq.com/a.silk' }],
      noFetch,
      undefined,
    );
    expect(blocks.blocks).toEqual(['（收到一条语音，未配置转写）']);
  });

  it('reports a transcription failure as a block rather than dropping the message', async () => {
    const blocks = await resolveInboundVoice(
      [{ content_type: 'voice', url: 'https://cdn.qq.com/a.silk' }],
      async () => { throw new Error('502'); },
      async () => 'never',
    );
    expect(blocks.blocks[0]).toContain('语音转写失败');
  });

  it('never routes a `file` upload into speech recognition', async () => {
    const blocks = await resolveInboundVoice(
      [{ content_type: 'file', filename: 'a.wav', url: 'https://cdn.qq.com/a.wav' }],
      noFetch,
      async () => { throw new Error('a file upload is not a voice message'); },
    );
    expect(blocks.blocks).toEqual([]);
  });
});

describe('isSafeHttpUrl', () => {
  it('allows ordinary CDN URLs and refuses non-http schemes', () => {
    expect(isSafeHttpUrl('https://multimedia.nt.qq.com.cn/a.png')).toBe(true);
    expect(isSafeHttpUrl('http://cdn.example.com/a.png')).toBe(true);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('ftp://cdn.example.com/a.png')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });

  it('refuses loopback and private literals', () => {
    expect(isSafeHttpUrl('http://127.0.0.1/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://localhost/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://10.0.0.5/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://192.168.1.1/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://172.16.0.1/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://169.254.1.1/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://[::1]/a.png')).toBe(false);
    expect(isSafeHttpUrl('http://[::ffff:127.0.0.1]/a.png')).toBe(false);
  });
});
