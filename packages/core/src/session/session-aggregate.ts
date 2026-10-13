/**
 * Cross-session activity aggregate — the dashboard's data source.
 *
 * The session LIST answers "which logs exist"; this answers "what did they
 * together do". It is the ONE walk over every stored session log that folds
 * each `run/stats` event into day and workspace buckets, so a dashboard card
 * can draw a corpus overview without re-reading logs on every paint.
 *
 * Bound: enumeration is capped by `listSessionFiles` (2000 newest), and a
 * per-file line ceiling guards against pathological logs. Sessions whose logs
 * predate `run/stats` simply contribute nothing — an old session is not an
 * error, just an empty bucket.
 *
 * Same data-ownership discipline as the rest of the session family: this file
 * owns the per-event fold; the directory walk lives in `session-files.ts`, the
 * head scan in `session-peek.ts`. The aggregator does not load whole messages
 * — it parses one line at a time and keeps only counters.
 */
import { open } from 'node:fs/promises';
import { listSessionFiles } from './session-files.js';

/** One day's aggregate across all sessions whose runs landed in it. */
export interface DayBucket {
  /** Local-date key (YYYY-MM-DD). */
  key: string;
  /** Number of `run/stats` events whose `at` falls on this day. */
  requests: number;
  /** Sum of `promptTokens` across those events. */
  prompt: number;
  /** Sum of `completionTokens` across those events. */
  completion: number;
}

/** One workspace's aggregate across the scanned sessions filed under it. */
export interface WorkspaceBucket {
  /** Workspace path, or `'__none__'` when a session had no marker and no cwd fallback. */
  workspace: string;
  requests: number;
  prompt: number;
  completion: number;
  /** Sessions filed under this workspace (for sorting by activity). */
  sessions: number;
}

/** The dashboard's reading of the corpus. */
export interface SessionAggregate {
  /** Day buckets, oldest-first by key. */
  days: DayBucket[];
  /** Workspace buckets, heaviest-first by requests. */
  workspaces: WorkspaceBucket[];
  /** Sessions scanned (files that existed and were opened). */
  sessions: number;
  /** Corpus totals. */
  totals: { requests: number; prompt: number; completion: number };
}

/** Local-date key (YYYY-MM-DD) in the host's own timezone — matches the Heatmap card. */
function dayKey(at: number): string {
  const d = new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Sentinel for sessions with no workspace marker and no cwd fallback. */
export const NO_WORKSPACE = '__none__';

/** Per-file line ceiling — guards against pathological logs. */
const MAX_LINES_PER_FILE = 200_000;

/** One session file's contribution to the aggregate. */
interface SessionFold {
  workspace: string;
  requests: number;
  prompt: number;
  completion: number;
  /** Day-key → counters, kept as a map for cheap accumulation. */
  days: Map<string, { requests: number; prompt: number; completion: number }>;
}

/** Fold one session log line by line. Returns the per-file contribution. */
async function foldSession(file: string): Promise<SessionFold> {
  const fold: SessionFold = {
    workspace: NO_WORKSPACE,
    requests: 0,
    prompt: 0,
    completion: 0,
    days: new Map(),
  };
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let leftover = '';
    let lineCount = 0;
    let position = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const chunk = leftover + buf.subarray(0, bytesRead).toString('utf8');
      const lines = chunk.split('\n');
      // All but the last are complete lines; the last may continue in the next read.
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        lineCount += 1;
        if (lineCount > MAX_LINES_PER_FILE) return fold;
        applyLine(line, fold);
      }
    }
    if (leftover.length > 0) {
      lineCount += 1;
      if (lineCount <= MAX_LINES_PER_FILE) applyLine(leftover, fold);
    }
  } finally {
    await fh.close();
  }
  return fold;
}

/** Apply one parsed event line to the fold. Parses defensively — bad lines are skipped. */
function applyLine(line: string, fold: SessionFold): void {
  let evt: unknown;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof evt !== 'object' || evt === null) return;
  const rec = evt as { type?: unknown; stats?: unknown; at?: unknown; path?: unknown };
  if (rec.type === 'workspace') {
    // Newest marker wins — matches `session-peek` and `session-workspace`.
    if (typeof rec.path === 'string') fold.workspace = rec.path;
    return;
  }
  if (rec.type !== 'run/stats') return;
  const stats = rec.stats as
    | { promptTokens?: unknown; completionTokens?: unknown; requests?: unknown }
    | undefined;
  if (stats === undefined) return;
  const at = typeof rec.at === 'number' ? rec.at : Date.now();
  const prompt = typeof stats.promptTokens === 'number' ? stats.promptTokens : 0;
  const completion = typeof stats.completionTokens === 'number' ? stats.completionTokens : 0;
  const requests = typeof stats.requests === 'number' ? stats.requests : 1;
  fold.requests += requests;
  fold.prompt += prompt;
  fold.completion += completion;
  const key = dayKey(at);
  const existing = fold.days.get(key);
  if (existing === undefined) {
    fold.days.set(key, { requests, prompt, completion });
  } else {
    existing.requests += requests;
    existing.prompt += prompt;
    existing.completion += completion;
  }
}

/**
 * Fold every session log under `root` into a dashboard reading.
 *
 * Files are processed sequentially (bound by `MAX_SESSION_FILES`); a single
 * broken file does not abort the walk — it contributes nothing, the same way
 * an unreadable head contributes nothing to the session list.
 */
export async function aggregateSessions(root: string): Promise<SessionAggregate> {
  const files = await listSessionFiles(root);
  const dayMap = new Map<string, { requests: number; prompt: number; completion: number }>();
  const wsMap = new Map<string, WorkspaceBucket>();
  let totalsRequests = 0;
  let totalsPrompt = 0;
  let totalsCompletion = 0;
  let sessions = 0;
  for (const file of files) {
    let fold: SessionFold;
    try {
      fold = await foldSession(file);
    } catch {
      continue; // unreadable file contributes nothing
    }
    sessions += 1;
    // Merge per-file day buckets into the corpus map.
    for (const [key, bucket] of fold.days) {
      const existing = dayMap.get(key);
      if (existing === undefined) {
        dayMap.set(key, { ...bucket });
      } else {
        existing.requests += bucket.requests;
        existing.prompt += bucket.prompt;
        existing.completion += bucket.completion;
      }
    }
    // Merge workspace bucket.
    const ws = fold.workspace;
    const wsExisting = wsMap.get(ws);
    if (wsExisting === undefined) {
      wsMap.set(ws, {
        workspace: ws,
        requests: fold.requests,
        prompt: fold.prompt,
        completion: fold.completion,
        sessions: 1,
      });
    } else {
      wsExisting.requests += fold.requests;
      wsExisting.prompt += fold.prompt;
      wsExisting.completion += fold.completion;
      wsExisting.sessions += 1;
    }
    totalsRequests += fold.requests;
    totalsPrompt += fold.prompt;
    totalsCompletion += fold.completion;
  }
  // Days oldest-first.
  const days: DayBucket[] = [...dayMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, b]) => ({ key, ...b }));
  // Workspaces heaviest-first by requests.
  const workspaces: WorkspaceBucket[] = [...wsMap.values()].sort(
    (a, b) => b.requests - a.requests || b.prompt - a.prompt,
  );
  return {
    days,
    workspaces,
    sessions,
    totals: { requests: totalsRequests, prompt: totalsPrompt, completion: totalsCompletion },
  };
}

/** Re-exported path utility for callers that need the sessions root. */
export { sessionsRoot } from '../paths.js';
