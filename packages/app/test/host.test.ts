/**
 * The host's four refusal paths, one per cause.
 *
 * These are the product's most important sentences: an operator whose bot is
 * silent must be told WHICH of the four things is wrong. A test that only
 * checked "it exited non-zero" would pass with all four merged into one
 * misleading hint — which is exactly the defect this shape replaced.
 *
 * The provider is injected, so no test here dials an endpoint; the channel is
 * never given usable credentials, so no test here dials the QQ gateway.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatProvider } from '@noa/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_ROW_ID } from '../src/channel-row.js';
import { runHost } from '../src/host.js';

/** A provider stub: one short text, never a network call. */
const provider = {
  model: 'fake',
  async *stream() {
    yield { type: 'text_delta' as const, text: 'ok' };
  },
} as unknown as ChatProvider;

/** A throwaway home holding `~/.noa/config.json` with the given plugin rows. */
async function homeWithRows(entries: readonly unknown[]): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'noa-host-'));
  const dir = path.join(home, '.noa');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'config.json'),
    `${JSON.stringify({ plugins: { entries } }, null, 2)}\n`,
    'utf8',
  );
  return home;
}

/** Capture everything the host writes to either stream. */
function captureOutput(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    },
  };
}

describe('runHost · why the channel is not up', () => {
  let output: ReturnType<typeof captureOutput>;

  beforeEach(() => {
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  it('names the missing row and the command that writes one', async () => {
    const home = await homeWithRows([]);
    const code = await runHost({ homedir: home, provider, check: true });
    expect(code).toBe(1);
    expect(output.text()).toContain(`没有「${CHANNEL_ROW_ID}」这一行`);
    expect(output.text()).toContain('noa init');
  });

  it('says the row is switched off rather than missing', async () => {
    const home = await homeWithRows([{ id: CHANNEL_ROW_ID, enabled: false }]);
    const code = await runHost({ homedir: home, provider, check: true });
    expect(code).toBe(1);
    expect(output.text()).toContain('它是关着的');
  });

  it('reports an open row with no credentials as missing credentials', async () => {
    const home = await homeWithRows([
      { id: CHANNEL_ROW_ID, enabled: true, config: { appId: '', clientSecret: '' } },
    ]);
    const code = await runHost({ homedir: home, provider, check: true });
    expect(code).toBe(1);
    expect(output.text()).toContain('appId / clientSecret 还没填');
  });

  it('reports a row whose module cannot load as a LOAD failure, not as "switch it on"', async () => {
    const home = await homeWithRows([{ id: './no-such-channel-7c1.mjs', enabled: true }]);
    const code = await runHost({ homedir: home, provider, check: true });
    expect(code).toBe(1);
    // The row the host cares about is still absent; what this pins is that a
    // broken row elsewhere is reported (a warning) without stopping the boot.
    expect(output.text()).toContain('加载失败');
    expect(output.text()).toContain(`没有「${CHANNEL_ROW_ID}」这一行`);
  });
});
