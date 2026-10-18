/**
 * Workspace file IO for surfaces: read / write / rename / remove one entry.
 *
 * The path primitives MOVED here from the fs tool (`plugins/builtin/fs.ts`) so
 * the tools and the sidebar share one implementation of "inside the workspace".
 * A second copy of a symlink-aware containment check is exactly the kind of
 * divergence where one surface writes where the other refuses — and the fs
 * tool's copy was the only one, so the sidebar had none.
 *
 * The write discipline is the tool's own: same-directory tmp + atomic rename,
 * carrying the replaced file's mode over.
 */
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isSafeDirectoryName } from './directory-create.js';

/**
 * The read/edit cap shared by the fs tools and the editor panel: 8 MiB. A file
 * over it is not refused — `readTextFile` says so and reports what it read.
 */
export const READ_MAX_BYTES = 8 * 1024 * 1024;

/** Resolve without the workspace restriction (reads may cross it, gated). */
export function resolveAnywhere(rootDir: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('path is required');
  return path.resolve(path.resolve(rootDir), raw);
}

/**
 * Canonical absolute path of the target: realpath of the deepest EXISTING
 * ancestor plus the not-yet-existing remainder (write targets usually do not
 * exist). Pure string prefix checks are fooled by a symlink planted inside
 * the workspace pointing outside it — a write would silently follow it out.
 */
export async function resolveReal(rootDir: string, raw: unknown): Promise<string> {
  return canonicalize(resolveAnywhere(rootDir, raw));
}

async function canonicalize(resolved: string): Promise<string> {
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved; // unreachable on real filesystems
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isCanonicalInside(canonicalRoot: string, canonicalTarget: string): boolean {
  if (process.platform === 'win32') {
    const root = path.resolve(canonicalRoot).toLowerCase();
    const target = path.resolve(canonicalTarget).toLowerCase();
    return target === root || target.startsWith(`${root}${path.sep}`);
  }
  const root = path.resolve(canonicalRoot);
  const target = path.resolve(canonicalTarget);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * Resolve a user/model-supplied path against the workspace root and reject
 * anything that escapes it. The containment check runs on CANONICAL paths, so
 * a symlink inside the workspace pointing outside it is caught.
 */
export async function resolveInRoot(rootDir: string, raw: unknown): Promise<string> {
  const file = await resolveReal(rootDir, raw);
  const realRoot = await canonicalize(path.resolve(rootDir));
  if (!isCanonicalInside(realRoot, file)) {
    throw new Error(`path escapes workspace root: ${raw as string}`);
  }
  return file;
}

/** True when a resolved path stays inside the workspace root (string-only). */
export function isInsideRoot(rootDir: string, resolved: string): boolean {
  return isCanonicalInside(path.resolve(rootDir), resolved);
}

/**
 * Whether a resolved path stays inside the root, comparing CANONICAL forms.
 *
 * Distinct from {@link isInsideRoot} because the ROOT may itself be reached
 * through a symlink (macOS `/tmp`, a mapped drive): comparing a canonical
 * target against a raw root string would read every file as outside and gate
 * reads that should be free.
 */
export async function isInsideRealRoot(rootDir: string, resolved: string): Promise<boolean> {
  const realRoot = await canonicalize(path.resolve(rootDir));
  return isCanonicalInside(realRoot, await canonicalize(resolved));
}

/**
 * Binary/non-UTF8 probe: a C0 control character (tab/lf/cr excepted) or DEL in
 * the sample means reading the file as UTF-8 text would garble output.
 */
export function looksBinary(text: string, sampleChars = 8192): boolean {
  const limit = Math.min(text.length, sampleChars);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
    if (code === 127) return true;
  }
  return false;
}

/** One file as the editor panel reads it. */
export interface TextFileReading {
  /** The canonical absolute path (what a later write must name). */
  path: string;
  /** The text read so far; '' for a binary or oversized file. */
  text: string;
  /** Size on disk, in bytes. */
  bytes: number;
  /** The file is larger than the cap: `text` is empty rather than partial. */
  truncated: boolean;
  /** The sample looks binary: `text` is empty. */
  binary: boolean;
}

/**
 * Read one text file inside the workspace.
 *
 * Oversized and binary files are ANSWERS, not errors: the panel must be able to
 * say "this file is too big to edit here" instead of showing a failed read, and
 * a partial read of a binary would be worse than none.
 * @param rootDir - the workspace root the path must stay inside.
 * @param raw - the requested path (absolute or root-relative).
 * @param maxBytes - the cap; defaults to {@link READ_MAX_BYTES}.
 * @returns the reading, including why `text` is empty when it is.
 */
export async function readTextFile(
  rootDir: string,
  raw: unknown,
  maxBytes: number = READ_MAX_BYTES,
): Promise<TextFileReading> {
  const file = await resolveInRoot(rootDir, raw);
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`不是文件：${raw as string}`);
  if (info.size > maxBytes) return { path: file, text: '', bytes: info.size, truncated: true, binary: false };
  const buffer = await readFile(file);
  const text = buffer.toString('utf8');
  if (looksBinary(text)) return { path: file, text: '', bytes: info.size, truncated: false, binary: true };
  return { path: file, text, bytes: info.size, truncated: false, binary: false };
}

