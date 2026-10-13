/**
 * Which shell a command actually runs in — one answer, two callers.
 *
 * The bash tool and the human's panel terminal ask different questions and must
 * not carry two PATH probes, two name→executable maps, or two argument tables
 * (web used to keep its own `ptyInvocation`, which could not name pwsh at all):
 *
 * - **the model's shell** (`resolveModelShell`): PowerShell 7 when it is
 *   installed, then Git Bash, then Windows PowerShell. The context fragment
 * *declares* this SAME resolution to the model, so a command written for the
 *   shell that will really run it is not a coincidence.
 * - **the panel's shell** (`panelShell`): the environment's own default
 *   (`%COMSPEC%` / `$SHELL`) — what the operator typed into a terminal before
 *   opening this app, not what the agent prefers.
 *
 * Discovery (`discoverShells`) verifies each candidate by resolving its
 * executable, dedupes by path, and puts the default first; a candidate that is
 * not installed is absent from the list rather than a broken menu row.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** How a shell is invoked: the argument families differ, the display name does not decide. */
export type ShellFamily = 'posix' | 'pwsh' | 'powershell' | 'cmd';

/** One installed shell, as the menu and the spawner both need it. */
export interface ShellCandidate {
  /** The display name: the executable's basename without its extension. */
  name: string;
  /** The resolved executable path (or the bare name when PATH will resolve it). */
  path: string;
  /** Which argument table applies to it. */
  family: ShellFamily;
}

/** An executable's resolved path, or undefined when it is not installed. */
export function findExecutable(name: string): string | undefined {
  if (name.includes('/') || name.includes('\\')) {
    try { return existsSync(name) ? name : undefined; } catch { return undefined; }
  }
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir.trim().length === 0) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix);
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // An unreadable PATH entry is a skipped directory, not a failed probe.
      }
    }
  }
  return undefined;
}

/**
 * The family of one executable, read from its file name.
 * @param exePath - a name or a resolved path.
 * @returns the argument family to use for it.
 */
export function shellFamily(exePath: string): ShellFamily {
  const base = path.basename(exePath).toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh' || base === 'pwsh-preview') return 'pwsh';
  if (base === 'powershell') return 'powershell';
  if (base === 'cmd') return 'cmd';
  return 'posix';
}

/** The display name of one executable: its basename, extension dropped. */
export function shellName(exePath: string): string {
  return path.basename(exePath).replace(/\.exe$/i, '');
}

/** One installed candidate, or undefined when the executable is not there. */
function candidate(exePath: string): ShellCandidate | undefined {
  const resolved = findExecutable(exePath);
  if (resolved === undefined) return undefined;
  return { name: shellName(resolved), path: resolved, family: shellFamily(resolved) };
}

/**
 * Whether a POSIX bash is on PATH — the bash tool's tests gate on it.
 *
 * This used to answer "is `bash.exe` on PATH" and return false on every POSIX
 * system, which silently skipped the Windows-shaped tests on Linux too. The
 * question the tests ask is "is there a bash", so that is what it answers now.
 */
export function bashOnPath(): boolean {
  return findExecutable('bash') !== undefined;
}

/**
 * The shell the MODEL's commands run through, as one candidate.
 *
 * Preference: an explicit `tools.bash.shellPath` (its own family wins — a
 * configured `pwsh.exe` must not be handed `-c`), else PowerShell 7, else Git
 * Bash, else Windows PowerShell, else `cmd`. The candidate's `name` is what the
 * context fragment DECLARES to the model, and its `family` is what actually
 * runs the command — one resolution, so the two cannot drift.
 * @param shellPath - the configured executable, if any.
 * @returns the installed shell to use.
 */
export function modelShell(shellPath: string | undefined): ShellCandidate {
  if (shellPath !== undefined && shellPath.length > 0) {
    return { name: shellName(shellPath), path: shellPath, family: shellFamily(shellPath) };
  }
  if (process.platform === 'win32') {
    for (const name of ['pwsh', 'bash', 'powershell']) {
      const found = candidate(name);
      if (found !== undefined) return found;
    }
    const cmd = candidate('cmd') ?? { name: 'cmd', path: 'cmd.exe', family: 'cmd' as const };
    return cmd;
  }
  return candidate('bash') ?? { name: 'sh', path: 'sh', family: 'posix' };
}

/**
 * The shell the HUMAN's panel terminal starts in: the environment's own default.
 * @returns the installed default candidate, or the first installed one.
 */
