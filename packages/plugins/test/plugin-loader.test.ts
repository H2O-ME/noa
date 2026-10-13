/**
 * Contract group 1 — LOADER SEMANTICS, as the plugin tree relies on them.
 *
 * `PluginLoader` (core) is the one thing that decides whether a row is on, and
 * it is the reason a re-roster is a diff rather than a rebuild. The claims worth
 * pinning are the ones a wrong implementation would silently break:
 *
 *  - `create` / `update` / `remove` / `reconcile` converge, and an UNCHANGED row
 *    keeps the same fiber and is NOT re-applied — otherwise every workspace
 *    switch would tear down and re-register every plugin (the rebuild-everything
 *    behaviour the entry tree exists to end);
 *  - a group's SUBTREE comes and goes with the group, and reconciling a group
 *    edits its children in place;
 *  - `isolate` forks ONE service name into the subtree's own provider without
 *    touching what anyone else reads;
 *  - `intercept` wraps a service for the scope that declared it;
 *  - **failure isolation**: one row whose body throws neither stops its sibling
 *    nor escapes the reconcile — the reason lands on that row's `error`.
 *
 * The last one is the contract the panel's whole "plugin errors are data" story
 * rests on, so it is asserted through the public door (`PluginHost.sync`, which
 * is `reconcile`) rather than by reaching into the loader.
 */
import { describe, expect, it } from 'vitest';
import { key, type Plugin, type PluginEntryOptions, type PluginLoader } from '@noa/core';
import { PluginHost, TOOLBOX_ENTRY_ID } from '../src/host.js';

/** A service key private to this file — nothing else in the product reads it. */
const svc = key<string>('loader-semantics-probe');

/** How many times each row's body actually ran (a re-apply is visible here). */
type Applies = { count: number };

/** A row that records its activation; it registers no service of its own. */
function marker(name: string, applies: Applies = { count: 0 }): Plugin {
  return {
    name,
    apply: () => {
      applies.count += 1;
    },
  };
}

/** A row that publishes `svc` under its own name. */
function provider(name: string, value: string): Plugin {
  return { name, apply: (ctx) => ctx.provide(svc, value) };
}

function loaderOf(host: PluginHost): PluginLoader {
  return host.context.must(key<PluginLoader>('loader'));
}

