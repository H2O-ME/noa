import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { estimateTextTokens, truncateUtf8Head } from '@noa/core';

/**
 * Total token budget shared by every AGENTS.md collected for one session.
 *
 * Denominated in TOKENS, not bytes: the estimator charges ~1 token per CJK
 * character and ~1 per 4 others, so a byte cap silently prices a Chinese doc
 * several times over an English one of equal size — the old 32,000-byte cap
 * bought ~9,400 tokens here while discarding 47% of the file.
 */
export const PROJECT_DOC_MAX_TOKENS = 8_000;

/**
 * Project-doc discovery chain (codex agents_md.rs, simplified): the AGENTS.md of
 * every directory from the workspace root down to the working directory, root
 * first, within one shared budget. `cwd` defaults to `rootDir`, never
 * `process.cwd()` — the docs follow the session's workspace, not the launch dir.
 */
export async function collectProjectDocs(
  rootDir: string,
  cwd: string = rootDir,
  maxTokens = PROJECT_DOC_MAX_TOKENS,
): Promise<string[]> {
  const root = path.resolve(rootDir);
  const dirs: string[] = [root];
  const resolvedCwd = path.resolve(cwd);
  const rootLower = `${root.toLowerCase()}${path.sep}`;
  const cwdLower = resolvedCwd.toLowerCase();
  if (cwdLower !== root.toLowerCase() && cwdLower.startsWith(rootLower)) {
    let current = root;
    for (const part of path.relative(root, resolvedCwd).split(path.sep)) {
      current = path.join(current, part);
      dirs.push(current);
    }
  }

  const docs: string[] = [];
  let remaining = maxTokens;
  for (const dir of dirs) {
    if (remaining <= 0) break;
    const text = await readFile(path.join(dir, 'AGENTS.md'), 'utf8').catch(() => undefined);
    if (text === undefined || text.trim().length === 0) continue;
    // Per-doc cap (codex project_doc_max_bytes semantics): a single huge
    // doc is truncated into the remaining budget instead of being taken
    // whole — one bloated AGENTS.md must not starve the deeper directories'
    // docs that follow it, and the total budget stays a hard bound.
    const trimmed = text.trim();
    const priced = estimateTextTokens(trimmed);
    if (priced > remaining) {
      docs.push(`${truncateToTokens(trimmed, remaining)}…[truncated]`);
      remaining = 0;
    } else {
      docs.push(trimmed);
      remaining -= priced;
    }
  }
  return docs;
}

/**
 * Longest head of `text` the estimator prices at or below `maxTokens`.
 *
 * The price is not linear in bytes (CJK costs ~1 token per character against
 * ~1 per 4 others), so scaling a byte count would misprice exactly the
 * documents a token budget exists to protect. Bisecting over the head's byte
 * length keeps the seam on a character boundary.
 * @param text - the doc to cut.
 * @param maxTokens - the tokens this doc may spend.
 * @returns the longest prefix within budget.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  let low = 0;
  let high = Buffer.byteLength(text, 'utf8');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(truncateUtf8Head(text, middle)) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return truncateUtf8Head(text, low);
}
