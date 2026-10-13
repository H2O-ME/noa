/**
 * The config loader: what a first run does, what a broken file does, and which
 * keys are refused.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigWithDiagnostics } from '../src/config.js';

/** A throwaway home with `~/.noa/config.json` written from `doc`. */
async function homeWith(doc: unknown | string): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'noa-cfg-'));
  const dir = path.join(home, '.noa');
  await mkdir(dir, { recursive: true });
  const text = typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`;
  await writeFile(path.join(dir, 'config.json'), text, 'utf8');
  return home;
}

describe('loadConfigWithDiagnostics', () => {
  it('treats a missing file as the supported first-run state', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'noa-cfg-'));
    const { config, diagnostics } = await loadConfigWithDiagnostics(home);
    expect(config).toEqual({});
    expect(diagnostics).toEqual([]);
  });

  it('throws on malformed JSON instead of replacing the operator\'s file', async () => {
    const home = await homeWith('{ this is not json');
    await expect(loadConfigWithDiagnostics(home)).rejects.toThrow(/invalid JSON/u);
  });

  it('refuses an unknown key by name (a typo must not read as saved)', async () => {
    const home = await homeWith({ apporval: 'full' });
    await expect(loadConfigWithDiagnostics(home)).rejects.toThrow(/apporval/u);
  });

  it('refuses two rows with the same plugin id', async () => {
    const home = await homeWith({
      plugins: { entries: [{ id: 'bash' }, { id: 'bash', enabled: false }] },
    });
    await expect(loadConfigWithDiagnostics(home)).rejects.toThrow(/重复的插件 id/u);
  });

  it('keeps an unset {env:} in a plugin row as a diagnostic, and expands core sections', async () => {
    process.env['NOA_TEST_KEY'] = 'sk-from-env';
    try {
      const home = await homeWith({
        provider: { baseURL: 'https://example.test/v1', apiKey: '{env:NOA_TEST_KEY}', model: 'm' },
        plugins: { entries: [{ id: 'bash', config: { shellPath: '{env:NOA_TEST_UNSET}' } }] },
      });
      const { config, diagnostics } = await loadConfigWithDiagnostics(home);
      // The endpoint's reference is CORE-owned: it resolves, or the load fails.
      expect(config.provider?.apiKey).toBe('sk-from-env');
      // The row's reference belongs to that plugin: it survives as written, with
      // one diagnostic naming the variable.
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]?.variable).toBe('NOA_TEST_UNSET');
    } finally {
      delete process.env['NOA_TEST_KEY'];
    }
  });

  it('fails the load when a CORE section references an unset variable', async () => {
    const home = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: '{env:NOA_TEST_UNSET}', model: 'm' },
    });
    await expect(loadConfigWithDiagnostics(home)).rejects.toThrow(/NOA_TEST_UNSET/u);
  });
});
