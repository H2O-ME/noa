/**
 * The shell resolution table — one answer for the model, one for the operator.
 *
 * The interesting cases are the ones this repo got wrong before: a configured
 * `pwsh.exe` handed `-c` (the old code treated ANY `shellPath` as POSIX), the
 * panel and the model disagreeing about which shell is running, and a menu row
 * for an executable that is not installed. Each test below pins one of those.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commandInvocation,
  findExecutable,
  modelShell,
  panelShell,
  ptyInvocation,
  shellCandidates,
  shellFamily,
  shellName,
  POWERSHELL_UTF8_PREFIX,
  windowsPowerShellLocations,
} from '../src/builtin/shell-select.js';

const savedPath = process.env['PATH'];
const savedComspec = process.env['COMSPEC'];
const savedShell = process.env['SHELL'];

afterEach(() => {
  process.env['PATH'] = savedPath;
  process.env['COMSPEC'] = savedComspec;
  process.env['SHELL'] = savedShell;
});

/** A temp directory holding one empty file per name, as the only PATH entry. */
async function fakeBin(...names: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-shell-'));
  for (const name of names) await writeFile(path.join(dir, name), '');
  return dir;
}

const suffix = (): string => (process.platform === 'win32' ? '.exe' : '');

describe('shellFamily / shellName', () => {
  it('reads the family from the file name, not from where it came from', () => {
    expect(shellFamily('pwsh')).toBe('pwsh');
    expect(shellFamily('C:/Program Files/PowerShell/7/pwsh.exe')).toBe('pwsh');
    expect(shellFamily('powershell.exe')).toBe('powershell');
    expect(shellFamily('cmd.exe')).toBe('cmd');
    expect(shellFamily('/usr/local/bin/bash')).toBe('posix');
    expect(shellFamily('zsh')).toBe('posix');
  });

  it('drops the extension for the display name', () => {
    expect(shellName('/x/pwsh.EXE')).toBe('pwsh');
    expect(shellName('bash')).toBe('bash');
  });
});

describe('commandInvocation', () => {
  it('runs POSIX shells with -c and honors the configured binary', () => {
    expect(commandInvocation('posix', 'ls')).toEqual({
      cmd: process.platform === 'win32' ? 'bash.exe' : 'bash', args: ['-c', 'ls'],
    });
    expect(commandInvocation('posix', 'ls', '/opt/bash').cmd).toBe('/opt/bash');
  });

  it('runs both PowerShell families with no profile and the UTF-8 statement first', () => {
    for (const [family, cmd] of [['pwsh', 'pwsh.exe'], ['powershell', 'powershell.exe']] as const) {
      const inv = commandInvocation(family, 'Get-ChildItem');
      expect(inv.cmd).toBe(cmd);
      expect(inv.args[0]).toBe('-NoProfile');
      const script = inv.args[2] ?? '';
      expect(script.startsWith(POWERSHELL_UTF8_PREFIX)).toBe(true);
      expect(script.endsWith('Get-ChildItem')).toBe(true);
    }
  });

  it('runs cmd with the switch trio so quoting stays the command’s own', () => {
    const inv = commandInvocation('cmd', 'echo hi');
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(inv.args[3]).toBe('echo hi');
  });
});

describe('ptyInvocation', () => {
  it('never carries -c: the shell reads the keyboard now', () => {
    for (const family of ['posix', 'pwsh', 'powershell', 'cmd'] as const) {
      const { args } = ptyInvocation({ name: 'x', path: 'x', family });
      expect(args).not.toContain('-c');
    }
  });

  it('gives each family its own interactive arguments', () => {
    expect(ptyInvocation({ name: 'b', path: 'b', family: 'posix' }).args).toEqual(['-i']);
    expect(ptyInvocation({ name: 'p', path: 'p', family: 'pwsh' }).args).toEqual(['-NoLogo']);
    expect(ptyInvocation({ name: 'c', path: 'c', family: 'cmd' }).args).toEqual([]);
  });
});

