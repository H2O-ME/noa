import { existsSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteSessionLog,
  Session,
  SessionListing,
  sessionWorkspace,
  type AssistantMessage,
  type UserMessage,
} from '../src/index.js';
// `session-peek.ts` is deliberately outside the package barrel (AGENTS.md §8):
// it is the head-scan implementation the listing uses, not a public API.
import { peekSession } from '../src/session/session-peek.js';

function user(id: string, content: string): UserMessage {
  return { id, ts: 1, role: 'user', content };
}

function assistant(id: string, content: string): AssistantMessage {
  return { id, ts: 2, role: 'assistant', content, usage: { promptTokens: 1, completionTokens: 2, cachedTokens: 0 } };
}

function userMessage(content: string): UserMessage {
  return { id: `u_${content.length}`, ts: 1, role: 'user', content };
}

describe('Session', () => {
  it('appends and replays messages as an exact round trip', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-'));
    const session = await Session.create(dir, 'sess_test');
    const user: UserMessage = { id: 'msg_u1', ts: 1, role: 'user', content: 'hi' };
    const assistant: AssistantMessage = {
      id: 'msg_a1',
      ts: 2,
      role: 'assistant',
      content: 'hello',
      usage: { promptTokens: 1, completionTokens: 2, cachedTokens: 0 },
    };
    await session.append(user);
    await session.append(assistant);

    const { header, messages } = await Session.replay(session.file);
    expect(header.id).toBe('sess_test');
    expect(header.type).toBe('session');
    expect(messages).toEqual([user, assistant]);

    const reopened = await Session.open(session.file);
    expect(reopened.id).toBe('sess_test');
  });

  it('rejects a file that is not a session log', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-'));
    const file = path.join(dir, 'bad.jsonl');
    await writeFile(file, '{"type":"other"}\n', 'utf8');
    await expect(Session.replay(file)).rejects.toThrow('not a session file');
  });

  it('repairs a truncated trailing line (crash mid-append) and keeps the log clean', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-'));
    const session = await Session.create(dir, 'sess_crash');
    const first = user('msg_u1', 'hi');
    const second = assistant('msg_a1', 'hello');
    await session.append(first);
    await session.append(second);

    // Simulate a crash between write() and the trailing newline: the last
    // line is a partial JSON fragment.
    const raw = await readFile(session.file, 'utf8');
    await writeFile(session.file, `${raw}{"type":"mess`, 'utf8');

    const reopened = await Session.open(session.file);
    expect(reopened.warnings).toEqual([]); // tail repair is silent — not corruption
    expect(reopened.allMessages()).toEqual([first, second]);

    // Appends continue cleanly after the repair; the log stays parseable.
    const third = assistant('msg_a2', 'again');
    await reopened.append(third);
    const thrice = await Session.open(session.file);
    expect(thrice.allMessages()).toEqual([first, second, third]);
    for (const line of (await readFile(session.file, 'utf8')).trimEnd().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('skips a corrupt middle line with a warning instead of failing the open', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-'));
    const session = await Session.create(dir, 'sess_bad');
    const first = user('msg_u1', 'hi');
    await session.append(first);

    // Plant real corruption in the middle of the file (not a truncation).
    const raw = await readFile(session.file, 'utf8');
    const lines = raw.trimEnd().split('\n');
    lines.splice(2, 0, 'not json at all');
    await writeFile(session.file, `${lines.join('\n')}\n`, 'utf8');

    const reopened = await Session.open(session.file);
    expect(reopened.warnings).toEqual([expect.stringContaining('损坏')]);
    expect(reopened.allMessages()).toEqual([first]);
  });

  it('normalizes a missing trailing newline so appends cannot glue lines', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-'));
    const session = await Session.create(dir, 'sess_glue');
    const first = user('msg_u1', 'hi');
    await session.append(first);
    // External writer left no trailing newline after the last line.
    await writeFile(session.file, (await readFile(session.file, 'utf8')).trimEnd(), 'utf8');

    const reopened = await Session.open(session.file);
    await reopened.append(assistant('msg_a1', 'hello'));

    const thrice = await Session.open(session.file);
    expect(thrice.allMessages()).toHaveLength(2);
    for (const line of (await readFile(session.file, 'utf8')).trimEnd().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe('compaction keepIds projection', () => {
  it('prefers keepIds over positional keep when both are present', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-keep-'));
    const session = await Session.create(dir, 'sess_keep');
    const fragment = user('msg_ctx_frag', '<environment>\ncwd=/w\n</environment>');
    const recent = user('msg_recent', 'do the thing');
    await session.append(fragment);
    await session.append(recent);
    await session.append(assistant('msg_a1', 'ok'));

    // keep positions intentionally wrong (as corruption would shift them);
    // keepIds pin the actually-kept messages.
    await session.appendEvent({
      type: 'compaction/summary',
      summary: 'handoff',
      keep: [2],
      keepIds: ['msg_ctx_frag', 'msg_recent'],
      shadowedTokenCount: 10,
      at: 3,
    });

    const surface = session.deriveMessages();
    expect(surface.map((m) => m.id)).toEqual(['msg_ctx_frag', 'msg_recent', expect.stringMatching(/^msg_compact_/)]);
    expect(surface.at(-1)?.content).toContain('[已压缩的上一会话摘要]\nhandoff');
  });

  it('still resolves legacy logs by positional keep (no keepIds)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-legacy-'));
    const session = await Session.create(dir, 'sess_legacy');
    await session.append(user('msg_u1', 'early'));
    await session.append(user('msg_u2', 'later'));
    await session.appendEvent({
      type: 'compaction/summary',
      summary: 'legacy handoff',
      keep: [0],
      shadowedTokenCount: 5,
      at: 3,
    });
    const surface = session.deriveMessages();
    expect(surface.map((m) => m.id)).toEqual(['msg_u1', expect.stringMatching(/^msg_compact_/)]);
  });

  it('an unclosed compaction is discarded without dropping later messages', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-orphan-'));
    const session = await Session.create(dir, 'sess_orphan');
    await session.append(user('msg_u1', 'early'));
    // A crash between start and end leaves an orphan lock; the summary it wrote
    // never committed and must not replace the surface.
    await session.appendEvent({ type: 'compaction/start', trigger: 'auto', at: 1 });
    await session.appendEvent({
      type: 'compaction/summary',
      summary: 'uncommitted handoff',
      keep: [0],
      shadowedTokenCount: 5,
      at: 2,
    });
    // The conversation continued after the crash: these messages must survive.
    await session.append(assistant('msg_a1', 'after crash'));

    expect(session.deriveMessages().map((m) => m.id)).toEqual(['msg_u1', 'msg_a1']);
  });
});

