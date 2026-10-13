/**
 * 接力清单的候选行：**哪些对话可以接，每一行长什么样**。
 *
 * 从 `peers.ts` 拆出来，因为它回答的是另一个问题、吃的是另一组输入：那边跑「一个
 * 对端的一轮」，这里造的是**选择器**——一张全机范围的清单，由两个各自不完整的来源
 * 合成（见 `relayCandidates`）。行里的四件事（标题 / 工作区 / 时间 / 句柄）全部只是
 * 事实，呈现与命令在 `remote.ts`。
 */
import {
  isContextFragment,
  listRecentSessions,
  oneLineText,
  sessionTitleOf,
  sessionWorkspace,
  type AgentMessage,
  type AgentSession,
  type SessionEntry,
} from '@noa/core';
import type { RelayCandidate } from './remote.js';

/**
 * How many conversations `/sessions` offers.
 *
 * A chat line is read on a phone, so the list is a chooser and not a dump of the
 * machine's whole history — but "the sessions this process happens to have open"
 * was too few to choose from (two rows, one of them the chat's own). Ten is
 * enough to recognise the conversation you meant and still fits one message.
 */
export const SESSIONS_SHOWN = 10;

/**
 * How many log heads the catalog reads before the merge.
 *
 * Far above {@link SESSIONS_SHOWN} on purpose, and the reason is measured rather
 * than guessed: opening a surface creates a session, so the NEWEST logs on a
 * machine are mostly empty shells — a real listing read the 30 newest and found
 * four conversations in them, which is under the five a chooser needs. The peek
 * is a capped 64 KiB read per file, so this stays a bounded cost.
 */
const CATALOG_SCAN = 80;

/** How much of the opening prompt a chooser row shows. */
const TITLE_MAX_CHARS = 40;

/** The machine's conversations the peer could be pointed at, newest activity
 *  first, plus the one this chat drives. */
export interface RelayListing {
  /** This channel's live handles, and the flag only they can answer. */
  live: readonly AgentSession[];
  /** 会话目录（`sessionsRoot()`）：全机会话的取处。 */
  catalogDir: string;
  /** The log this chat is driving now, so its row can be marked and kept. */
  mineFile: string;
}

/**
 * Every conversation the peer could be pointed at, newest activity first.
 *
 * Two sources, because neither is complete on its own. The disk catalog holds
 * every conversation on this machine — that is what makes the listing a chooser
 * rather than "the two sessions this process happens to have open". The live
 * handles add what the catalog cannot see: the `busy` flag, and the row for a
 * conversation this channel just opened before its log head was written.
 *
 * Sorted by when each was last used rather than by when it was created, and this
 * chat's own row is always kept — the listing has to answer "where am I" even
 * when the conversation the peer is driving is older than the window.
 * @param listing - the two sources and the row to keep.
 * @returns at most {@link SESSIONS_SHOWN} rows.
 */
export async function relayCandidates(listing: RelayListing): Promise<RelayCandidate[]> {
  const { mineFile } = listing;
  const byFile = new Map(listing.live.map((agent) => [agent.session.file, agent]));
  const rows: RelayCandidate[] = [];
  for (const agent of listing.live) {
    const row = liveCandidateOf(agent, mineFile);
    // A conversation nobody has used is not something to point a chat at — `/new`
    // is how you get one of those. It stays when it IS the one this chat drives,
    // which is how the peer sees where they are.
    if (row.title.length === 0 && !row.mine) continue;
    rows.push(row);
  }
  const seen = new Set(rows.map((row) => row.file));
  for (const entry of await catalog(listing.catalogDir)) {
    if (seen.has(entry.file)) continue;
    if (entry.blank && entry.file !== mineFile) continue;
    seen.add(entry.file);
    rows.push(catalogCandidateOf(entry, byFile.get(entry.file), mineFile));
  }
  const newestFirst = (a: RelayCandidate, b: RelayCandidate): number => b.at - a.at;
  const mine = rows.find((row) => row.mine);
  const others = rows
    .filter((row) => !row.mine)
    .sort(newestFirst)
    .slice(0, SESSIONS_SHOWN - (mine === undefined ? 0 : 1));
  return (mine === undefined ? others : [mine, ...others]).sort(newestFirst);
}

/**
 * A row built from a live handle.
 *
 * Its workspace / activity / title come from memory: the catalog does not list
 * this channel's own directory, so a row for one of those conversations has no
 * log head to read.
 * @param agent - the open handle.
 * @param mineFile - the log this chat is driving, so the row can be marked.
 */
