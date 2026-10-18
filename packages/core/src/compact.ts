import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentMessage, ChatProvider, ChatRequest, UserMessage } from './types.js';
import type { Session, SessionEvent } from './session.js';
import { COMPACT_SUMMARY_PREFIX, compactionSurface } from './session.js';
import { isAbortMarker } from './agent/options.js';
import { StreamingThinkScrubber } from './agent/think.js';
import { errMessage } from './errors.js';
import { estimateMessageTokens } from './estimate.js';
import { newId } from './ids.js';
import { isContextFragment } from './context-fragment.js';
import { toolOutputsDir } from './paths.js';

/**
 * Compaction as a durable in-place operation (dsh-style): instead of
 * rebuilding a fresh session file, the SAME session log appends
 * compaction/start → compaction/summary → compaction/end events and the
 * model-visible surface is projected as [context fragment, recent user
 * messages, summary]. Raw history is never rewritten, a crash mid-compaction
 * is detectable (orphaned lock), and resume reconstructs the identical
 * surface through Session.deriveMessages().
 */

/**
 * Structured like codex's compaction prompt (context checkpoint for a
 * successor LLM): progress + decisions, constraints/preferences, next steps,
 * critical data. NO hard word cap (codex has none): a starved summary forces
 * the next session into expensive re-discovery, which costs far more than the
 * extra summary tokens — the full pre-compaction transcript is archived for
 * on-demand lookups, but the summary itself must stand alone for the common
 * case.
 */
export const COMPACT_ASK = [
  'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume this task in a fresh session.',
  'Structure the summary with these sections:',
  '- Task: what the user asked for, including verbatim key requirements and constraints',
  '- Progress: what has been done, each item with its outcome (commands run, files changed, results obtained)',
  '- Decisions: choices made AND the reasons; rejected alternatives worth remembering',
  '- Current state: exact workspace state (branch, modified files, passing/failing checks)',
  '- Issues: errors hit and how they were fixed — exact error messages and root causes',
  '- Next steps: precise, ordered actions to continue',
  '- References: file paths, function names, and any critical data verbatim',
  'Preserve exact paths, identifiers, and error messages. Detail beats brevity: a lost detail forces expensive re-discovery. There is no hard length limit — be as long as the task demands, but do not pad. Output only the summary.',
].join('\n');

/**
 * Char budget for verbatim recent messages retained after compaction
 * (codex keeps a 20k-token budget; NovaAgent approximates with chars).
 */
export const COMPACT_RECENT_BUDGET_CHARS = 32_000;

/**
 * Structured prompt for an INCREMENTAL update: when the session surface
 * already carries a prior compaction summary, new messages are merged into it
 * (pi-style preserve-and-update) instead of re-summarizing from scratch.
 */
export const COMPACT_UPDATE_ASK = [
  'You are performing an INCREMENTAL CONTEXT CHECKPOINT UPDATE. The previous checkpoint summary is in <previous_summary>; the conversation messages produced since then are in <conversation>.',
  'Update the previous summary with the new information. Rules:',
  '- PRESERVE all existing information from the previous summary',
  '- ADD new progress, decisions, and context',
  '- UPDATE next steps based on what was accomplished',
  '- Preserve exact file paths, function names, and error messages',
  '- Drop items that are no longer relevant',
  'Keep the same structure and grow it as the new work demands — detail beats brevity, no hard length limit. Output only the updated summary.',
].join('\n');

/**
 * Per-tool-result char cap in the serialized summary input (pi-style): the
 * summarizer does not need full 40KB tool outputs — findings matter more than
 * raw dumps, and the serialized input itself must stay small. The UNTRUNCATED
 * transcript goes to the on-disk archive (serializeFullConversation), so this
 * cap only shapes what the summarizer model sees, not what is retrievable.
 */
export const SUMMARY_TOOL_RESULT_MAX_CHARS = 4000;

/**
 * Serialize the conversation into a compact human-readable transcript.
 * `toolResultMaxChars` caps each tool result (the summarizer needs findings,
 * not 40KB dumps); pass a huge cap (serializeFullConversation) to keep
 * everything. Static context fragments and prior summaries are always
 * stripped: they are session furniture, not conversation content.
 */
