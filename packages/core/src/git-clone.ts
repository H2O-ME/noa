/**
 * Getting a repository (clone), split from operating on one (`git.ts`).
 *
 * The two answer different questions — provisioning a workspace vs. reading
 * and mutating the repo it holds — and the clone carries its own risks (a
 * remote URL, a derived directory name), so it lives by itself.
 */
import path from 'node:path';
import { isSafeDirectoryName } from './directory-create.js';
import { git } from './git.js';
import { hasControlChars } from './text.js';

/** Wall clock one clone may take: a network fetch, not a local tree walk. */
const GIT_CLONE_TIMEOUT_MS = 10 * 60_000;

/**
 * The directory name one clone target gets: the URL's last segment, minus a
 * trailing `.git`. `https://host/org/repo.git` → `repo`; a bare local path
 * works the same way. Exported because the wire layer's error message names
 * the rule ("无法从该 URL 得出目录名") before git ever runs.
 * @param url - the repository URL or path, verbatim.
 */
export function repoNameOf(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const last = trimmed.split(/[\\/]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

/**
 * Clone one repository into `parentDir`, creating `<parentDir>/<name>`.
 *
 * argv-only like every other git call here, and `--` sits between the
 * subcommand and the URL: a repository argument that begins with `-`
 * (`--upload-pack=…`) is DATA, never an option — the one injection a clone
 * URL could carry. The target name comes from the URL (see
 * {@link repoNameOf}) and must survive `isSafeDirectoryName`, so the clone
 * cannot be steered outside `parentDir` or onto a reserved Windows name.
 * @param parentDir - the directory the clone is created inside (git's cwd).
 * @param url - the repository URL or local path.
 * @param name - the target directory name; derived from the URL when absent.
 * @returns the absolute path of the cloned repository.
 */
export async function gitClone(parentDir: string, url: string, name?: string): Promise<{ path: string }> {
  const trimmed = url.trim();
  if (trimmed.length === 0) throw new Error('仓库 URL 不能为空');
  if (hasControlChars(trimmed)) throw new Error('仓库 URL 含有控制字符');
  const target = (name ?? repoNameOf(trimmed)).trim();
  if (target.length === 0) throw new Error('无法从该 URL 得出目录名，请改用以仓库名结尾的 URL');
  if (!isSafeDirectoryName(target)) throw new Error(`目标目录名不合法：${target}`);
  await git(parentDir, ['clone', '--', trimmed, target], GIT_CLONE_TIMEOUT_MS);
  return { path: path.join(path.resolve(parentDir), target) };
}