/**
 * The session list a surface keeps. Two rules matter to a sidebar: asking again
 * is cheap (the heads it read are remembered), and the answer is never stale
 * (a log that changed is re-read, and a session created a moment ago appears).
 */
describe('SessionListing', () => {
  it('re-reads only the logs whose mtime moved', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-list-'));
    // The listing walks the date-bucketed layout the CLI writes into.
    const bucket = path.join(root, '2026', '09', '24');
    const first = await Session.create(bucket, 'sess_a');
    const listing = new SessionListing(root);
    // A fresh log has a header and nothing else: no title, no workspace.
    expect((await listing.list(10))[0]).toMatchObject({ id: 'sess_a', title: '', workspace: undefined });

    // Asking again costs a walk plus one stat per log — nothing was re-peeked.
    expect((await listing.list(10)).map((e) => e.file)).toEqual([first.file]);

    // The log grew, so the mtime moved and the head is read again. The order is
    // the one the CLI writes: the workspace marker lands before the first prompt.
    await first.appendEvent({ type: 'workspace', path: 'D:/proj', at: 2 });
    await first.append(userMessage('first title'));
    await utimes(first.file, new Date(2_000), new Date(2_000));
    expect((await listing.list(10)).find((e) => e.id === 'sess_a')).toMatchObject({
      title: 'first title',
      workspace: 'D:/proj',
    });

    // A session created a moment ago shows up in the next answer: the list
    // itself is never cached (that is what a surface re-asks for).
    const second = await Session.create(bucket, 'sess_b');
    await second.append(userMessage('brand new'));
    expect((await listing.list(10)).map((e) => e.title)).toContain('brand new');
  });

  it('re-reads a log whose size moved even when the mtime did not', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-list-same-ms-'));
    const bucket = path.join(root, '2026', '09', '24');
    const log = await Session.create(bucket, 'sess_same');
    // Pin a WHOLE-millisecond mtime so it can be restored exactly after the
    // append (NTFS stores sub-millisecond precision that `utimes` cannot
    // reproduce, which would otherwise let the mtime move on its own and hide
    // whether the size is doing any work).
    const pinned = new Date(1_700_000_000_000);
    await utimes(log.file, pinned, pinned);
    const listing = new SessionListing(root);
    expect((await listing.list(10))[0]?.workspace).toBeUndefined();
    const before = await stat(log.file);

    // Append, then force the mtime back: ONLY the size reveals the change. This
    // is the real situation, not a contrivance — NTFS stamps land on a ~15ms
    // grid, so an append right after a listing commonly carries the same mtime,
    // and an mtime-only cache key served the stale head forever. A session
    // moved to another workspace then stayed filed under the directory it left.
    await log.appendEvent({ type: 'workspace', path: 'D:/moved', at: 2 });
    await utimes(log.file, pinned, pinned);
    const after = await stat(log.file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBeGreaterThan(before.size);

    expect((await listing.list(10))[0]?.workspace).toBe('D:/moved');
  });

  it('starts empty for a root that does not exist', async () => {
    const listing = new SessionListing(path.join(tmpdir(), 'nova-list-missing'));
    expect(await listing.list(5)).toEqual([]);
  });
});

/**
 * The head scan and the loaded session answer "which workspace" for the same
 * log, and they must agree — the list is drawn from one and a switch re-points
 * the tools with the other. They disagreed: the scan took the FIRST marker and
 * stopped at the first prompt, so a session moved mid-life was listed under the
 * directory it had left, while the session itself had already moved on.
 */