export function serializeConversation(messages: AgentMessage[], toolResultMaxChars: number): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (isContextFragment(msg) || isCompactSummary(msg)) continue;
    if (msg.role === 'user') {
      parts.push(`[User]: ${msg.content}`);
    } else if (msg.role === 'assistant') {
      if (msg.content.length > 0) parts.push(`[Assistant]: ${msg.content}`);
      if (msg.toolCalls !== undefined && msg.toolCalls.length > 0) {
        const calls = msg.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.args)})`).join('; ');
        parts.push(`[Assistant tool calls]: ${calls}`);
      }
    } else if (msg.role === 'tool' && msg.content.length > 0) {
      const content =
        msg.content.length > toolResultMaxChars
          ? `${msg.content.slice(0, toolResultMaxChars)}…[截断]`
          : msg.content;
      parts.push(`[Tool ${msg.name}]: ${content}`);
    }
  }
  return parts.join('\n\n');
}

/** Summary-input transcript: tool results capped at SUMMARY_TOOL_RESULT_MAX_CHARS. */
export function serializeConversationForSummary(messages: AgentMessage[]): string {
  return serializeConversation(messages, SUMMARY_TOOL_RESULT_MAX_CHARS);
}

/**
 * Archive transcript: NOTHING is truncated. Written to disk before the
 * summary event lands and referenced from the summary, so the post-compact
 * model can consult exact pre-compaction details (full error text, exact
 * command output) with read_file instead of guessing.
 */
export function serializeFullConversation(messages: AgentMessage[]): string {
  return serializeConversation(messages, Number.MAX_SAFE_INTEGER);
}

/**
 * Ask the current model to summarize the conversation. The transcript is sent
 * as one serialized user message (not the raw role-played history) so the
 * summarizer request stays small; with `previousSummary` the ask switches to
 * the incremental merge prompt.
 */
export async function compactConversation(
  client: ChatProvider,
  messages: AgentMessage[],
  previousSummary?: string,
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<string> {
  const ask =
    previousSummary !== undefined
      ? `${COMPACT_UPDATE_ASK}\n\n<previous_summary>\n${previousSummary}\n</previous_summary>`
      : COMPACT_ASK;
  const history = serializeConversationForSummary(messages);
  const askMsg: UserMessage = {
    id: newId('msg'),
    ts: Date.now(),
    role: 'user',
    content: `${ask}\n\n<conversation>\n${history}\n</conversation>`,
  };
  let summary = '';
  const req: ChatRequest = { messages: [askMsg], signal };
  // The same reasoning filter the main stream uses: a summary carrying its own
  // ` thinking` block would be stored, injected into every later request, and
  // compounded by each iterative update.
  const scrubber = new StreamingThinkScrubber();
  for await (const ev of client.stream(req)) {
    if (ev.type === 'text_delta') {
      const visible = scrubber.feed(ev.text);
      if (visible.length > 0) {
        summary += visible;
        onDelta?.(visible);
      }
    } else if (ev.type === 'reset') {
      summary = ''; // retry replays from scratch
      scrubber.reset();
    }
  }
  const tail = scrubber.flush();
  if (tail.length > 0) {
    summary += tail;
    onDelta?.(tail);
  }
  return summary.trim();
}

export function isCompactSummary(msg: AgentMessage): boolean {
  return msg.role === 'user' && msg.content.startsWith(COMPACT_SUMMARY_PREFIX);
}

/**
 * Recent verbatim messages kept after compaction (codex-style): newest first
 * within the char budget. BOTH sides of the recent exchange are kept — user
 * requests AND pure-text assistant replies (an assistant message carrying
 * tool_calls is never kept alone: its result messages would be stranded and
 * strict providers reject the unbalanced surface). The budget takes WHOLE
 * messages — the first one that does not fit stops the walk (nothing skipped,
 * nothing partially kept): a truncated copy could not rejoin the log
 * projection verbatim ("model-visible means logged" requires the kept message
 * to BE a logged message), so cut-or-keep is the only shape that preserves
 * the invariant. Context fragments, prior summaries and abort markers never
 * carry over.
 */
export function selectRecentMessages(messages: AgentMessage[], budgetChars: number): AgentMessage[] {
  const picked: AgentMessage[] = [];
  let budget = budgetChars;
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const msg = messages[i];
    if (msg === undefined) continue;
    if (msg.role === 'user') {
      if (isContextFragment(msg) || isCompactSummary(msg) || isAbortMarker(msg)) continue;
    } else if (msg.role === 'assistant') {
      // Pure text only: tool-call messages must keep their result messages,
      // and pulling the whole subtree through the char budget is not worth it.
      if (msg.content.length === 0 || (msg.toolCalls !== undefined && msg.toolCalls.length > 0)) continue;
    } else {
      continue;
    }
    if (msg.content.length > budget) break;
    picked.push(msg);
    budget -= msg.content.length;
  }
  return picked.reverse();
}

export interface CompactSessionOptions {
  client: ChatProvider;
  /** Session log to append the compaction events to (compacted in place). */
  session: Session;
  /** Live model surface (== session.deriveMessages()). */
  messages: AgentMessage[];
  recentBudgetChars?: number;
  /** Who asked for this compaction; recorded on compaction/start. */
  trigger?: 'auto' | 'manual';
  /** Optional abort signal forwarded to the summarizer request. */
  signal?: AbortSignal;
  /**
   * Where the full-transcript archive is written. Defaults to the shared
   * tool-output spill dir (`~/.noa/cache/tool-outputs/<sessionId>`), which
   * the runners already exempt from read approval — so the post-compact model
   * can read_file the archive without an approval prompt.
   */
  cacheDir?: string;
  /** Stream tap on the summarizer's output (surface tps sampling). */
  onDelta?: (text: string) => void;
}

export interface CompactedSession {
  /** New projected surface to use as the live message array. */
  surface: AgentMessage[];
  summary: string;
  /** How many recent messages were carried over verbatim. */
  retained: number;
  /** On-disk full-transcript archive referenced from the summary, if written. */
  archivePath?: string;
}

/**
 * Compact the session in place: append the three compaction events (the lock
 * is released LAST so a crash mid-operation leaves a detectable orphan),
 * then return the projected surface. The caller replaces its message array
 * with `surface` and keeps appending to the same session file.
 */
export async function compactSession(opts: CompactSessionOptions): Promise<CompactedSession> {
  const { client, session, messages } = opts;
  await session.appendEvent({ type: 'compaction/start', trigger: opts.trigger ?? 'manual', at: Date.now() });
  try {
    // Incremental mode: a prior summary on the surface turns this compaction
    // into a preserve-and-update merge (the old summary is excluded from the
    // serialized transcript and embedded in the ask instead). The furniture we
    // appended to the persisted body (archive pointer) is stripped — the ask
    // carries the summary CORE only; the raw body still feeds the archive
    // chain harvest below.
    const previous = messages.find(isCompactSummary)?.content;
    const previousBody = previous !== undefined ? previous.slice(COMPACT_SUMMARY_PREFIX.length).trimStart() : undefined;
    const ARCHIVE_MARK = '\n\n[对话存档]';
    const previousSummary = previousBody?.split(ARCHIVE_MARK)[0]?.trim();
    const summary = await compactConversation(client, messages, previousSummary, opts.signal, opts.onDelta);
    // Full-transcript archive BEFORE the summary event: the summary points at
    // it, so the post-compact model can re-consult exact pre-compact details
    // (full errors, raw outputs) on demand instead of working from a lossy
    // summary alone. Best-effort: an archive write failure must not fail the
    // compaction — the summary just carries no pointer.
    const archivePath = await writeTranscriptArchive(opts);
    const body =
      (summary.length > 0 ? summary : '(无摘要可用)') + archivePointer(archivePath, previousBody);

    // keep references logged messages by index in the FULL message stream.
    const all = session.allMessages();
    const index = new Map(all.map((msg, i) => [msg.id, i] as const));
    const keep: number[] = [];
    const fragment = all.find((msg) => isContextFragment(msg));
    if (fragment !== undefined) {
      const at = index.get(fragment.id);
      if (at !== undefined) keep.push(at);
    }
    const recent = selectRecentMessages(messages, opts.recentBudgetChars ?? COMPACT_RECENT_BUDGET_CHARS);
    for (const msg of recent) {
      const at = index.get(msg.id);
      if (at !== undefined) keep.push(at);
    }
    const shadowedTokenCount = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);

    const at = Date.now();
    const evt: Extract<SessionEvent, { type: 'compaction/summary' }> = {
      type: 'compaction/summary',
      summary: body,
      keep,
      // Ids alongside positions: the projection prefers ids (corruption-tolerant),
      // old readers still understand the positional form.
      keepIds: keep.map((i) => all[i]?.id).filter((id): id is string => id !== undefined),
      shadowedTokenCount,
      at,
    };
    const seq = await session.appendEvent(evt);
    // Surface 构造与投影同源（core 的 compactionSurface，keepIds 优先）——
    // 活路径与 resume 投影不再各写一份公式。
    const surface = compactionSurface(evt, all, seq);
    await session.appendEvent({ type: 'compaction/end', at: Date.now() });
    return { surface, summary: body, retained: recent.length, ...(archivePath !== undefined ? { archivePath } : {}) };
  } catch (err) {
    // Release the lock with an error marker so the failed attempt is recorded
    // but does not block future compactions.
    await session
      .appendEvent({ type: 'compaction/end', at: Date.now(), error: errMessage(err) })
      .catch(() => {});
    throw err;
  }
}

/** Archive file name prefix inside the spill dir. */
const ARCHIVE_PREFIX = 'pre-compact-';

/**
 * Write the UNTRUNCATED pre-compaction transcript next to the tool-output
 * spill (same trusted read root, so read_file on it needs no approval).
 */
async function writeTranscriptArchive(opts: CompactSessionOptions): Promise<string | undefined> {
  const full = serializeFullConversation(opts.messages);
  if (full.length === 0) return undefined;
  const dir = opts.cacheDir ?? toolOutputsDir(opts.session.id);
  try {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${ARCHIVE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    // 'wx' mirrors the tool-result spill: never overwrite an existing archive.
    await writeFile(file, full, { encoding: 'utf8', flag: 'wx' });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Machine-readable archive reference appended to the persisted summary
 * (`<archive>` tags survive across incremental compactions: the chain link
 * below harvests them from the previous summary so older archives stay
 * reachable from the newest summary).
 */
function archivePointer(archivePath: string | undefined, previousBody: string | undefined): string {
  if (archivePath === undefined) return '';
  const older = [...(previousBody ?? '').matchAll(/<archive>(.+?)<\/archive>/g)]
    .map((match) => match[1])
    .filter((p): p is string => p !== undefined && p !== archivePath)
    .slice(0, 3);
  const lines = [
    '',
    '',
    '[对话存档] 压缩前的完整对话记录（未截断）已存档于 <archive>' + archivePath + '</archive>。',
    '当本摘要缺少某个细节（完整报错、精确输出、早先的决定与原因）时，先用 read_file 分段查阅该存档再继续，不要凭空猜测。',
  ];
  if (older.length > 0) lines.push(`更早的压缩存档（按需查阅）：${older.join('、')}`);
  return lines.join('\n');
}

/**
 * Dev-mode runtime invariant ("model-visible means logged"): the live surface
 * must equal the log projection. Returns a short description of the first
 * divergence, or undefined when the invariant holds.
 */
export function surfaceDivergence(session: Session, messages: AgentMessage[]): string | undefined {
  const derived = session.deriveMessages();
  if (derived.length !== messages.length) {
    return `surface has ${messages.length} messages but log projects ${derived.length}`;
  }
  for (let i = 0; i < derived.length; i++) {
    const a = derived[i]!;
    const b = messages[i]!;
    if (a.id !== b.id || a.role !== b.role || a.content !== b.content) {
      return `surface[${i}] diverged from log projection (log: ${a.role}#${a.id})`;
    }
  }
  return undefined;
}
