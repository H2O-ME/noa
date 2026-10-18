import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginHost } from '../src/host.js';
import { workspacePlugin } from '../src/builtin/workspace.js';
import { rowsOf } from './plugin-rows.js';

async function hostAt(root: string, onChange: (dir: string) => Promise<void>): Promise<PluginHost> {
  const host = new PluginHost(root);
  await host.sync(rowsOf([workspacePlugin({ onChange })]));
  return host;
}

describe('switch_workspace', () => {
  it('validates the target and hands the resolved real path to the runner callback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noa-ws-'));
    const other = await mkdtemp(path.join(tmpdir(), 'noa-ws-other-'));
    const nested = path.join(other, 'sub');
    await mkdir(nested, { recursive: true });

    const seen: string[] = [];
    const host = await hostAt(root, async (dir) => {
      seen.push(dir);
    });
    const tool = host.tools.find((t) => t.name === 'switch_workspace')!;

    // Relative to the current root → resolved.
    const out = await tool.execute({ path: path.relative(root, nested) }, { rootDir: root });
    expect(seen).toEqual([await (await import('node:fs/promises')).realpath(nested)]);
    expect(out).toContain('Workspace switched');

    // Absolute path → validated, forwarded.
    await tool.execute({ path: other }, { rootDir: root });
    expect(seen).toHaveLength(2);

    // Missing directory → error, callback never fires.
    expect(await tool.execute({ path: 'no-such-dir' }, { rootDir: root })).toContain('does not exist');
    // A FILE is not a workspace — need an existing file: use the missing-dir check above
    // and here verify empty path rejection.
    expect(await tool.execute({ path: '' }, { rootDir: root })).toContain('non-empty');
    expect(await tool.execute({}, { rootDir: root })).toContain('non-empty');
    expect(seen).toHaveLength(2);
  });

  it('is gated as execute-class (always reviewed in auto)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'noa-ws-'));
    const host = await hostAt(root, async () => undefined);
    const entry = host.toolEntries.find((e) => e.tool.name === 'switch_workspace')!;
    expect(entry.permission).toBe('execute');
  });
});
