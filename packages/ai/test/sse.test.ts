import { describe, expect, it } from 'vitest';
import { MAX_SSE_EVENT_CHARS, MAX_SSE_LINE_CHARS, parseSse } from '../src/sse.js';

async function* bytes(...parts: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  for (const part of parts) yield encoder.encode(part);
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of parseSse(stream)) out.push(ev.data);
  return out;
}

describe('parseSse', () => {
  it('parses data events across chunk boundaries', async () => {
    const datas = await collect(bytes('data: {"a"', ':1}\n\ndata: [DO', 'NE]\n\n'));
    expect(datas).toEqual(['{"a":1}', '[DONE]']);
  });

  it('handles CRLF endings and multi-line data', async () => {
    const datas = await collect(bytes('data: line1\ndata: line2\r\n\r\ndata: x\n'));
    expect(datas).toEqual(['line1\nline2', 'x']);
  });

  it('ignores comments and non-data fields', async () => {
    const datas = await collect(bytes(': ping\nevent: message\ndata: hi\n\n'));
    expect(datas).toEqual(['hi']);
  });

  it('flushes a trailing data line without a final newline', async () => {
    const datas = await collect(bytes('data: tail'));
    expect(datas).toEqual(['tail']);
  });

  it('treats a lone CR as a line ending (SSE spec)', async () => {
    // Killing test: dropping the CR branch makes this hang on one event.
    const datas = await collect(bytes('data: a\r\rdata: b\r\r'));
    expect(datas).toEqual(['a', 'b']);
  });

  it('keeps a CRLF split across two chunks as one line break', async () => {
    // Killing test: treating the LF after a chunk-boundary CR as a blank line
    // emits 'a' prematurely and yields TWO events instead of one.
    const datas = await collect(bytes('data: a\r', '\ndata: b\n\n'));
    expect(datas).toEqual(['a\nb']);
  });

  it('throws when one event exceeds the size bound', async () => {
    // Killing test: without the bound the parser accumulates without limit. Each
    // line stays under the LINE bound, so this exercises the EVENT bound — the
    // single-oversized-line case is the next test.
    const half = 'x'.repeat(Math.floor(MAX_SSE_EVENT_CHARS / 2) + 1);
    const huge = `data: ${half}\ndata: ${half}\n\n`;
    await expect(collect(bytes(huge))).rejects.toThrow(/SSE event exceeded/);
  });

  it('throws when a single unterminated line exceeds the bound', async () => {
    // Killing test: the event cap only counts `data:` payloads, so a line that
    // never ends — a gateway that sends no newline, or a giant comment — grew the
    // parser's `line` buffer without bound and never tripped it.
    const huge = `:${'x'.repeat(MAX_SSE_LINE_CHARS + 1)}`;
    await expect(collect(bytes(huge))).rejects.toThrow(/SSE line exceeded/);
  });
});