/** Write one text file inside the workspace (same-dir tmp + atomic rename). */
export async function writeTextFile(rootDir: string, raw: unknown, content: string): Promise<{ path: string; bytes: number }> {
  const file = await resolveInRoot(rootDir, raw);
  await atomicWrite(file, content);
  return { path: file, bytes: Buffer.byteLength(content, 'utf8') };
}

/** Move one entry inside the workspace; refuses an existing target. */
export async function renameEntry(rootDir: string, from: unknown, to: unknown): Promise<{ from: string; path: string }> {
  const source = await resolveInRoot(rootDir, from);
  const target = await resolveInRoot(rootDir, to);
  if (source === target) return { from: source, path: target };
  const existing = await stat(target).catch(() => undefined);
  if (existing !== undefined) throw new Error(`目标已存在：${to as string}`);
  const parent = await stat(path.dirname(target)).catch(() => undefined);
  if (parent === undefined || !parent.isDirectory()) throw new Error(`目标目录不存在：${path.dirname(target)}`);
  await rename(source, target);
  return { from: source, path: target };
}

/**
 * Remove one entry (file or directory tree) inside the workspace.
 *
 * The workspace root itself is refused: a sidebar delete is meant for an entry,
 * and "remove everything I am working in" is not an operation this API offers.
 */
export async function removeEntry(rootDir: string, raw: unknown): Promise<{ path: string }> {
  const target = await resolveInRoot(rootDir, raw);
  const root = await canonicalize(path.resolve(rootDir));
  if (target === root) throw new Error('不能删除工作区根目录');
  const info = await stat(target);
  await rm(target, { recursive: info.isDirectory(), force: false });
  return { path: target };
}

/**
 * Create one child file or folder, refusing an existing target.
 * @param kind - `file` creates an empty file, `dir` a folder.
 */
export async function createEntry(
  rootDir: string,
  dir: unknown,
  name: string,
  kind: 'file' | 'dir',
): Promise<{ path: string }> {
  if (!isSafeDirectoryName(name)) throw new Error(`名字不合法：${name}`);
  const parent = await resolveInRoot(rootDir, dir);
  const info = await stat(parent).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new Error(`不是目录：${dir as string}`);
  const target = path.join(parent, name);
  const existing = await stat(target).catch(() => undefined);
  if (existing !== undefined) throw new Error(`已存在同名条目：${name}`);
  if (kind === 'dir') await mkdir(target);
  else await writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
  return { path: target };
}

/**
 * Same-dir tmp + atomic rename; carries the replaced file's mode over.
 *
 * Exported for writers whose target is NOT inside a workspace root — a plugin
 * maintaining its own store under `~/.noa`, say. `writeTextFile` stays the
 * root-constrained door for the MODEL's writes and is what tools use; this is
 * the mechanism underneath it, published because a second copy of
 * temp-file-then-rename is how that discipline drifts. It confers no privilege a
 * plugin did not already have: a plugin is in-process code with `node:fs` in
 * reach, and this only removes the reason to hand-roll it.
 * @param file - the ABSOLUTE target path; the caller owns path resolution.
 * @param content - the text to write.
 */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.noa-tmp-${process.pid}-${(Math.random() * 2 ** 32).toString(36)}`);
  await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    const prior = await stat(file).catch(() => undefined);
    if (prior !== undefined) await chmod(tmp, prior.mode);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
