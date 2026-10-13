/**
 * Spawn-only content-regex search worker. DELIBERATELY SELF-CONTAINED (node
 * builtins only, erasable TypeScript): in the source world Node loads this
 * file directly through native type stripping, and in the built world tsdown
 * bundles it standalone to `search-worker.mjs` — no shared module graph
 * either way (the ptc/worker.ts precedent).
 *
 * It runs the same walk + line-wise regex the in-process path had, so the
 * MODEL-PROVIDED pattern cannot freeze the host event loop: the host
 * hard-terminates this worker at the wall-clock ceiling or on abort.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface BootData {
  root: string;
  contentRegex: string;
  caseInsensitive: boolean;
  maxResults: number;
  skipDirs: string[];
  scanMaxBytes: number;
  /** Truncation note template injected via workerData (kept out of source). */
  truncatedNoteTemplate: string;
}

if (!parentPort) throw new Error('nova search worker loaded outside a worker thread');
const port = parentPort;
const boot = workerData as BootData;

const SKIP_DIRS = new Set(boot.skipDirs);
/** Binary probe: same control-character heuristic as the in-process path. */
function looksBinary(text: string, sampleChars: number): boolean {
  const limit = Math.min(text.length, sampleChars);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

interface WalkHalt {
  halted: boolean;
}

async function walk(
  dir: string,
  onFile: (file: string, info: { size: number }) => Promise<void>,
  halt: WalkHalt,
): Promise<void> {
  if (halt.halted) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return;
  for (const entry of entries) {
    if (halt.halted) return;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), onFile, halt);
    } else if (entry.isFile()) {
      const info = await stat(path.join(dir, entry.name)).catch(() => undefined);
      if (info !== undefined && info.isFile()) await onFile(path.join(dir, entry.name), info);
    }
  }
}

try {
  const re = new RegExp(boot.contentRegex, boot.caseInsensitive ? 'i' : '');
  const results: string[] = [];
  const halt: WalkHalt = { halted: false };
  const relOf = (file: string): string => path.relative(boot.root, file).split(path.sep).join('/');

  await walk(
    boot.root,
    async (file, info) => {
      if (halt.halted) return;
      if (info.size > boot.scanMaxBytes) return;
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text === undefined || looksBinary(text, 8192)) return;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && !halt.halted; i++) {
        if (re.test(lines[i]!)) {
          results.push(`${relOf(file)}:${i + 1}: ${lines[i]!.trimEnd()}`);
          if (results.length >= boot.maxResults) halt.halted = true;
        }
      }
    },
    halt,
  );

  const truncated = halt.halted ? boot.truncatedNoteTemplate.replace('%d', String(boot.maxResults)) : '';
  port.postMessage({ type: 'done', text: results.length === 0 ? '(no matches)' : results.join('\n') + truncated });
} catch (err) {
  port.postMessage({ type: 'done', error: err instanceof Error ? err.message : String(err) });
}
