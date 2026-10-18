/**
 * The surface-plugin loader + registry: this is the dynamic-registration seam
 * the cli consumes. A config `surfaces` row names a module; `loadSurfacePlugins`
 * imports it (default OR `surface` export), validates it is an `AgentSurface`,
 * and fails LOUDLY on a missing export or a broken module — the same discipline
 * `plugins.extra` already has, so a surface and a kernel plugin are loaded by
 * one rule, not two.
 *
 * Real `.mjs` files are written to a temp dir and imported, so this is the
 * end-to-end proof that adding a surface is a config row, not a source change.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSurface, AgentSurfaceFlags, AgentSurfaceRequest, ChatProvider } from '@noa/core';
import { createAgentKernel } from '../src/runtime.js';
import { createSurfaceRegistry, loadSurfacePlugins } from '../src/surface-registry.js';

function req(flags: Partial<AgentSurfaceFlags> = {}, interactive = true): AgentSurfaceRequest {
  return {
    rootDir: '/repo',
    argv: [],
    interactive,
    flags: {
      json: false,
      repl: false,
      web: false,
      positional: [],
      ...flags,
    },
  };
}

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nova-surface-'));
}

const VALID_DEFAULT = `export default {
  name: 'fake',
  interactive: true,
  answersQuestions: true,
  claim: () => false,
  start: async () => {},
};
`;

const VALID_NAMED = `export const surface = {
  name: 'named',
  claim: () => false,
  start: async () => {},
};
`;

const NO_EXPORT = `export const notASurface = {};
`;

const THROWS_ON_IMPORT = `throw new Error('boom on import');
`;

async function write(dir: string, name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, content, 'utf8');
  return file;
}

describe('loadSurfacePlugins', () => {
  it('loads a module whose default export is an AgentSurface', async () => {
    const d = await dir();
    const file = await write(d, 'valid.mjs', VALID_DEFAULT);
    const surfaces = await loadSurfacePlugins([file], d);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.name).toBe('fake');
    expect(surfaces[0]?.interactive).toBe(true);
    expect(surfaces[0]?.answersQuestions).toBe(true);
  });

  it('also accepts a named `surface` export', async () => {
    const d = await dir();
    const file = await write(d, 'named.mjs', VALID_NAMED);
    const surfaces = await loadSurfacePlugins([file], d);
    expect(surfaces[0]?.name).toBe('named');
  });

  it('fails loudly when a module exports no surface', async () => {
    const d = await dir();
    const file = await write(d, 'none.mjs', NO_EXPORT);
    await expect(loadSurfacePlugins([file], d)).rejects.toThrow(/does not export a surface/);
  });

  it('fails loudly naming the offending specifier when a module throws on import', async () => {
    const d = await dir();
    const file = await write(d, 'broken.mjs', THROWS_ON_IMPORT);
    await expect(loadSurfacePlugins([file], d)).rejects.toThrow(/cannot load/);
  });

  it('resolves a relative spec against the working directory', async () => {
    const d = await dir();
    await write(d, 'rel.mjs', VALID_DEFAULT);
    // A relative spec is resolved under cwd, exactly like `plugins.extra`.
    const surfaces = await loadSurfacePlugins(['./rel.mjs'], d);
    expect(surfaces[0]?.name).toBe('fake');
  });
});

describe('createSurfaceRegistry', () => {
  const neverClaims: AgentSurface = {
    name: 'never',
    claim: () => false,
    start: async () => {},
  };

  it('resolve returns the first surface whose claim is true, in register order', () => {
    const registry = createSurfaceRegistry();
    const a: AgentSurface = { name: 'a', claim: (r) => r.flags.repl, start: async () => {} };
    const b: AgentSurface = { name: 'b', claim: (r) => r.flags.web, start: async () => {} };
    registry.register(a);
    registry.register(b);
    expect(registry.resolve(req({ repl: true }))?.name).toBe('a');
    expect(registry.resolve(req({ web: true }))?.name).toBe('b');
  });

  it('resolve returns undefined when no surface claims', () => {
    const registry = createSurfaceRegistry();
    registry.register(neverClaims);
    expect(registry.resolve(req())).toBeUndefined();
  });

  it('records the resolved winner, which current() hands to the userQuestions provider', () => {
    const registry = createSurfaceRegistry();
    registry.register(neverClaims);
    // Fail-closed before anything resolved: no answerer is claimed.
    expect(registry.current()).toBeUndefined();
    expect(registry.resolve(req())).toBeUndefined();
    expect(registry.current()).toBeUndefined();
    const yes: AgentSurface = { name: 'yes', claim: () => true, start: async () => {} };
    registry.register(yes);
    expect(registry.resolve(req())?.name).toBe('yes');
    // The recording is a side effect of resolving — the ONE fact
    // `runtime-env.ts`'s userQuestions provider reads per call.
    expect(registry.current()).toBe(yes);
  });

  it('all lists every registered surface', () => {
    const registry = createSurfaceRegistry();
    registry.register(neverClaims);
    expect(registry.all().map((s) => s.name)).toEqual(['never']);
  });

  it('unregister (the disposer) removes only that surface', () => {
    const registry = createSurfaceRegistry();
    const dispose = registry.register(neverClaims);
    expect(registry.all()).toHaveLength(1);
    dispose();
    expect(registry.all()).toHaveLength(0);
  });
});

describe('configured surfaces as kernel plugin rows', () => {
  function provider(): ChatProvider {
    return {
      async *stream() {
        yield { type: 'text_delta', text: 'ok' } as const;
      },
    };
  }

  /**
   * The contract behind "a surface appears in `/plugins`": the caller hands the
   * assembly the surfaces it has ALREADY loaded (`loadSurfacePlugins`) plus the
   * shared registry, and the roster turns each into an ordinary plugin row with
   * origin `surface`. This used to be a dead seam — every assembly point forgot
   * to pass `opts.surfaces`, so a configured surface could never be listed or
   * switched — and the test below is what keeps the wiring honest.
   */
  it('passing surfaces makes each one a roster row and a registered service', async () => {
    const registry = createSurfaceRegistry();
    const custom: AgentSurface = {
      name: 'custom',
      interactive: true,
      answersQuestions: true,
      claim: () => true,
      start: async () => {},
    };
    registry.register(custom);
    const kernel = await createAgentKernel({
      rootDir: await dir(),
      sessionDir: await dir(),
      provider: provider(),
      config: { approval: 'auto' },
      surfaces: { registry, loaded: [custom] },
    });

    const row = kernel.roster().find((entry) => entry.name === 'custom');
    expect(row, 'configured surface should appear in the roster').toBeDefined();
    // `origin` answers "who shipped this row?", not "is it a surface": a
    // configured surface's row is built in-process alongside the other built-ins
    // (only the hosting surface's OWN contributed rows are labelled `surface`),
    // and the panel groups by TIER — see `web/ui/src/settings/row-model.ts`.
    expect(row?.enabled).toBe(true);
    expect(row?.state).toBe('active');

    // The surface's plugin row registers onto the SAME registry the resolver
    // reads: the `surfacePlugin` adapter's `apply` calls `service.register(surface)`
    // where service IS the passed-in registry — one instance, one identity.
    expect(registry.all().map((s) => s.name)).toContain('custom');

    await kernel.dispose();
  });
});