describe('workspace agreement between the head scan and the session', () => {
  it('takes the newest marker on both sides, even when it lands after the first prompt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noa-ws-agree-'));
    const bucket = path.join(root, '2026', '09', '24');
    const log = await Session.create(bucket, 'sess_moved');
    await log.appendEvent({ type: 'workspace', path: 'D:/first', at: 2 });
    await log.append(userMessage('修复登录'));
    // The move happens mid-life: the second marker is written AFTER the prompt.
    await log.appendEvent({ type: 'workspace', path: 'D:/second', at: 3 });

    const peek = await peekSession(log.file);
    const reopened = await Session.open(log.file);
    expect(peek.workspace).toBe('D:/second');
    expect(sessionWorkspace(reopened)).toBe('D:/second');
    expect(peek.workspace).toBe(sessionWorkspace(reopened));
    // The title is still the FIRST prompt: continuing the scan must not move it.
    expect(peek.title).toBe('修复登录');
    expect(peek.blank).toBe(false);
  });

  it('falls back to the fragment cwd only when no marker exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noa-ws-fallback-'));
    const bucket = path.join(root, '2026', '09', '24');
    const log = await Session.create(bucket, 'sess_old');
    await log.append({
      id: 'msg_ctx_old',
      role: 'user',
      content: '<environment>\ncwd=D:/legacy\n</environment>',
    } as UserMessage);

    const peek = await peekSession(log.file);
    const reopened = await Session.open(log.file);
    expect(peek.workspace).toBe('D:/legacy');
    expect(sessionWorkspace(reopened)).toBe('D:/legacy');
  });
});

/**
 * Deleting a session log. The rule that matters is the same one resuming
 * obeys: the path is validated against the sessions root first, so a hostile
 * or mistaken path cannot unlink an arbitrary file.
 */
describe('deleteSessionLog', () => {
  it('unlinks a log inside the sessions root and reports the path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-del-'));
    const bucket = path.join(root, '2026', '09', '24');
    const session = await Session.create(bucket, 'sess_gone');
    expect(existsSync(session.file)).toBe(true);

    expect(await deleteSessionLog(session.file, root)).toBe(path.resolve(session.file));
    expect(existsSync(session.file)).toBe(false);
    // A gone log is gone from the listing too — the log IS the session.
    expect(await new SessionListing(root).list(10)).toEqual([]);
  });

  it('treats an already-deleted log as nothing to do, not an error', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-del2-'));
    const bucket = path.join(root, '2026', '09', '24');
    const session = await Session.create(bucket, 'sess_twice');
    await deleteSessionLog(session.file, root);
    expect(await deleteSessionLog(session.file, root)).toBe(false);
  });

  it('refuses a path outside the sessions root and leaves the file alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-del3-'));
    const outside = path.join(await mkdtemp(path.join(tmpdir(), 'nova-keep-')), 'precious.jsonl');
    await writeFile(outside, 'do not delete');
    await expect(deleteSessionLog(outside, root)).rejects.toThrow(/outside the sessions dir/);
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses a traversal out of the sessions root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-del4-'));
    await expect(deleteSessionLog(path.join(root, '..', 'escape.jsonl'), root)).rejects.toThrow(/outside the sessions dir/);
  });

  it('refuses the sessions root itself', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-del5-'));
    await expect(deleteSessionLog(root, root)).rejects.toThrow(/outside the sessions dir/);
  });
});

describe('session log read purity and shape tolerance', () => {
  it('a plain read never writes; the owner repairs a missing trailing newline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-pure-'));
    const session = await Session.create(dir, 'sess_pure');
    await session.append(user('msg_u1', 'hi'));
    // An external writer left the final line without its newline.
    await writeFile(session.file, (await readFile(session.file, 'utf8')).trimEnd(), 'utf8');
    const before = await readFile(session.file, 'utf8');

    // A GET (the WebUI's context window, an audit) must not mutate a log another
    // writer may be appending to.
    await Session.replay(session.file);
    expect(await readFile(session.file, 'utf8')).toBe(before);

    // The file's OWNER still repairs it, or the next append would glue two lines.
    await Session.open(session.file);
    expect((await readFile(session.file, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('skips a malformed line instead of admitting it into the projection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nova-sess-shape-'));
    const session = await Session.create(dir, 'sess_shape');
    await session.append(user('msg_u1', 'hi'));
    // Valid JSON, wrong shape: a `message` event with no message. The old
    // `as SessionEvent` cast let this reach `deriveMessages`.
    await appendFile(session.file, `${JSON.stringify({ type: 'message' })}\n`, 'utf8');
    await session.append(user('msg_u2', 'still here'));

    const reopened = await Session.open(session.file);
    expect(reopened.deriveMessages().map((m) => m.id)).toEqual(['msg_u1', 'msg_u2']);
    expect(reopened.warnings.length).toBeGreaterThan(0);
  });
});
