/**
 * Durable chat → session bindings, and session relay.
 *
 * These are the two properties the channel exists for, and both were WRONG in the
 * first cut: every chat got a fresh isolated session per message, so
 *
 *  - a restart silently started every conversation over (fatal for a headless
 *    server, where the whole point is a persistent relationship), and
 *  - a phone could not drive the conversation a DESKTOP was working in, which is
 *    the entire reason for having the channel (会话接力 — passing the baton).
 *
 * The binding is stored as the session's LOG FILE, because that is the durable
 * identity a resume reopens; the in-memory id is minted per process.
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BindingsStore } from '../src/bindings.js';
import { ProgressRelay } from '../src/progress.js';

describe('BindingsStore', () => {
  it('survives a reload, because the document is the binding', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noa-bind-'));
    const file = path.join(dir, 'nested', 'bindings.json');
    const first = new BindingsStore(file);
    await first.load();
    await first.set('c2c:U1', { kind: 'relay', file: '/logs/a.jsonl' });

    // A new process reads what the previous one wrote — this is the whole reason
    // the binding is on disk instead of in a Map.
    const reloaded = new BindingsStore(file);
    await reloaded.load();
    expect(reloaded.get('c2c:U1')).toEqual({ kind: 'relay', file: '/logs/a.jsonl' });
  });

  it('reads a corrupt document as "no bindings" rather than guessing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noa-bind-'));
    const file = path.join(dir, 'bindings.json');
    const store = new BindingsStore(file);
    await store.load();
    await store.set('c2c:U1', { kind: 'own', file: '/logs/a.jsonl' });

    // Truncate it, then reload: half a document must not be repaired into a
    // binding attached to the wrong conversation.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{"version":1,"chats":{"c2c:U1":{"kind":"relay"', 'utf8');
    const reloaded = new BindingsStore(file);
    await reloaded.load();
    expect(reloaded.get('c2c:U1')).toBeUndefined();

    // A later write restores a usable document.
    await reloaded.set('c2c:U2', { kind: 'own', file: '/logs/b.jsonl' });
    const reread = new BindingsStore(file);
    await reread.load();
    expect(reread.get('c2c:U2')).toEqual({ kind: 'own', file: '/logs/b.jsonl' });
  });

  it('keeps concurrent writes from losing one another', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noa-bind-'));
    const file = path.join(dir, 'bindings.json');
    const store = new BindingsStore(file);
    await store.load();
    // Ten chats binding at once: an unserialized read-modify-write chain loses
    // most of them.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.set(`c2c:U${i}`, { kind: 'own', file: `/logs/${i}.jsonl` })),
    );
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { chats: Record<string, unknown> };
    expect(Object.keys(parsed.chats)).toHaveLength(10);
  });

  it('refuses malformed entries instead of admitting half a binding', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'noa-bind-'));
    const file = path.join(dir, 'bindings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      file,
      JSON.stringify({ version: 1, chats: { 'c2c:A': { kind: 'relay' }, 'c2c:B': { kind: 'own', file: '/l/b' }, 'c2c:C': 'nope' } }),
      'utf8',
    );
    const store = new BindingsStore(file);
    await store.load();
    // No file ⇒ nothing to resume; admitting it would open an empty session and
    // call it the same conversation.
    expect(store.get('c2c:A')).toBeUndefined();
    expect(store.get('c2c:C')).toBeUndefined();
    expect(store.get('c2c:B')).toEqual({ kind: 'own', file: '/l/b' });
  });
});

describe('ProgressRelay', () => {
  /** A realistic (far-from-zero) clock, so the throttle baseline is really exercised. */
  const T0 = 1_700_000_000_000;

  it('says nothing before the answer — no receipt, no immediate progress', () => {
    // The complaint this encodes: every inbound message drew a "收到，开始处理"
    // receipt, so a quick answer cost the peer TWO messages and the reader learned
    // nothing. Narration is now the work itself, and it waits for the interval.
    let clock = T0;
    const sent: string[] = [];
    const relay = new ProgressRelay({ send: (line) => sent.push(line), minIntervalMs: 1_000, now: () => clock });
    relay.tool('read_file');
    expect(sent).toEqual([]);
    relay.final('这是结论');
    expect(sent).toEqual(['这是结论']);
  });

  it('coalesces tools inside one interval and throttles', () => {
    let clock = T0;
    const sent: string[] = [];
    const relay = new ProgressRelay({ send: (line) => sent.push(line), minIntervalMs: 1_000, maxUpdates: 5, now: () => clock });
    relay.tool('read_file');
    relay.tool('edit_file');
    // Same instant: still throttled, nothing out yet.
    expect(sent).toEqual([]);
    clock += 1_000;
    relay.tool('grep');
    expect(sent).toEqual(['正在：read_file、edit_file、grep']);
    // Inside the next interval nothing more goes out, however many tools start.
    relay.tool('bash');
    expect(sent).toHaveLength(1);
  });

  it('always delivers the answer, even when the progress budget is spent', () => {
    // The answer is what was asked for. Narration is droppable; the result is not.
    let clock = T0;
    const sent: string[] = [];
    const relay = new ProgressRelay({ send: (line) => sent.push(line), minIntervalMs: 1_000, maxUpdates: 1, now: () => clock });
    relay.tool('read_file');
    clock += 1_000;
    relay.tool('grep'); // spends the only update
    clock += 1_000;
    relay.tool('bash'); // budget gone: the narration is dropped, the answer is not
    relay.final('这是结论');

    expect(sent.filter((line) => line.includes('正在'))).toHaveLength(1);
    expect(sent.at(-1)).toBe('这是结论');
  });

  it('says so when a turn produced no text, instead of going silent', () => {
    const sent: string[] = [];
    const relay = new ProgressRelay({ send: (line) => sent.push(line) });
    relay.final('   ');
    expect(sent.at(-1)).toContain('没有要说的文本');
  });

  it('absorbs a failing transport', () => {
    // A chat that cannot be reached must never fail the turn it describes.
    const relay = new ProgressRelay({
      send: () => {
        throw new Error('rate limited');
      },
    });
    expect(() => {
      relay.tool('bash');
      relay.final('done');
    }).not.toThrow();
  });
});


