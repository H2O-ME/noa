export interface SseEvent {
  data: string;
}

/**
 * Cap for one accumulated event's payload. A well-behaved OpenAI-compatible
 * stream never approaches this; an unbounded one (a hostile or broken gateway
 * that never emits a blank line) would otherwise grow the parser's buffers
 * without limit.
 */
export const MAX_SSE_EVENT_CHARS = 8 * 1024 * 1024;

/**
 * Cap for one LINE, counted before the line is even classified.
 *
 * The event cap only counts `data:` payloads, so a stream that never sends a
 * newline — or that sends one enormous comment / unknown field — grew the
 * parser's `line` buffer without bound. A line can never legitimately be longer
 * than a whole event, so it shares the event bound.
 */
export const MAX_SSE_LINE_CHARS = MAX_SSE_EVENT_CHARS;

/** Raised when a stream violates the parser's size bound. */
export class SseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseProtocolError';
  }
}

/**
 * Minimal SSE parser: extracts `data:` payloads, joins multi-line data with
 * newlines, emits on blank-line boundaries. Ignores event:/id:/retry: fields
 * and comment lines — the OpenAI-compatible wire only needs data.
 *
 * Line endings follow the SSE specification: LF, CRLF and a lone CR all end a
 * line, and a CRLF split across two byte chunks is still one break. Accepts any
 * async iterable of byte chunks (fetch ReadableStream qualifies).
 *
 * Invalid UTF-8 is decoded with the platform's replacement character rather
 * than failing the whole stream — a proxy that mangles one byte should not take
 * the reply down, and the payload that follows is still JSON-checked by the
 * caller.
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let line = '';
  let dataLines: string[] = [];
  let dataChars = 0;
  // Set after a CR so the LF of a CRLF pair is swallowed even when the two
  // bytes arrive in different chunks.
  let swallowLF = false;

  const handleLine = (rawLine: string): SseEvent | undefined => {
    if (rawLine === '') {
      if (dataLines.length === 0) return undefined;
      const event: SseEvent = { data: dataLines.join('\n') };
      dataLines = [];
      dataChars = 0;
      return event;
    }
    if (rawLine.startsWith(':')) return undefined;
    if (rawLine.startsWith('data:')) {
      const value = rawLine.slice(5);
      const payload = value.startsWith(' ') ? value.slice(1) : value;
      dataChars += payload.length;
      if (dataChars > MAX_SSE_EVENT_CHARS) {
        throw new SseProtocolError(`SSE event exceeded ${MAX_SSE_EVENT_CHARS} chars`);
      }
      dataLines.push(payload);
    }
    return undefined;
  };

  function* feed(text: string): Generator<SseEvent> {
    for (const ch of text) {
      if (ch === '\n') {
        if (swallowLF) {
          swallowLF = false;
          continue;
        }
        const event = handleLine(line);
        line = '';
        if (event) yield event;
        continue;
      }
      if (ch === '\r') {
        const event = handleLine(line);
        line = '';
        swallowLF = true;
        if (event) yield event;
        continue;
      }
      swallowLF = false;
      line += ch;
      // Bounded HERE, not at `data:` classification: an unterminated line (a
      // hostile gateway that never emits a blank line) or a giant comment would
      // otherwise accumulate forever without ever reaching the event cap.
      if (line.length > MAX_SSE_LINE_CHARS) {
        throw new SseProtocolError(`SSE line exceeded ${MAX_SSE_LINE_CHARS} chars`);
      }
    }
  }

  for await (const chunk of body) {
    yield* feed(decoder.decode(chunk, { stream: true }));
  }

  yield* feed(decoder.decode());
  if (line.length > 0) {
    const event = handleLine(line);
    line = '';
    if (event) yield event;
  }
  if (dataLines.length > 0) {
    yield { data: dataLines.join('\n') };
  }
}