describe('modelShell', () => {
  it('a configured pwsh is a PowerShell, not a POSIX shell with a new name', async () => {
    const pwsh = path.join(await fakeBin(`pwsh${suffix()}`), `pwsh${suffix()}`);
    const shell = modelShell(pwsh);
    expect(shell.family).toBe('pwsh');
    expect(commandInvocation(shell.family, 'x', shell.path).args[0]).toBe('-NoProfile');
  });

  it('prefers PowerShell 7, then Git Bash, then Windows PowerShell', async () => {
    if (process.platform !== 'win32') {
      expect(modelShell(undefined).family).toBe('posix');
      return;
    }
    const both = await fakeBin('pwsh.exe', 'bash.exe', 'powershell.exe');
    process.env['PATH'] = both;
    expect(modelShell(undefined).name).toBe('pwsh');
    process.env['PATH'] = await fakeBin('bash.exe', 'powershell.exe');
    expect(modelShell(undefined).name).toBe('bash');
    process.env['PATH'] = await fakeBin('powershell.exe');
    expect(modelShell(undefined).name).toBe('powershell');
  });
});

describe('panelShell and shellCandidates', () => {
  it('the panel starts in the environment’s own default, not the model’s choice', async () => {
    if (process.platform !== 'win32') {
      process.env['PATH'] = await fakeBin('bash', 'sh');
      process.env['SHELL'] = '/usr/bin/not-a-real-zsh';
      // An unresolvable $SHELL is not a menu row: discovery falls through.
      expect(findExecutable('/usr/bin/not-a-real-zsh')).toBeUndefined();
      expect(['bash', 'sh']).toContain(panelShell().name);
      return;
    }
    process.env['PATH'] = await fakeBin('pwsh.exe', 'bash.exe', 'cmd.exe');
    process.env['COMSPEC'] = path.join(process.env['PATH'], 'cmd.exe');
    // The model would take pwsh; the operator's terminal takes cmd.
    expect(modelShell(undefined).name).toBe('pwsh');
    expect(panelShell().name).toBe('cmd');
  });

  it('lists only installed shells, the default first, deduped by path', async () => {
    const bin = await fakeBin('pwsh.exe', 'bash.exe', 'cmd.exe');
    process.env['PATH'] = `${path.delimiter}${bin}${path.delimiter}${bin}${path.delimiter}`;
    if (process.platform === 'win32') process.env['COMSPEC'] = path.join(bin, 'cmd.exe');
    const items = shellCandidates();
    expect(items.length).toBeGreaterThan(0);
    const paths = items.map((item) => item.path.toLowerCase());
    expect(new Set(paths).size).toBe(paths.length);
    // The contract, not a name: row one is what a fresh terminal becomes.
    expect(paths[0]).toBe(panelShell().path.toLowerCase());
    for (const item of items) expect(findExecutable(item.path)).toBeDefined();
  });
});

describe('windowsPowerShellLocations', () => {
  it('names the standard MSI and per-user install locations of pwsh', () => {
    // A standard-installed pwsh is often NOT on PATH; discovery must look in
    // the well-known locations or the operator's 「没法用 powershell7」.
    const locations = windowsPowerShellLocations('C:/Program Files', 'C:/Users/me/AppData/Local');
    expect(locations).toContain(path.join('C:/Program Files', 'PowerShell', '7', 'pwsh.exe'));
    expect(locations).toContain(path.join('C:/Program Files', 'PowerShell', '6', 'pwsh.exe'));
    expect(locations).toContain(path.join('C:/Program Files', 'PowerShell', '7-preview', 'pwsh.exe'));
    expect(locations).toContain(path.join('C:/Users/me/AppData/Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  });

  it('yields nothing when the environment roots are unset', () => {
    expect(windowsPowerShellLocations(undefined, undefined)).toEqual([]);
  });
});
