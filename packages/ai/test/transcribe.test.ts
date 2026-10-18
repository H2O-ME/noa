/**
 * 转写客户端的两条契约：请求的形状，以及两种响应体都能读。
 *
 * 请求必须是 multipart（`file` + `model`）—— Whisper 形状要求如此，GLM 的音频端点
 * 也接受。响应则有两种：Whisper 的 `{ text }` 与 GLM 走 chat completions 路由返回的
 * `{ choices[0].message.content }`。第三种形状必须是**协议错误**而不是空字符串：
 * 空串是合法答案（「引擎没听清」），把坏端点和它混为一谈会让故障看起来像一段静音。
 */
import { describe, expect, it, vi } from 'vitest';
import { ProviderProtocolError } from '../src/retry.js';
import { createTranscribeClient, parseTranscriptBody } from '../src/transcribe.js';

describe('parseTranscriptBody', () => {
  it('reads the Whisper shape', () => {
    expect(parseTranscriptBody(JSON.stringify({ text: '你好世界' }))).toBe('你好世界');
  });

  it('reads the chat-completions shape GLM returns', () => {
    expect(parseTranscriptBody(JSON.stringify({ choices: [{ message: { content: '你好世界' } }] }))).toBe('你好世界');
  });

  it('treats an empty transcript as an empty string, not a failure', () => {
    expect(parseTranscriptBody(JSON.stringify({ text: '' }))).toBe('');
  });

  it('rejects a body that is neither shape', () => {
    expect(() => parseTranscriptBody(JSON.stringify({ ok: true }))).toThrow(ProviderProtocolError);
    expect(() => parseTranscriptBody('not json')).toThrow(ProviderProtocolError);
  });
});

describe('createTranscribeClient', () => {
  it('posts a multipart body with the model and the audio part', async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const client = createTranscribeClient({
      baseURL: 'https://api.example.com/v1/',
      apiKey: 'k',
      model: 'whisper-1',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const transcript = await client.transcribe(Uint8Array.from([1, 2, 3]), { mediaType: 'audio/wav', filename: 'a.wav' });
    expect(transcript).toBe('ok');
    expect(seen[0]?.url).toBe('https://api.example.com/v1/audio/transcriptions');
    const body = seen[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe('a.wav');
    // The multipart boundary must come from the runtime, so no content-type here.
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer k');
    expect(headers['content-type']).toBeUndefined();
  });

  it('short-circuits empty audio without a request', async () => {
    const fetchImpl = vi.fn();
    const client = createTranscribeClient({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'whisper-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.transcribe(new Uint8Array())).toBe('');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('surfaces a terminal HTTP error instead of an empty transcript', async () => {
    const client = createTranscribeClient({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'whisper-1',
      maxRetries: 0,
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.transcribe(Uint8Array.from([1]))).rejects.toThrow(/401/);
  });
});
