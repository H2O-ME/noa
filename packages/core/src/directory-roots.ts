/**
 * Which filesystem roots exist on this host.
 *
 * A picker that can only walk down from the home directory cannot leave it: on
 * POSIX the home subtree hangs off `/`, so `dirname` eventually reaches it, but
 * on Windows a drive letter is a **dead end** — `dirname('C:\\') === 'C:\\'` —
 * and the home directory sits on exactly one drive. Every other volume (a `D:`
 * data disk, a mounted backup volume, a second SSD) is then unreachable no
 * matter how far up the user clicks.
 *
 * So the roots are a host fact, like the listing itself: the browser cannot see
 * them, and no amount of walking derives them. They are reported with every
 * level so the picker can offer the entry point at any depth.
 *
 * The name of a root is its own path: `basename` of a root is `''` on both
 * platforms, so there is no segment to label a drive row with.
 */
import { stat } from 'node:fs/promises';
import type { DirectoryCrumb } from './directory-listing.js';

/** Drive letters a Windows host may carry (A: and B: included — floppies are gone, but the letters are legal). */
const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/**
 * One crumb per reachable filesystem root, in platform order.
 *
 * On Windows a drive is "reachable" when it can be `stat`ed: an empty optical
 * drive and an unassigned letter both fail, and offering a row that errors on
 * click is worse than not offering it. The probes run concurrently, so the
 * cost is one round of syscalls rather than twenty-six in series.
 *
 * A refusal here is `readdir`-like in kind and returned as the empty case: a
 * host with no readable root still lists levels, it just has no shortcuts.
 * @param platform - replaces `process.platform` for deterministic tests.
 * @returns the reachable roots, each named by its own path.
 */
export async function listDirectoryRoots(platform: NodeJS.Platform = process.platform): Promise<DirectoryCrumb[]> {
  if (platform !== 'win32') return [{ name: '/', path: '/' }];
  const probes = await Promise.all(DRIVE_LETTERS.map(async (letter): Promise<string | undefined> => {
    const root = `${letter}:\\`;
    const info = await stat(root).catch(() => undefined);
    return info?.isDirectory() === true ? root : undefined;
  }));
  return probes
    .filter((root): root is string => root !== undefined)
    .map((root) => ({ name: root, path: root }));
}