describe('the plugin loader', () => {
  it('converges through create, reconcile and remove, keeping unchanged rows', async () => {
    const host = new PluginHost('.');
    const loader = loaderOf(host);
    const applies: Applies = { count: 0 };
    const kept = marker('kept', applies);
    const dropped = marker('dropped');

    await loader.create({ id: 'kept', plugin: kept });
    await loader.create({ id: 'dropped', plugin: dropped });
    expect(loader.list().map((entry) => entry.id)).toEqual(['kept', 'dropped']);
    const fiberBefore = loader.get('kept')?.fiber;
    expect(fiberBefore).toBeDefined();
    expect(applies.count).toBe(1);

    // Converge on a tree that still holds `kept` and no longer holds `dropped`:
    // the kept row must be the SAME activation — same fiber, body NOT re-run.
    await loader.reconcile([{ id: 'kept', plugin: kept }]);
    expect(loader.list().map((entry) => entry.id)).toEqual(['kept']);
    expect(loader.get('kept')?.fiber).toBe(fiberBefore);
    expect(applies.count).toBe(1);

    // An edit IS a replacement, and it is visible through the same id.
    const edited = marker('kept', applies);
    await loader.update('kept', { plugin: edited });
    expect(loader.get('kept')?.plugin).toBe(edited);
    expect(applies.count).toBe(2);

    await loader.remove('kept');
    expect(loader.list()).toEqual([]);
    // Removing is idempotent: the loader is a diff engine, not a ledger.
    await loader.remove('kept');
    expect(loader.list()).toEqual([]);
  });

  it('treats an equal-content config as the SAME row, not an edit', async () => {
    // The shell that owns the config document re-reads it on every roster, so
    // two rosters in a row hand the loader equal content in fresh objects. Read
    // as an edit, that tore down and re-applied every configured row on every
    // workspace switch — the rebuild-everything behaviour this loader exists to
    // prevent. Config is DATA, so the comparison is by value; `plugin` and the
    // scope inputs are CODE and stay identity-compared.
    const host = new PluginHost('.');
    const applies: Applies = { count: 0 };
    const plugin = marker('configured', applies);
    const at = (config: unknown): PluginEntryOptions[] => [{ id: 'configured', plugin, config }];

    await host.sync(at({ timeoutMs: 1000, nested: { list: [1, 2] } }));
    const fiber = host.entry('configured')?.fiber;
    expect(fiber).toBeDefined();
    expect(applies.count).toBe(1);

    await host.sync(at({ timeoutMs: 1000, nested: { list: [1, 2] } }));
    expect(host.entry('configured')?.fiber).toBe(fiber);
    expect(applies.count).toBe(1);

    // A REAL change still replaces the row, in each direction that matters:
    // a changed leaf, and an added key.
    await host.sync(at({ timeoutMs: 2000, nested: { list: [1, 2] } }));
    expect(applies.count).toBe(2);
    await host.sync(at({ timeoutMs: 2000, nested: { list: [1, 2] }, added: true }));
    expect(applies.count).toBe(3);
    // …and a removed key, which is how "reset this setting to its default" reads.
    await host.sync(at({ timeoutMs: 2000, nested: { list: [1, 2] } }));
    expect(applies.count).toBe(4);
    // Key ORDER is not a change: the same document read twice must not reload.
    await host.sync(at({ nested: { list: [1, 2] }, timeoutMs: 2000 }));
    expect(applies.count).toBe(4);
  });

  it('brings a group\'s subtree with the group, and edits it in place', async () => {
    const host = new PluginHost('.');
    const loader = loaderOf(host);
    const group: PluginEntryOptions = {
      id: 'group',
      group: true,
      entries: [{ id: 'child', plugin: provider('child', 'from-child') }],
    };

    await loader.create(group);
    // Depth-first: the group's own row precedes its child, and both are listed.
    expect(loader.list().map((entry) => entry.id)).toEqual(['group', 'child']);
    expect(loader.get('child')?.parentId).toBe('group');
    expect(host.context.get(svc)).toBe('from-child');

    // Reconciling the group with a DIFFERENT child set is an in-place edit: the
    // group's own context survives, so whatever it provides is not rebuilt.
    const groupContext = loader.get('group')?.context;
    await loader.reconcile([{ ...group, entries: [{ id: 'other', plugin: marker('other') }] }]);
    expect(loader.list().map((entry) => entry.id)).toEqual(['group', 'other']);
    expect(loader.get('group')?.context).toBe(groupContext);
    // The child that left took its registration with it.
    expect(host.context.get(svc)).toBeUndefined();

    // Dropping the group takes the whole subtree.
    await loader.remove('group');
    expect(loader.list()).toEqual([]);
  });

  it('isolate forks one service name for the subtree only', async () => {
    const host = new PluginHost('.');
    const loader = loaderOf(host);

    await loader.create({ id: 'outer', plugin: provider('outer', 'outer-value') });
    const inner = { value: undefined as string | undefined };
    await loader.create({
      id: 'isolated',
      plugin: {
        name: 'isolated',
        apply: (ctx) => {
          ctx.provide(svc, 'inner-value');
          inner.value = ctx.must(svc);
        },
      },
      isolate: ['loader-semantics-probe'],
    });

    // Two providers, one NAME, no duplicate-provider error: the isolated row
    // registered under its own symbol — that fork IS the mechanism. Each side
    // reads its own value and cannot see the other's.
    expect(inner.value).toBe('inner-value');
    expect(host.context.must(svc)).toBe('outer-value');
    expect(loader.get('isolated')?.error).toBeUndefined();
  });

  it('intercept wraps a service for the scope that declared it', async () => {
    const host = new PluginHost('.');
    const loader = loaderOf(host);
    const seen = { value: undefined as string | undefined };

    await loader.create({ id: 'provider', plugin: provider('provider', 'raw') });
    await loader.create({
      id: 'wrapper',
      plugin: {
        name: 'wrapper',
        apply: (ctx) => {
          // Read through the interceptor this very row declared: the wrapping
          // scope sees the wrapper, everyone else sees the raw provider.
          seen.value = ctx.must(svc);
        },
      },
      intercept: { 'loader-semantics-probe': (inner) => `${String(inner)}!` },
    });

    expect(seen.value).toBe('raw!');
    expect(host.context.must(svc)).toBe('raw');
  });

  it('records a failing row WITHOUT failing its sibling or the reconcile', async () => {
    const host = new PluginHost('.');
    const boom: Plugin = {
      name: 'boom',
      apply: () => {
        throw new Error('row body exploded');
      },
    };
    const sound: Plugin = { name: 'sound', apply: () => undefined };

    // The public door: `sync` is `reconcile`, and it must RESOLVE. A loader that
    // rethrew a plugin's own failure would let one bad row take the process down.
    await expect(host.sync([{ id: 'boom', plugin: boom }, { id: 'sound', plugin: sound }])).resolves.toBeUndefined();

    const entries = loaderOf(host).list().filter((entry) => entry.id !== TOOLBOX_ENTRY_ID);
    // The failing row KEEPS its place — that is how the operator sees the reason.
    expect(entries.map((entry) => entry.id)).toEqual(['boom', 'sound']);
    expect(host.errorOf('boom')).toMatch(/row body exploded/u);
    // The sibling is untouched, which is the whole claim.
    expect(host.errorOf('sound')).toBeUndefined();
    expect(host.roster().find((entry) => entry.name === 'sound')?.state).toBe('active');
  });
});
