/**
 * Which session each QQ conversation is driving, persisted.
 *
 * This is what makes the channel a long-lived RELATIONSHIP rather than a series
 * of unrelated questions, and both deployment targets depend on it:
 *
 *  - **a phone driving a desktop**: the chat is bound to the session the desktop
 *    is working in, so a message from the phone continues THAT conversation — the
 *    agent keeps its context and the desktop's transcript shows the phone's prompt
 *    (会话接力, "passing the baton"). A binding that lived only in memory would
 *    break the handoff on every restart.
 *  - **a headless server**: `noa` reboots, and the peer's conversation must
 *    survive it. Without this, every restart silently starts every chat over from
 *    an empty history — the opposite of the persistent experience this is for.
 *
 * The DUrable identity of a session is its LOG FILE, not the in-memory id: the id
 * is minted per process, while the file is what a resume reopens.
 *
 * Stored under `~/.noa/qqbot/` (runtime data, not operator settings) because a
 * binding is a fact the plugin learns, not a value the operator writes — the row's
 * `config` is for the latter, and putting this there would make every incoming
 * message a config write.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** One chat's binding: which session it drives, and how it got there. */
export interface ChatBinding {
  /**
   * `own` — this chat created the session and owns it (the headless-server shape).
   * `relay` — this chat was pointed at a session somebody else is using (the
   *   phone-driving-a-desktop shape). Kept apart because `/unbind` must return the
   *   chat to its OWN conversation rather than leaving it attached to a desktop
   *   session the person may not have meant to keep driving.
   */
  kind: 'own' | 'relay';
  /** The session LOG FILE — the durable identity a resume reopens. */
  file: string;
}

/** The on-disk document. `version` so a future shape can migrate instead of guess. */
interface BindingsDocument {
  version: 1;
  chats: Record<string, ChatBinding>;
}

/**
 * A small durable map of chat → session.
 *
 * Writes are SERIALIZED through one promise chain and atomic (`tmp` + rename), for
 * the same reason every other writer in this repository is: two messages arriving
 * together would otherwise read-modify-write the same document and lose one
 * binding, and a crash mid-write would leave a truncated file that reads as "no
 * conversations at all".
 */
export class BindingsStore {
  private readonly chats = new Map<string, ChatBinding>();
  private queue: Promise<void> = Promise.resolve();
  private loaded = false;

  /**
   * @param file - the document path; defaults to `~/.noa/qqbot/bindings.json`.
   */
  constructor(private readonly file: string) {}

  /** Load once, tolerating a missing or unreadable document (a first run). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      const chats = plainChats(parsed);
      for (const [peerId, binding] of Object.entries(chats)) this.chats.set(peerId, binding);
    } catch {
      // An absent file is the normal first run. A CORRUPT one is not silently
      // repaired here: it is left alone (a later write replaces it), because
      // guessing at half a document is how a binding gets attached to the wrong
      // conversation.
    }
  }

  /** The binding for one chat, if any. */
  get(peerId: string): ChatBinding | undefined {
    return this.chats.get(peerId);
  }

  /** Bind (or rebind) one chat, and persist. */
  async set(peerId: string, binding: ChatBinding): Promise<void> {
    this.chats.set(peerId, binding);
    await this.flush();
  }

  /** Drop one chat's binding (it will own a fresh conversation next time). */
  async clear(peerId: string): Promise<void> {
    if (!this.chats.delete(peerId)) return;
    await this.flush();
  }

  /** Every binding, for a diagnostics page. */
  entries(): readonly (readonly [string, ChatBinding])[] {
    return [...this.chats.entries()];
  }

  /** Persist the current map, serialized and atomic. */
  private async flush(): Promise<void> {
    const document: BindingsDocument = { version: 1, chats: Object.fromEntries(this.chats) };
    const write = this.queue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await rename(tmp, this.file);
    });
    // Keep the chain alive after a failure so one bad write cannot wedge every
    // later one; the caller still sees the rejection.
    this.queue = write.then(
      () => undefined,
      () => undefined,
    );
    await write;
  }
}

/** Read the `chats` member of a parsed document, refusing anything malformed. */
function plainChats(parsed: unknown): Record<string, ChatBinding> {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const chats = (parsed as { chats?: unknown }).chats;
  if (typeof chats !== 'object' || chats === null) return {};
  const out: Record<string, ChatBinding> = {};
  for (const [peerId, value] of Object.entries(chats as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const candidate = value as { kind?: unknown; file?: unknown };
    if (typeof candidate.file !== 'string' || candidate.file.length === 0) continue;
    // An unknown `kind` reads as `own`: the conservative direction, since `own`
    // makes the chat start its own conversation instead of claiming somebody
    // else's session.
    out[peerId] = { kind: candidate.kind === 'relay' ? 'relay' : 'own', file: candidate.file };
  }
  return out;
}
