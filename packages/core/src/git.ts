/**
 * The workspace's git view, for the sidebar's 变更 tab: read the working tree
 * (status / diff / log) and offer the three operations a changes list needs
 * (stage / unstage / commit).
 *
 * **git is invoked as a program, never through a shell**: every argument is
 * passed as an argv element, so a file name with a space, a quote or a `;` is
 * just a file name. Paths are resolved against the workspace first (the same
 * containment check the fs tools use) and handed to git as root-relative
 * pathspecs, so no request can name a path outside the workspace.
 *
 * Deliberately NOT here: staging hunks, rebase/cherry-pick/reset --hard, and
 * anything that rewrites history. A panel that can lose work needs a design
 * for it; this one only adds to the index and commits. Getting a repository
 * (clone) is its own module: `git-clone.ts`.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { readTextFile, resolveInRoot } from './file-io.js';

/** Wall clock one git invocation may take. */
const GIT_TIMEOUT_MS = 15_000;
/** Bytes one git invocation may print (a huge diff is capped, not fatal). */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** One row of `git status --porcelain`. */
export interface GitStatusEntry {
  /** Root-relative path (forward slashes, git's own convention). */
  path: string;
  /** The index column of the two-letter status code (' ' when unmodified). */
  index: string;
  /** The worktree column of the two-letter status code. */
  worktree: string;
  /** The rename/copy source, when the entry is one. */
  from?: string;
}

/** The working tree as the panel reads it. */
export interface GitStatus {
  /** False when the workspace is not inside a git repository. */
  repo: boolean;
  /** The checked-out branch name, when there is one (detached HEAD: 'HEAD'). */
  branch: string;
  /** Changed entries, in git's own order. */
  entries: GitStatusEntry[];
}

/** One file's diff text. */
export interface GitDiff {
  path: string;
  /** Whether this is the staged (index) side. */
  staged: boolean;
  text: string;
  /** The diff was capped at the buffer size. */
  truncated: boolean;
}

/** One commit row. */
export interface GitLogEntry {
  hash: string;
  short: string;
  author: string;
  /** ISO-8601 author date. */
  date: string;
  subject: string;
}

/**
 * Run one git command in the workspace.
 * @param rootDir - the workspace root (git's cwd).
 * @param args - argv after `git`.
 * @param timeoutMs - wall clock budget (the default fits local operations).
 * @returns stdout.
 */