export function panelShell(): ShellCandidate {
  const fromEnv = process.platform === 'win32' ? process.env['COMSPEC'] : process.env['SHELL'];
  const preferred = fromEnv === undefined || fromEnv.length === 0 ? undefined : candidate(fromEnv);
  return preferred ?? installedShells()[0] ?? { name: 'sh', path: 'sh', family: 'posix' };
}

/**
 * Every installed shell the panel can offer, the default FIRST, deduped by path.
 *
 * The order is the contract: the menu's first row is what a fresh terminal
 * becomes, so a reader who never touches the picker still gets their own
 * environment's shell (dsh's `resolveShell` puts the same reading first).
 * @returns candidates for the shell menu (never a row that would fail to spawn).
 */
export function shellCandidates(): ShellCandidate[] {
  const all = installedShells();
  const preferred = panelShell();
  return [preferred, ...all.filter((item) => item.path.toLowerCase() !== preferred.path.toLowerCase())];
}

/** The installed shells in probe order (no default hoisting yet). */
function installedShells(): ShellCandidate[] {
  const names = process.platform === 'win32'
    ? ['pwsh', 'bash', 'powershell', process.env['COMSPEC'] ?? 'cmd']
    : [process.env['SHELL'] ?? '', 'bash', 'sh'];
  const seen = new Set<string>();
  const out: ShellCandidate[] = [];
  const probe = (exePath: string): void => {
    const found = candidate(exePath);
    if (found === undefined) return;
    const key = found.path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(found);
  };
  for (const name of names) {
    if (name.length === 0) continue;
    probe(name);
  }
  if (process.platform === 'win32') {
    // A standard-installed pwsh is often NOT on PATH (the MSI does not add
    // itself), so the PATH probe alone misses it — the operator's 「没法用
    // powershell7」. The well-known install locations close that gap.
    for (const location of windowsPowerShellLocations(process.env['ProgramFiles'], process.env['LocalAppData'])) {
      probe(location);
    }
  }
  return out;
}

/**
 * The standard install locations of PowerShell 7 on Windows, as absolute
 * paths — pure, so the well-known table is testable on any platform.
 * @param programFiles - `%ProgramFiles%` (the MSI's default root).
 * @param localAppData - `%LocalAppData%` (the Store/zip-per-user location).
 * @returns candidate executables, most standard first.
 */
export function windowsPowerShellLocations(
  programFiles: string | undefined,
  localAppData: string | undefined,
): string[] {
  const out: string[] = [];
  for (const version of ['7', '6', '7-preview']) {
    if (programFiles !== undefined && programFiles.length > 0) {
      out.push(path.join(programFiles, 'PowerShell', version, 'pwsh.exe'));
    }
  }
  if (localAppData !== undefined && localAppData.length > 0) {
    out.push(path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  }
  return out;
}

/**
 * The command form: one shell, one command string, captured output.
 * @param family - the resolved family.
 * @param command - the script to run.
 * @param shellPath - the configured executable (only honored for POSIX today).
 * @returns the program and arguments to spawn.
 */
export function commandInvocation(
  family: ShellFamily, command: string, shellPath?: string,
): { cmd: string; args: string[] } {
  if (family === 'pwsh') return { cmd: shellPath ?? 'pwsh.exe', args: psArgs(command) };
  if (family === 'powershell') return { cmd: shellPath ?? 'powershell.exe', args: psArgs(command) };
  if (family === 'cmd') {
    return { cmd: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { cmd: shellPath ?? (process.platform === 'win32' ? 'bash.exe' : 'bash'), args: ['-c', command] };
}

/** PowerShell's argument vector: no profile, UTF-8 forced, then the command. */
function psArgs(command: string): string[] {
  return ['-NoProfile', '-Command', `${POWERSHELL_UTF8_PREFIX}\n${command}`];
}

/**
 * Windows PowerShell defaults to the legacy console codepage (e.g. GBK on
 * zh-CN systems), which garbles non-ASCII output read as UTF-8.
 */
export const POWERSHELL_UTF8_PREFIX =
  'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}';

/**
 * The interactive form: a PTY reading the keyboard, so no `-c` anywhere.
 * @param target - the candidate to spawn.
 * @returns the program and arguments node-pty needs.
 */
export function ptyInvocation(target: ShellCandidate): { file: string; args: string[] } {
  if (target.family === 'pwsh' || target.family === 'powershell') {
    return { file: target.path, args: ['-NoLogo'] };
  }
  if (target.family === 'cmd') return { file: target.path, args: [] };
  return { file: target.path, args: ['-i'] };
}
