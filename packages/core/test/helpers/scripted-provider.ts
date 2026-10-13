/**
 * Shared scripted provider for the core test suite (M9.7 阶段 J dedup). Five
 * tests previously hand-wrote the same fixture with minor drift (some took a
 * `capture` array, some ignored the request). The capture-capable form is a
 * strict superset — `capture` is optional — so all five call sites use this.
 *
 * Behavior: each call advances to the next script; running past the end of
 * the script list yields an empty stream (the agent loop treats empty-
 * completion as a pathology and retries — exactly what these tests want).
 */
import type { ChatProvider, ChatRequest, StreamEvent } from '../../src/types.js';

export function scriptedProvider(scripts: StreamEvent[][], capture?: ChatRequest[]): ChatProvider {
  let call = 0;
  return {
    async *stream(req: ChatRequest) {
      capture?.push(req);
      const events = scripts[call] ?? [];
      call += 1;
      for (const ev of events) yield ev;
    },
  };
}

/** Drain an async generator into an array (paired with scriptedProvider). */
export async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}
