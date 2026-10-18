/**
 * The config loader: what a first run does, what a broken file does, and which
 * keys are refused.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigWithDiagnostics } from '../src/config.js';
import { healConfigFile } from '../src/config-doc.js';
import { modelDefaultsPort, readDefaultModel, setDefaultModel } from '../src/config-write.js';

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

  it('accepts ordered provider fallbacks, expanding {env:} inside them', async () => {
    process.env['NOA_TEST_BACKUP_KEY'] = 'sk-backup';
    try {
      const home = await homeWith({
        provider: {
          baseURL: 'https://example.test/v1',
          apiKey: 'sk-primary',
          model: 'm',
          fallbacks: [
            { baseURL: 'https://backup.test/v1', apiKey: '{env:NOA_TEST_BACKUP_KEY}' },
            { baseURL: 'https://mirror.test/v1', apiKey: 'sk-mirror', model: 'm-mirror' },
          ],
        },
      });
      const { config } = await loadConfigWithDiagnostics(home);
      // The endpoint section is CORE-owned, so a reference in it resolves or the
      // load fails — a fallback credential gets the same treatment as the primary.
      expect(config.provider?.fallbacks).toEqual([
        { baseURL: 'https://backup.test/v1', apiKey: 'sk-backup' },
        { baseURL: 'https://mirror.test/v1', apiKey: 'sk-mirror', model: 'm-mirror' },
      ]);
    } finally {
      delete process.env['NOA_TEST_BACKUP_KEY'];
    }
  });

  it('refuses an empty fallback list and a typo inside a fallback entry', async () => {
    const empty = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', fallbacks: [] },
    });
    await expect(loadConfigWithDiagnostics(empty)).rejects.toThrow(/fallbacks/u);

    // A misspelled key inside a fallback is the same silent no-op the strict
    // schema exists to refuse, one level down.
    const typo = await homeWith({
      provider: {
        baseURL: 'https://example.test/v1',
        apiKey: 'k',
        fallbacks: [{ baseURL: 'https://backup.test/v1', apiKey: 'k2', model_id: 'm' }],
      },
    });
    await expect(loadConfigWithDiagnostics(typo)).rejects.toThrow(/model_id/u);
  });

  it('accepts a declared input-modality list, and refuses an empty one', async () => {
    // This is the operator's word against a gateway the automatic metadata
    // cannot resolve. `["text"]` is a real deployment saying "do not send this
    // model pictures" — the one statement no download can make for it.
    const home = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm', inputModalities: ['text'] },
    });
    expect((await loadConfigWithDiagnostics(home)).config.provider?.inputModalities).toEqual(['text']);

    // An empty list is refused rather than read as "nothing declared": it is a
    // declaration with no content, and every reader would have to guess which
    // of the two it meant.
    const empty = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm', inputModalities: [] },
    });
    await expect(loadConfigWithDiagnostics(empty)).rejects.toThrow(/inputModalities/u);

    const typo = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm', inputModality: ['text'] },
    });
    await expect(loadConfigWithDiagnostics(typo)).rejects.toThrow(/inputModality/u);
  });

  it('accepts a per-model price table, and refuses a typo inside a price', async () => {
    const home = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm' },
      pricing: { m: { input: 0.5, output: 1.5 }, 'cheap-model': { input: 0 } },
    });
    const { config } = await loadConfigWithDiagnostics(home);
    // `input: 0` must survive as a PRICE of zero rather than be dropped: a model
    // that really is free is a different fact from one nobody priced.
    expect(config.pricing).toEqual({ m: { input: 0.5, output: 1.5 }, 'cheap-model': { input: 0 } });

    const typo = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm' },
      pricing: { m: { inputPrice: 1 } },
    });
    await expect(loadConfigWithDiagnostics(typo)).rejects.toThrow(/inputPrice/u);

    const negative = await homeWith({
      provider: { baseURL: 'https://example.test/v1', apiKey: 'k', model: 'm' },
      pricing: { m: { input: -1 } },
    });
    await expect(loadConfigWithDiagnostics(negative)).rejects.toThrow(/pricing/u);
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

describe('config migration', () => {
  it('rewrites a legacy approval tier to auto, and says so', async () => {
    const home = await homeWith({ approval: 'read-only' });
    const { config, warnings } = await loadConfigWithDiagnostics(home);
    expect(config.approval).toBe('auto');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('read-only');
  });

  it('drops the channel row keys removed with the pairing flow', async () => {
    const home = await homeWith({
      plugins: {
        entries: [
          { id: '@noa/channel-qq', config: { appId: '1', owners: ['U1'], maxTier: 'read-only', pairingCode: 'ABC' } },
        ],
      },
    });
    const { config, warnings } = await loadConfigWithDiagnostics(home);
    const row = config.plugins?.entries?.[0];
    expect(row?.config).toEqual({ appId: '1' });
    // One note per dropped key, so a hand-edited file explains itself.
    expect(warnings).toHaveLength(3);
  });

  it('leaves a current document alone (no warnings, no rewriting)', async () => {
    const home = await homeWith({
      approval: 'full',
      plugins: { entries: [{ id: '@noa/channel-qq', config: { appId: '1' } }] },
    });
    const { config, warnings } = await loadConfigWithDiagnostics(home);
    expect(config.approval).toBe('full');
    expect(warnings).toEqual([]);
  });
});

describe('healConfigFile', () => {
  const fileOf = (home: string): string => path.join(home, '.noa', 'config.json');

  it('rewrites a legacy file so the notes are a one-time report', async () => {
    const home = await homeWith({
      approval: 'read-only',
      plugins: { entries: [{ id: '@noa/channel-qq', config: { appId: '1', owners: ['U1'] } }] },
    });
    const notes = await healConfigFile(home);
    expect(notes).toHaveLength(2);

    // On disk now, not just in the loaded view: the next start has nothing to say.
    const onDisk = JSON.parse(await readFile(fileOf(home), 'utf8')) as Record<string, unknown>;
    expect(onDisk['approval']).toBe('auto');
    expect(onDisk['plugins']).toEqual({ entries: [{ id: '@noa/channel-qq', config: { appId: '1' } }] });
    expect(await healConfigFile(home)).toEqual([]);
    const { warnings } = await loadConfigWithDiagnostics(home);
    expect(warnings).toEqual([]);
  });

  it('does not touch a file that is already current', async () => {
    // Byte-for-byte: a boot must not reformat a config it has nothing to fix, or
    // an operator's hand-kept layout would be rewritten on every start.
    const home = await homeWith('{\n  "approval": "full"\n}\n');
    expect(await healConfigFile(home)).toEqual([]);
    expect(await readFile(fileOf(home), 'utf8')).toBe('{\n  "approval": "full"\n}\n');
  });

  it('does not invent a file that is absent', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'noa-cfg-'));
    expect(await healConfigFile(home)).toEqual([]);
    await expect(readFile(fileOf(home), 'utf8')).rejects.toThrow();
  });
});

describe('persisting the default model', () => {
  const fileOf = (home: string): string => path.join(home, '.noa', 'config.json');

  it('patches provider.model and leaves every other byte alone', async () => {
    // 逐键写是这条的全部要点：操作者手写的 `{env:…}` 引用、兄弟字段、甚至他挑的缩进，
    // 都不能因为「换个默认模型」而被重排。Hermes 用 round-trip YAML 保住注释
    // （`utils.py:461`），这里用 raw 文档改写达到同一个目标。
    const home = await homeWith({
      provider: { baseURL: 'https://api.example.com/v1', apiKey: '{env:MY_KEY}', model: 'old-model', fallbacks: [{ baseURL: 'https://b.example.com/v1', apiKey: '{env:B_KEY}' }] },
      approval: 'auto',
    });
    await setDefaultModel('new-model', home);

    const doc = JSON.parse(await readFile(fileOf(home), 'utf8')) as Record<string, never>;
    const provider = (doc as unknown as { provider: Record<string, unknown> }).provider;
    expect(provider['model']).toBe('new-model');
    expect(provider['apiKey']).toBe('{env:MY_KEY}');
    expect(provider['baseURL']).toBe('https://api.example.com/v1');
    expect(provider['fallbacks']).toEqual([{ baseURL: 'https://b.example.com/v1', apiKey: '{env:B_KEY}' }]);
    expect((doc as unknown as { approval: string }).approval).toBe('auto');
  });

  it('reads back what it wrote, and reports nothing before anything is written', async () => {
    const home = await homeWith({ provider: { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'first' } });
    expect(await readDefaultModel(home)).toBe('first');
    await setDefaultModel('second', home);
    expect(await readDefaultModel(home)).toBe('second');
    // 没有 provider 段就没有默认模型可报 —— 而不是编一个。
    const bare = await homeWith({ approval: 'auto' });
    expect(await readDefaultModel(bare)).toBeUndefined();
  });

  it('refuses to write into a config with no provider section, by name', async () => {
    // 凭空造一个 provider 段会把「这个部署没有端点」写成一个看起来正常的默认模型。
    const home = await homeWith({ approval: 'auto' });
    await expect(setDefaultModel('x', home)).rejects.toThrow(/provider/);
  });

  it('refuses a write whose RESULT would not load', async () => {
    // 只改一个键，但改完的文档要能通过同一套校验才准落盘。这条挡住的是「写回成功、
    // 下次启动却读不起来」——那比写不进去严重得多。这里缺的是 `apiKey`（schema 必填）。
    const home = await homeWith({ provider: { baseURL: 'https://api.example.com/v1', model: 'a' } });
    const before = await readFile(fileOf(home), 'utf8');
    await expect(setDefaultModel('b', home)).rejects.toThrow(/would not load/);
    // 被拒 = 文件一个字节都没动。
    expect(await readFile(fileOf(home), 'utf8')).toBe(before);
  });

  it('turns a write failure into a reason instead of throwing at the chat command', async () => {
    // 座位给的是句子：调用方是聊天指令，它必须能回一句人话，而不是抛出去。
    const bare = await homeWith({ approval: 'auto' });
    const port = modelDefaultsPort(bare);
    expect(await port.configured()).toBeUndefined();
    const refused = await port.setDefault('x');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('provider');

    const good = await homeWith({ provider: { baseURL: 'https://api.example.com/v1', apiKey: 'k', model: 'a' } });
    const okPort = modelDefaultsPort(good);
    expect(await okPort.configured()).toBe('a');
    expect(await okPort.setDefault('b')).toEqual({ ok: true });
    expect(await okPort.configured()).toBe('b');
  });
});
