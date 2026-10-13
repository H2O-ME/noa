/**
 * Creating one folder, for a surface's workspace picker.
 *
 * Split from the listing because the two answer different questions and fail
 * differently: listing is a read whose refusal ("cannot read this level") must
 * stay distinguishable from an empty level, while creation is a write that must
 * refuse an existing target rather than adopt somebody else's directory. Both
 * validate names, so the name rule lives here with the write that depends on it.
 */
import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { hasControlChars } from './text.js';

/** Longest accepted name for a folder the picker creates. */
export const MAX_DIRECTORY_NAME_CHARS = 64;

/** Characters no path segment may carry (the portable set, not just Windows'). */
const ILLEGAL_NAME_RE = /[\\/:*?"<>|]/;

/**
 * Whether a name is a single, safe directory segment.
 *
 * The picker creates a folder from a user-typed string, so this is the check
 * that the string cannot escape its parent (`..`), address a path (`a/b`), or
 * carry control junk. Windows' reserved punctuation is refused on every
 * platform: a name that works here and breaks there is not a name this product
 * should accept.
 * @param name - the candidate segment.
 * @returns whether it may be created as one directory.
 */
export function isSafeDirectoryName(name: string): boolean {
  if (name === '' || name.length > MAX_DIRECTORY_NAME_CHARS) return false;
  if (name === '.' || name === '..') return false;
  if (name.trim() !== name) return false;
  if (hasControlChars(name)) return false;
  return !ILLEGAL_NAME_RE.test(name);
}

/**
 * Create one child directory, returning its path.
 *
 * Refuses an existing target rather than adopting it: the caller asked to
 * create a folder, and silently handing back somebody else's directory would
 * make "created" a claim the host cannot support.
 * @param parent - absolute directory the new folder goes in.
 * @param name - one path segment (validated by {@link isSafeDirectoryName}).
 * @returns the created absolute path.
 */
export async function createDirectory(parent: string, name: string): Promise<string> {
  if (!isSafeDirectoryName(name)) throw new Error(`文件夹名不合法：${name}`);
  const base = path.resolve(parent);
  const info = await stat(base).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new Error(`不是目录：${parent}`);
  const target = path.join(base, name);
  const existing = await stat(target).catch(() => undefined);
  if (existing !== undefined) throw new Error(`已存在同名文件夹：${name}`);
  await mkdir(target);
  return target;
}