export function liveCandidateOf(agent: AgentSession, mineFile: string): RelayCandidate {
  return {
    target: shortHandle(agent.session.id),
    id: agent.session.id,
    file: agent.session.file,
    // The session's OWN recorded workspace, not this process's: a relayed
    // conversation may live in a directory this process never entered, and a row
    // that named the reader's own directory for every conversation told them
    // nothing (which is exactly how the old listing read). The FULL path, not its
    // last segment — every session under one project used to read `agent`.
    where: sessionWorkspace(agent.session) ?? '（未设置工作区）',
    // When it was last used, from the newest message rather than the log's
    // creation time: a conversation opened days ago and used a minute ago is found
    // by "a minute ago". `createdAt` covers a session with no messages yet.
    at: agent.messages[agent.messages.length - 1]?.ts ?? agent.session.createdAt,
    // What the conversation is ABOUT. A list of near-identical handles is not a
    // chooser: the reader cannot pick the desktop's conversation out of it. A
    // recorded title marker (the model-generated one) wins — it says the same
    // thing the session list says; the first prompt is the fallback.
    title: sessionTitleOf(agent.session) ?? sessionTitle(agent.messages),
    busy: agent.running,
    mine: agent.session.file === mineFile,
  };
}

/** A row built from a log head, for a conversation nobody has open. */
function catalogCandidateOf(
  entry: SessionEntry,
  held: AgentSession | undefined,
  mineFile: string,
): RelayCandidate {
  return {
    target: shortHandle(entry.id),
    id: entry.id,
    file: entry.file,
    where: entry.workspace ?? '（未设置工作区）',
    // The log's last write IS "when this conversation last happened", which is the
    // fact the reader sorts by.
    at: entry.mtime,
    title: entry.title,
    busy: held?.running ?? false,
    mine: entry.file === mineFile,
  };
}

/** The disk catalog, capped. An unreadable/missing root is "no sessions", not a
 *  failed command: a machine that has never run an interactive session still has
 *  a working channel. */
async function catalog(root: string): Promise<SessionEntry[]> {
  try {
    return await listRecentSessions(root, CATALOG_SCAN);
  } catch {
    return [];
  }
}

/**
 * A short, typeable handle derived from a session id (stable per session).
 *
 * It drops the `sess_` prefix deliberately. Ids are `sess_<12 hex>`, so slicing the
 * first six characters gave EVERY conversation a handle of `sess_` plus a single
 * distinguishing character — the listing printed `sess_c` and `sess_1`, which a
 * reader cannot tell apart, let alone choose between. The prefix carries no
 * information; the entropy is all after it.
 */
export function shortHandle(sessionId: string): string {
  return sessionId.replace(/^[a-z]+_/u, '').slice(0, 6).toLowerCase();
}

/**
 * The first thing the PERSON said, as a one-line label for a chooser row.
 *
 * Read off the live messages rather than the log head: the handle is already
 * open, so this costs nothing. Seeded context fragments are skipped for the same
 * reason `isBlankSession` skips them — they are the runner talking, not the user —
 * and the text is one-lined because it lands in a chat window, where a newline in
 * a prompt would break the row apart.
 * @param messages - the session's live messages.
 * @returns the label, or '' for a conversation that has not been used yet.
 */
function sessionTitle(messages: readonly AgentMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user' || isContextFragment(message)) continue;
    const line = oneLineText(message.content).replace(/\s+/gu, ' ').trim();
    if (line.length === 0) continue;
    return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS)}…` : line;
  }
  return '';
}

/**
 * A candidate's title as one chat-window-safe line, or '' when it has none.
 *
 * Sanitized and capped HERE rather than at the source because the two sources
 * disagree by construction: a live handle's title is one-lined by
 * `sessionTitle`, while the disk catalog's comes straight from the log head
 * (single line, but up to 120 chars and unsanitized). Every row passes through
 * this function, so the two read the same and no log line reaches the chat raw.
 */
export function labelOf(title: string): string {
  const line = oneLineText(title).replace(/\s+/gu, ' ').trim();
  if (line.length === 0) return '';
  return line.length > ROW_TITLE_MAX_CHARS ? `${line.slice(0, ROW_TITLE_MAX_CHARS)}…` : line;
}

/** The label a row shows: a conversation nobody has used says so instead of
 *  rendering blank. */
export function rowTitle(title: string): string {
  return labelOf(title) || '（还没说过话）';
}

/** How much of the opening prompt a chooser row shows. */
const ROW_TITLE_MAX_CHARS = 40;

/**
 * `MM-DD HH:mm` local time, or empty when there is no usable timestamp.
 *
 * Deliberately short: this lands in a chat line next to a title, a path and a
 * handle, and the year is the one fact a reader picking a live conversation
 * already knows. Empty rather than a placeholder, so a row that has no time
 * simply omits the segment instead of printing "未知".
 */
export function stampOf(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '';
  const when = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