export async function git(rootDir: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd: rootDir, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err !== null) {
          const message = (stderr || err.message).trim();
          reject(new Error(message === '' ? err.message : message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Root-relative, forward-slashed pathspec for one workspace path. */
async function pathspecOf(rootDir: string, raw: string): Promise<string> {
  const file = await resolveInRoot(rootDir, raw);
  const relative = path.relative(path.resolve(rootDir), file);
  if (relative === '' || relative.startsWith('..')) throw new Error(`路径不在工作区内：${raw}`);
  return relative.split(path.sep).join('/');
}

/**
 * Read the working tree's status.
 *
 * `-z` rather than the newline form: a path may contain a newline, and a
 * line-split parser would silently mis-read such an entry. Rename/copy entries
 * carry TWO NUL-separated fields (the new path, then the old one).
 * @param rootDir - the workspace root.
 * @returns the status, with `repo: false` when git is absent or this is not a
 *   repository — an answer the panel renders, not an error it reports.
 */
export async function gitStatus(rootDir: string): Promise<GitStatus> {
  const inside = await git(rootDir, ['rev-parse', '--is-inside-work-tree']).catch(() => '');
  if (inside.trim() !== 'true') return { repo: false, branch: '', entries: [] };
  const branch = (await git(rootDir, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
  const raw = await git(rootDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const fields = raw.split('\0');
  const entries: GitStatusEntry[] = [];
  for (let at = 0; at < fields.length; at += 1) {
    const field = fields[at];
    if (field === undefined || field.length < 4) continue;
    const index = field[0] ?? ' ';
    const worktree = field[1] ?? ' ';
    const entry: GitStatusEntry = { path: field.slice(3), index, worktree };
    if (index === 'R' || index === 'C') {
      const from = fields[at + 1];
      if (from !== undefined && from !== '') {
        entry.from = from;
        at += 1;
      }
    }
    entries.push(entry);
  }
  return { repo: true, branch: branch === '' ? 'HEAD' : branch, entries };
}

/**
 * One file's diff.
 *
 * An UNTRACKED file has no diff at all (`git diff` prints nothing): the panel
 * falls back to reading the file, which is the honest rendering of "this is
 * entirely new".
 * @param file - the workspace path (absolute or root-relative).
 * @param staged - true for the index side (`--cached`).
 */
export async function gitDiff(rootDir: string, file: string, staged: boolean): Promise<GitDiff> {
  const pathspec = await pathspecOf(rootDir, file);
  const args = ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', pathspec];
  const text = await git(rootDir, args);
  return {
    path: pathspec,
    staged,
    text,
    truncated: Buffer.byteLength(text, 'utf8') >= GIT_MAX_BUFFER,
  };
}

/** Bytes one untracked file may contribute to its all-added diff. */
const UNTRACKED_DIFF_MAX_BYTES = 1024 * 1024;

/**
 * An untracked file's diff.
 *
 * `git diff` prints nothing for an untracked path, but the reader clicked a
 * changed file and "entirely new" has an honest rendering: the whole file as
 * added lines (the reference's untracked full-addition fallback). Binary and
 * oversized files answer an EMPTY text — a partial read of either would be
 * worse than none, and the panel says so instead of inventing content.
 * @param rootDir - the workspace root.
 * @param file - the workspace path (absolute or root-relative).
 * @returns the diff with a synthetic all-`+` hunk as its text.
 */
export async function gitUntrackedDiff(rootDir: string, file: string): Promise<GitDiff> {
  const pathspec = await pathspecOf(rootDir, file);
  const reading = await readTextFile(rootDir, pathspec, UNTRACKED_DIFF_MAX_BYTES);
  if (reading.text === '') return { path: pathspec, staged: false, text: '', truncated: reading.truncated };
  const lines = reading.text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const text = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
  return { path: pathspec, staged: false, text, truncated: false };
}

/** Add paths to the index. */
export async function gitStage(rootDir: string, files: readonly string[]): Promise<string[]> {
  const paths = await Promise.all(files.map((file) => pathspecOf(rootDir, file)));
  await git(rootDir, ['add', '--', ...paths]);
  return paths;
}

/**
 * Remove paths from the index (the "unstage" direction).
 *
 * `reset` needs a HEAD to reset against; on a repository with no commits yet
 * the equivalent is dropping the entries from the index, so that is the
 * fallback rather than an error the reader cannot act on.
 */
export async function gitUnstage(rootDir: string, files: readonly string[]): Promise<string[]> {
  const paths = await Promise.all(files.map((file) => pathspecOf(rootDir, file)));
  try {
    await git(rootDir, ['reset', '-q', 'HEAD', '--', ...paths]);
  } catch {
    await git(rootDir, ['rm', '--cached', '-r', '--quiet', '--', ...paths]);
  }
  return paths;
}

/** Commit the index with one message; answers with the new commit's short hash. */
export async function gitCommit(rootDir: string, message: string): Promise<{ short: string; summary: string }> {
  const trimmed = message.trim();
  if (trimmed === '') throw new Error('提交说明不能为空');
  const out = await git(rootDir, ['commit', '-m', trimmed]);
  const short = (await git(rootDir, ['rev-parse', '--short', 'HEAD']).catch(() => '')).trim();
  const summary = out.split('\n').map((line) => line.trim()).filter((line) => line !== '')[0] ?? '';
  return { short, summary };
}

/** The most recent commits, newest first. */
export async function gitLog(rootDir: string, limit = 30): Promise<GitLogEntry[]> {
  const count = Math.max(1, Math.min(200, Math.trunc(limit)));
  const out = await git(rootDir, ['log', `-n${count}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s']);
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .map((line) => {
      const [hash = '', short = '', author = '', date = '', subject = ''] = line.split('\x1f');
      return { hash, short, author, date, subject };
    });
}

