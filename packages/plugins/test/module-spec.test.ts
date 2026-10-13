/**
 * The resolution rule for `plugins.extra` / `surfaces` rows — one config string,
 * one meaning. The user plugin root (`~/.noa/plugins/`) is the part that needs
 * pinning: it must be reachable (a user can install into it) and it must never
 * shadow something the product already ships (an upgrade silently undone by a
 * stale copy is the failure that rule exists to prevent).
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { userPluginsDir } from '@noa/core';
import { createAgentKernel } from '../src/index.js';
import { resolvableFromProduct, resolveModuleSpec } from '../src/module-spec.js';

let home: string;

/** A package installed in the user plugin root, with the given export map. */
async function installFake(name: string, exportsMap: unknown): Promise<string> {
  const dir = path.join(userPluginsDir(home), 'node_modules', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', exports: exportsMap }));
  await writeFile(path.join(dir, 'index.mjs'), 'export default { name: "fake", apply: () => {} };\n');
  return dir;
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'nova-module-spec-'));
});

describe('resolveModuleSpec', () => {
  it('resolves a path against the working directory', () => {
    expect(resolveModuleSpec('./my-plugin.mjs', '/w')).toBe(pathToFileURL(path.join('/w', 'my-plugin.mjs')).href);
    expect(resolveModuleSpec('/abs/plugin.mjs', '/w').startsWith('file://')).toBe(true);
  });

  it('returns the PROVEN file for a product-resolvable name', () => {
    // `@noa/core` is a dependency of this package: the product resolves it,
    // so the user root is not consulted at all. The file URL, not the bare spec —
    // a loader that patches only CJS resolution (tsx) can make require.resolve
    // succeed where the ESM import of the bare spec then fails.
    expect(resolveModuleSpec('@noa/core', '/w', home)).toBe(
      pathToFileURL(createRequire(import.meta.url).resolve('@noa/core')).href,
    );
  });

  it('does NOT let the user root shadow a name the product can resolve', async () => {
    // The stale-copy trap: an old copy in the user root must not replace the
    // bundled package after an upgrade — the PRODUCT's file is what loads.
    await installFake('@noa/core', './index.mjs');
    expect(resolveModuleSpec('@noa/core', '/w', home)).toBe(
      pathToFileURL(createRequire(import.meta.url).resolve('@noa/core')).href,
    );
  });

  it('resolves a name that only exists in the user plugin root', async () => {
    const dir = await installFake('nova-fake-plugin', './index.mjs');
    expect(resolveModuleSpec('nova-fake-plugin', '/w', home)).toBe(pathToFileURL(path.join(dir, 'index.mjs')).href);
  });

  it('resolves a scoped name the same way', async () => {
    const dir = await installFake('@someone/nova-x', './index.mjs');
    expect(resolveModuleSpec('@someone/nova-x', '/w', home)).toBe(pathToFileURL(path.join(dir, 'index.mjs')).href);
  });

  it('falls back to the bare spec when the user-root package has no require/default arm', async () => {
    // An import-only export map: nothing here can name its entry, so the boot
    // error will name the config row instead of the product inventing a path.
    await installFake('nova-import-only', { '.': { import: './index.mjs' } });
    expect(resolveModuleSpec('nova-import-only', '/w', home)).toBe('nova-import-only');
  });

  it('leaves a name that exists nowhere alone', () => {
    expect(resolveModuleSpec('nova-not-installed-anywhere', '/w', home)).toBe('nova-not-installed-anywhere');
  });
});

describe('resolvableFromProduct', () => {
  it('tells what ships with the product from what does not', () => {
    expect(resolvableFromProduct('@noa/core')).toBe(true);
    expect(resolvableFromProduct('nova-not-installed-anywhere')).toBe(false);
  });
});

describe('configured rows: the app anchor, and what a CLOSED row reports', () => {
  it('resolves app-only names through the anchor, and reads a row the operator closed as off', async () => {
    // A package that ships with the APPLICATION — a sibling of its executable,
    // which this library cannot resolve at all (the QQ channel package is a cli
    // dependency, not a plugins one; that mismatch is the defect pinned here).
    const app = await mkdtemp(path.join(tmpdir(), 'nova-app-modules-'));
    const pkg = path.join(app, 'node_modules', '@someone', 'nova-app-only');
    await mkdir(pkg, { recursive: true });
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: '@someone/nova-app-only', version: '1.0.0', type: 'module', exports: { '.': './index.mjs' } }),
    );
    await writeFile(path.join(pkg, 'index.mjs'), 'export default { name: "app", apply: () => {} };\n');
    const appModulesUrl = pathToFileURL(path.join(app, 'index.mjs')).href;

    expect(resolvableFromProduct('@someone/nova-app-only')).toBe(false);
    expect(resolvableFromProduct('@someone/nova-app-only', appModulesUrl)).toBe(true);
    // The answer is a CONCRETE target, not the bare spec: a bare spec would be
    // re-resolved from THIS package at import time and fail there.
    expect(resolveModuleSpec('@someone/nova-app-only', '/w', home, appModulesUrl))
      .toBe(pathToFileURL(path.join(pkg, 'index.mjs')).href);
    // No anchor = the previous behaviour, untouched (embedded kernels, tests).
    expect(resolveModuleSpec('@someone/nova-app-only', '/w', home)).toBe('@someone/nova-app-only');
    // The user root stays a FALLBACK: a copy installed there never beats the anchor.
    await installFake('@someone/nova-app-only', './index.mjs');
    expect(resolveModuleSpec('@someone/nova-app-only', '/w', home, appModulesUrl))
      .toBe(pathToFileURL(path.join(pkg, 'index.mjs')).href);

    // ---- the same row, as the roster REPORTS it ------------------------------
    // A row the operator closed is OFF, never `failed`: the panel's failed
    // treatment keys off that state, so a load failure on a row nobody wants
    // loaded must not paint it red. Opening the row is what makes the reason
    // matter — and there it must appear.
    const sessionDir = await mkdtemp(path.join(tmpdir(), 'nova-anchor-sessions-'));
    const missing = './no-such-plugin-anchor-7c1e.mjs';
    const provider = {
      async *stream() {
        yield { type: 'text_delta' as const, text: 'ok' };
      },
    };
    const boot = (enabled: boolean) => createAgentKernel({
      rootDir: app,
      sessionDir,
      provider,
      config: { approval: 'read-only', plugins: { entries: [{ id: missing, enabled }] } },
    });

    const off = await boot(false);
    const closedRow = off.roster().find((row) => row.name === missing);
    expect(closedRow, 'a closed row keeps its place on the panel').toBeDefined();
    expect(closedRow?.state).toBe('disabled');
    expect(closedRow?.error).toBeUndefined();
    await off.dispose();

    const on = await boot(true);
    const failedRow = on.roster().find((row) => row.name === missing);
    expect(failedRow?.state).toBe('failed');
    expect(failedRow?.error).toMatch(/cannot load plugin/u);
    await on.dispose();
  });
});
