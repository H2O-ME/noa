/**
 * Reading a session log back: corruption tolerance and the v1→v2 upgrade.
 *
 * Split from `session.ts` (the `Session` object and its log FORMAT): how a file
 * with a truncated tail or a corrupt middle line is salvaged changes for its own
 * reasons — codex repairs its rollout logs the same way, and the rules here are
 * about JSONL hygiene, not about what the session does with the events.
 */
import { appendFile, open, readFile, rename, writeFile } from 'node:fs/promises';
import { SESSION_VERSION, type SessionEvent, type SessionHeader } from '../session.js';
import { parseEventLine } from './session-projection.js';
import { isAgentMessage, validateHeader } from './session-event-schema.js';

export interface ReadResult {
  header: SessionHeader;
  events: SessionEvent[];
  warnings: string[];
}

/**
 * Read the JSONL session log with corruption tolerance. Two failure shapes
 * are handled:
 * - a truncated FINAL line (a crash between write() and the trailing
 *   newline): dropped and the file truncated at the damage point, so future
 *   appends line up and the log stays clean JSONL;
 * - a corrupt MIDDLE line (real disk damage): skipped with a warning, the
 *   rest of the log stays intact and every other consumer keeps replaying.
 * Without either tolerance a single bad line would make the session
 * unopenable — no resume, no audit, no recovery (codex repairs its rollout
 * logs for the same reason).
 */
export async function readEvents(file: string, opts?: { repairTail?: boolean }): Promise<ReadResult> {
  const raw = await readFile(file, 'utf8');
  const warnings: string[] = [];
  const lines = raw.split('\n');
  const headerLine = lines[0];
  if (headerLine === undefined) throw new Error(`empty session file: ${file}`);
  let header: SessionHeader;
  try {
    const checked = validateHeader(JSON.parse(headerLine));
    // A header missing `v`/`id`/`createdAt` is not a session file. Without this
    // check it read as `v: undefined`, which is NOT >= SESSION_VERSION — so the
    // file took the v1 upgrade path and the damage was written back as fact.
    if (checked === undefined) throw new Error('not a session header');
    header = checked;
  } catch {
    throw new Error(`not a session file: ${file}`);
  }

  const events: SessionEvent[] = [];
  // Byte offset of the first body line — the loop below starts at i=1, so
  // the header's own bytes (and its newline) seed the offset bookkeeping.
  let offset = Buffer.byteLength(headerLine, 'utf8') + 1;
  let truncatedTailOffset: number | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const isFinal = i === lines.length - 1;
    const endsWithNewline = !isFinal || raw.endsWith('\n');
    const lineStart = offset;
    offset += Buffer.byteLength(line, 'utf8') + (endsWithNewline ? 1 : 0);
    if (line.trim().length === 0) continue;
    try {
      if (header.v >= SESSION_VERSION) {
        events.push(parseEventLine(line));
      } else {
        // v1: bare message lines. The shape is checked too — an upgrade writes
        // the wrapped form back, so a malformed line must not be blessed here.
        const message: unknown = JSON.parse(line);
        if (!isAgentMessage(message)) throw new Error('malformed v1 message line');
        events.push({ type: 'message', message });
      }
    } catch {
      if (isFinal && !endsWithNewline && opts?.repairTail === true) {
        truncatedTailOffset ??= lineStart;
      } else {
        warnings.push(`跳过损坏的事件行（第 ${i + 1} 行）；该行相关消息可能不完整。`);
      }
    }
  }

  if (truncatedTailOffset !== undefined) {
    // Drop the half-written line: the file now ends exactly at the previous
    // line's newline, so appends continue cleanly from here.
    const fh = await open(file, 'r+');
    try {
      await fh.truncate(truncatedTailOffset);
    } finally {
      await fh.close();
    }
  } else if (opts?.repairTail === true && !raw.endsWith('\n')) {
    // A valid final line without a trailing newline (some external writer): the
    // next append would glue onto it and corrupt two lines at once. This is a
    // WRITE, so it happens only on the repair path — the file's owner
    // (`Session.open`). A pure read (`Session.replay`, the WebUI's context
    // window) must not mutate a log another writer may be appending to.
    await appendFile(file, '\n', 'utf8');
  }
  return { header, events, warnings };
}

/**
 * One-time atomic v1 → v2 upgrade: write the wrapped event stream to a temp
 * file next to the original, then rename over it. A crash before the rename
 * leaves the v1 file (and a stray tmp file) untouched; the next open retries.
 */
export async function upgradeToV2(file: string, header: SessionHeader, events: SessionEvent[]): Promise<void> {
  const v2Header: SessionHeader = { ...header, v: SESSION_VERSION };
  const body = events.map((evt) => JSON.stringify(evt)).join('\n');
  const tmp = `${file}.upgrade-${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(v2Header)}\n${body}${body.length > 0 ? '\n' : ''}`, 'utf8');
  await rename(tmp, file);
}
