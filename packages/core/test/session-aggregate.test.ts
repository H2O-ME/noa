/**
 * Unit tests for the cross-session aggregator — the dashboard's data source.
 *
 * Writes a temp sessions tree (the SAME date-bucketed layout `listSessionFiles`
 * walks) and asserts the fold turns `run/stats` events into per-day and
 * per-workspace buckets, with the same newest-marker-wins and cwd-fallback
 * rules `session-peek` already owns. Bad files contribute nothing — the same
 * discipline as the session list.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregateSessions, NO_WORKSPACE } from '../src/session/session-aggregate.js';

/** Build a date-bucketed sessions dir and return the root path. */
async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nova-agg-'));
}

/** Write a session log under `<root>/YYYY/MM/DD/<id>.jsonl`. */
async function writeSession(
  root: string,
  id: string,
  year: number,
  month: number,
  day: number,
  lines: string[],
): Promise<string> {
  const dir = path.join(root, String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/** A `run/stats` event line with the fields the aggregator reads. */
function runStats(at: number, stats: { promptTokens?: number; completionTokens?: number; requests?: number }): string {
  return JSON.stringify({ type: 'run/stats', at, stats });
}

/** A `workspace` marker line. */
function workspaceMark(p: string, at = 0): string {
  return JSON.stringify({ type: 'workspace', path: p, at });
}

describe('aggregateSessions', () => {
  it('folds run/stats events into day and workspace buckets and totals', async () => {
    const root = await makeRoot();
    // Two sessions on the same day, different workspaces.
    await writeSession(root, 'sess-a', 2026, 10, 1, [
      workspaceMark('/home/me/proj-a'),
      runStats(1_700_000_000_000, { promptTokens: 1000, completionTokens: 100, requests: 3 }),
      runStats(1_700_000_100_000, { promptTokens: 2000, completionTokens: 200, requests: 4 }),
    ]);
    await writeSession(root, 'sess-b', 2026, 10, 1, [
      workspaceMark('/home/me/proj-b'),
      runStats(1_700_000_200_000, { promptTokens: 500, completionTokens: 50, requests: 2 }),
    ]);

    const agg = await aggregateSessions(root);

    expect(agg.sessions).toBe(2);
    expect(agg.totals.requests).toBe(9);
    expect(agg.totals.prompt).toBe(3500);
    expect(agg.totals.completion).toBe(350);

    // One day bucket (the events were emitted on the same local day).
    expect(agg.days).toHaveLength(1);
    const day = agg.days[0]!;
    // Day-key shape: YYYY-MM-DD. The exact date is host-timezone-dependent, so
    // only assert the structure.
    expect(day.key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(day.requests).toBe(9);
    expect(day.prompt).toBe(3500);

    // Two workspace buckets, heaviest first.
    expect(agg.workspaces).toHaveLength(2);
    expect(agg.workspaces[0]!.workspace).toBe('/home/me/proj-a');
    expect(agg.workspaces[0]!.requests).toBe(7);
    expect(agg.workspaces[0]!.sessions).toBe(1);
    expect(agg.workspaces[1]!.workspace).toBe('/home/me/proj-b');
    expect(agg.workspaces[1]!.requests).toBe(2);
  });

  it('uses the NEWEST workspace marker (a session moved mid-life files under the new dir)', async () => {
    const root = await makeRoot();
    await writeSession(root, 'moved', 2026, 10, 1, [
      workspaceMark('/old/path'),
      runStats(1_700_000_000_000, { promptTokens: 100, completionTokens: 10, requests: 1 }),
      workspaceMark('/new/path'),
    ]);
    const agg = await aggregateSessions(root);
    expect(agg.workspaces).toHaveLength(1);
    expect(agg.workspaces[0]!.workspace).toBe('/new/path');
  });

  it('files a session with no marker under the NO_WORKSPACE sentinel', async () => {
    const root = await makeRoot();
    await writeSession(root, 'no-mark', 2026, 10, 1, [
      runStats(1_700_000_000_000, { promptTokens: 50, completionTokens: 5, requests: 1 }),
    ]);
    const agg = await aggregateSessions(root);
    expect(agg.workspaces).toHaveLength(1);
    expect(agg.workspaces[0]!.workspace).toBe(NO_WORKSPACE);
  });

  it('returns empty aggregate when the root does not exist', async () => {
    const agg = await aggregateSessions(path.join(tmpdir(), `nova-nodir-${Date.now()}`));
    expect(agg.sessions).toBe(0);
    expect(agg.totals.requests).toBe(0);
    expect(agg.days).toHaveLength(0);
    expect(agg.workspaces).toHaveLength(0);
  });

  it('skips a corrupt file without aborting the walk', async () => {
    const root = await makeRoot();
    // First file is fine.
    await writeSession(root, 'good', 2026, 10, 1, [
      workspaceMark('/good'),
      runStats(1_700_000_000_000, { promptTokens: 10, completionTokens: 1, requests: 1 }),
    ]);
    // Second file is garbage.
    await writeSession(root, 'bad', 2026, 10, 1, ['this is not json', '{ broken']);
    const agg = await aggregateSessions(root);
    // The corrupt file still counts as a session (it was opened), but its
    // events contribute nothing — the good session's reading is intact.
    expect(agg.sessions).toBe(2);
    expect(agg.totals.requests).toBe(1);
    expect(agg.totals.prompt).toBe(10);
  });
});
