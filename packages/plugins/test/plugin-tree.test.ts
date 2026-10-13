/**
 * Contract group 2 — PLUGIN DISCOVERY (`buildTree`), and group 5 — the boot
 * graph's `page` flag.
 *
 * Discovery is the step that decides which rows EXIST, and two of its rules are
 * promises the rest of the product leans on:
 *
 *  - **load order** is a contract, not an accident: capability providers head the
 *    tree (a consumer activated before its provider finds the service absent),
 *    then the in-process built-ins, then what the surface contributed, then the
 *    spec-loaded rows (shipped packages before the operator's own entries);
 *  - **a row that cannot be imported is a ROW, not a crash**: an unresolved spec
 *    becomes a visible row carrying `error`, so a typo'd `plugins.entries` line
 *    still boots the kernel and still says what is wrong. The same test pins the
 *    mirror side — nothing is thrown out of assembly.
 *
 * Group 5 is one line of projection with a long reach: `page: true` on the roster
 * is what draws a settings section, so it must come from the plugin's OWN
 * manifest and from nowhere else — a host-invented page would put a section in
 * the navigation that nobody answers.
 *
 * The last group turns to the roster PROJECTION itself (`describePlugins`) and to
 * the manifest a third-party JS plugin really writes: a declared manifest is
 * copied through VERBATIM, so none of its fields can be assumed present.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PluginManifest } from '@noa/core';
import { buildTree, createAgentKernel, type Plugin, type PluginEntryConfig, type PluginEntryOptions, type PluginRosterEntry } from '../src/index.js';

/**
 * The import FAILURE is the branch the last group below pins, and this build
 * ships WORKING copies of its own extension packages — so that failure cannot be
 * produced from the real tree without breaking a `dist`. The ONE resolution seam
 * is therefore bent, and only on demand: while `breakShipped.on` is true a
 * `@noa/plugin-*` specifier resolves to a module that does not exist. The
 * ids stay real, because the point is that a real `advanced` package's failure is
 * reported by its real tier; every other test in this file keeps exercising the
 * real rule (`on` is false unless that test turned it on).
 */
const breakShipped = vi.hoisted(() => ({ on: false }));
vi.mock('../src/module-spec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/module-spec.js')>();
  return {
    ...actual,
    resolveModuleSpec: (spec: string, cwd: string, homedir?: string, appModulesUrl?: string) =>
      breakShipped.on && spec.startsWith('@noa/plugin-')
        ? 'file:///nova-missing-plugin/index.mjs'
        : actual.resolveModuleSpec(spec, cwd, homedir, appModulesUrl),
  };
});

/** A provider stub: one short text, never a network call. */
const provider = {
  async *stream() {
    yield { type: 'text_delta' as const, text: 'ok' };
  },
};

/** A throwaway workspace + session bucket pair (assembly writes nothing here). */
async function dirs(): Promise<{ rootDir: string; sessionDir: string }> {
  return {
    rootDir: await mkdtemp(path.join(tmpdir(), 'noa-tree-')),
    sessionDir: await mkdtemp(path.join(tmpdir(), 'noa-tree-sessions-')),
  };
}

describe('buildTree · discovery', () => {
  it('places contributors in load order, provider rows first', async () => {
    const { rootDir, sessionDir } = await dirs();
    const probe: Plugin = {
      name: 'surface-probe',
      manifest: { title: '探针', description: 'a surface contribution', tier: 'standard' },
      apply: () => undefined,
    };
    const kernel = await createAgentKernel({
      rootDir,
      sessionDir,
      provider,
      config: { approval: 'read-only' },
      extraPlugins: [{ id: 'surface-probe', plugin: probe }],
    });
    const order = kernel.roster().map((row) => row.name);
    // Capability providers head the tree: a consumer must never activate before
    // the service it injects exists.
    expect(order.indexOf('execution-environment')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('execution-environment')).toBeLessThan(order.indexOf('fs-read'));
    // The surface's own contribution sits between the built-ins and the rows
    // that come from module specifiers.
    expect(order.indexOf('todo')).toBeLessThan(order.indexOf('surface-probe'));
    expect(order.indexOf('surface-probe')).toBeLessThan(order.indexOf('@noa/plugin-ptc'));
    // And the row really is the contribution we handed it.
    expect(kernel.roster().find((row) => row.name === 'surface-probe')?.title).toBe('探针');
    await kernel.dispose();
  });

  it('turns an unresolvable spec into a row with an error instead of throwing', async () => {
    const { rootDir, sessionDir } = await dirs();
    const entries: PluginEntryConfig[] = [{ id: './no-such-plugin-9f3a.mjs' }];
    // The BOOT must survive a typo'd entry: this is the whole reason a bad row is
    // data. If assembly threw here, one wrong character in the config file would
    // take the browser interface, the REPL and `exec` down together.
    const kernel = await createAgentKernel({
      rootDir,
      sessionDir,
      provider,
      config: { approval: 'read-only', plugins: { entries } },
    });
    const row = kernel.roster().find((candidate) => candidate.name === './no-such-plugin-9f3a.mjs');
    expect(row, 'the bad row must still be listed').toBeDefined();
    expect(row?.state).toBe('failed');
    expect(row?.enabled).toBe(false);
    expect(row?.error).toMatch(/cannot load plugin/u);
    // Nothing ran, and the healthy rows are unaffected.
    expect(kernel.roster().find((candidate) => candidate.name === 'todo')?.state).toBe('active');
    await kernel.dispose();
  });

  it('carries a row\'s switch into the loader\'s options, keeping the row', async () => {
    const { rootDir, sessionDir } = await dirs();
    const builtin: Plugin = { name: 'bash', apply: () => undefined };
    const at = (enabled: boolean) => ({
      rootDir,
      provider,
      sessionDir,
      config: { approval: 'read-only' as const, plugins: { entries: [{ id: 'bash', enabled }] } },
    });

    // Both halves of "off" at once: the row EXISTS (the panel and the ledger need
    // it) and it carries `disabled: true` for the loader (no fiber is created).
    const off = await buildTree([builtin], at(false).config.plugins.entries, at(false));
    // The in-process row comes FIRST — the shipped spec rows follow it.
    expect(off.map((row) => row.id)[0]).toBe('bash');
    const offRow = off.find((row) => row.id === 'bash');
    expect(offRow?.enabled).toBe(false);
    expect(offRow?.options.disabled).toBe(true);

    // An explicit `enabled: true` is the same field the other way round.
    const on = (await buildTree([builtin], at(true).config.plugins.entries, at(true))).find((row) => row.id === 'bash');
    expect(on?.enabled).toBe(true);
    expect(on?.options.disabled).toBe(false);
  });
});

/**
 * The roster ROW against a manifest that declares almost nothing — the shape a
 * third-party JS plugin really writes, since nothing on its side makes it fill in
 * `title` or `description` while `manifestOf` copies whatever it wrote through
 * verbatim.
 *
 * The projection used to read `.length` off `description` and take the declared
 * `string` on faith. One plugin without the field therefore threw out of
 * `roster()`, and because every reader goes through that one call, the whole
 * roster died with it: the terminal's failed-row report (`exec` / `repl`), the
 * browser's plugin panel, and `noa`'s four-cause refusal. The two fields
 * come out differently on purpose — a title is a slot every row fills, a
 * description is a supplement.
 */
describe('the roster row · a manifest that declares only a tier', () => {
  it('falls the title back to the row id and keeps `description` absent', async () => {
    const { rootDir, sessionDir } = await dirs();
    // Both casts are `unknown`-mediated on purpose. This object is what a JS
    // plugin hands the loader — no type checker ever sees it, and `tier` alone is
    // exactly the manifest a JS author writes. Claiming otherwise would need the
    // fields this test exists to prove are not required.
    const declared = { tier: 'standard' } as unknown as PluginManifest;
    const sparse: Plugin = {
      name: 'sparse-probe',
      manifest: declared,
      apply: () => undefined,
    };
    const kernel = await createAgentKernel({
      rootDir,
      sessionDir,
      provider,
      config: { approval: 'read-only' },
      extraPlugins: [{ id: 'sparse-probe', plugin: sparse }],
    });
    const row = kernel.roster().find((entry) => entry.name === 'sparse-probe');
    expect(row, 'a sparse manifest must not cost the row its place').toBeDefined();
    // A title is a slot every row fills, so a missing one falls back to the row
    // id — the same fallback `manifestOf` applies to a plugin with no manifest.
    expect(row?.title).toBe('sparse-probe');
    // A description is a supplement, so a missing one leaves the key ABSENT.
    // `'description' in row` is the only question that separates "absent" from
    // "present and `undefined`": `=== undefined` cannot tell them apart, and this
    // row's discipline is absence (the same one `clientBundle` follows).
    expect('description' in (row as PluginRosterEntry), 'the row must not carry a `description` key').toBe(false);
    await kernel.dispose();
  });
});

describe('the boot graph · settings pages', () => {
  it('reports `page` only for rows whose own manifest declares one', async () => {
    const { rootDir, sessionDir } = await dirs();
    const withPage: Plugin = {
      name: 'pages-probe',
      manifest: { title: '有页面', description: 'declares a settings page', tier: 'standard', page: true },
      apply: () => undefined,
    };
    const withoutPage: Plugin = {
      name: 'no-page-probe',
      manifest: { title: '无页面', description: 'declares no settings page', tier: 'standard' },
      apply: () => undefined,
    };
    const extraPlugins: readonly PluginEntryOptions[] = [
      { id: 'pages-probe', plugin: withPage },
      { id: 'no-page-probe', plugin: withoutPage },
    ];
    const kernel = await createAgentKernel({
      rootDir,
      sessionDir,
      provider,
      config: { approval: 'read-only' },
      extraPlugins,
    });

    expect(kernel.roster().find((row) => row.name === 'pages-probe')?.page).toBe(true);
    // Declaring the manifest without the field is NOT a page: the navigation is
    // drawn from exactly these rows, and a section nobody answers is worse than
    // no section.
    expect(kernel.roster().find((row) => row.name === 'no-page-probe')?.page).toBeUndefined();
    expect(kernel.roster().find((row) => row.name === 'todo')?.page).toBeUndefined();
    // Scoped to the rows THIS test built — deliberately NOT "the whole roster
    // holds exactly one page". That universal claim is a fact about the WORLD,
    // and a fixture cannot know it: it stayed green only while NO real plugin
    // declared a page, and it went red the moment one did. What this test can
    // prove is the projection's faithfulness on the inputs it constructed, so
    // the inputs (the ids it handed to `extraPlugins`) are what it asserts over.
    const built = new Set(extraPlugins.map((entry) => entry.id));
    const invented = kernel.roster().filter((row) => built.has(row.name) && row.page === true).map((row) => row.name);
    expect(invented).toEqual(['pages-probe']);
    // Whether anybody REAL declares one is a different question, asked below by
    // interrogating the real rows instead of trusting a fixture.
    await kernel.dispose();
  });

  /**
   * The test above proves the projection is faithful — it copies a fixture's
   * `page` flag. It CANNOT prove that anybody declares one, and that is the
   * defect this second test exists for: the real page owners answered a `page`
   * operation while declaring nothing, so their settings sections were
   * unreachable in the real product while every fixture-based test stayed green.
   *
   * So the input here is the REAL roster, and "this plugin has a page" is
   * DERIVED — by asking each active row for one through the same port the
   * browser uses. No list of page owners is written down anywhere: the sweep
   * discovers them, then holds the roster's flag to what it just observed.
   */
  it('a real row that answers a page declares one — and vice versa', async () => {
    const { rootDir, sessionDir } = await dirs();
    const options = { rootDir, provider, sessionDir, config: { approval: 'read-only' as const } };
    // Every row the product really ships, switched ON. The ids come from the tree
    // itself (a first pass with no operator entries lists them), so this is the
    // whole shipped roster — not a hand-picked cast of page owners.
    const shipped = await buildTree([], [], options);
    const entries: PluginEntryConfig[] = shipped.map((row) => ({ id: row.id, enabled: true }));
    const kernel = await createAgentKernel({
      ...options,
      config: { approval: 'read-only', plugins: { entries } },
    });

    const rpc = kernel.pluginRpc();
    if (rpc === undefined) throw new Error('the kernel always provides the plugin-RPC port');

    const rows = kernel.roster();
    const answered: string[] = [];
    for (const row of rows) {
      // Only a live fiber owns a namespace: an off or failed row cannot answer,
      // and that is a different fact from "this row has no page".
      if (row.state !== 'active') continue;
      try {
        const descriptor = (await rpc.invoke(row.name, 'page', undefined)) as { title?: unknown };
        // An answer has to BE a page: resolving `page` with nothing would draw an
        // empty section, which is the same broken product as no section.
        expect(typeof descriptor?.title, `${row.name} answered \`page\` without a title`).toBe('string');
        answered.push(row.name);
      } catch (err) {
        // "I have no page" is exactly the two refusals the RPC port itself makes.
        // Anything else is a fault INSIDE a page implementation, and must not be
        // silently filed as "this row has no page".
        expect(err instanceof Error ? err.message : String(err), `${row.name} failed while answering \`page\``)
          .toMatch(/no loaded plugin answers|unknown operation/u);
      }
    }

    // The contract: the roster's `page` flag means "this row answers a page", and
    // the sweep above is that claim tested against the row's own behaviour.
    expect(rows.filter((row) => row.page === true).map((row) => row.name).sort()).toEqual(answered.sort());
    // Not vacuous: the shipped tree really does contain a page owner, found by
    // ASKING rather than by being told. If this ever empties, the assertion above
    // has degenerated into comparing two empty lists.
    expect(answered).toContain('@noa/plugin-ptc');
    await kernel.dispose();
  });
});

describe('buildTree · a row that is OFF is not a failure', () => {
  it('reports a load failure only for a row that is really open', async () => {
    const { rootDir, sessionDir } = await dirs();
    const options = (entries: PluginEntryConfig[]) => ({
      rootDir,
      provider,
      sessionDir,
      config: { approval: 'read-only' as const, plugins: { entries } },
    });
    const shipped = '@noa/plugin-ptc';
    const rowFor = async (entries: PluginEntryConfig[]) => {
      const rows = await buildTree([], entries, options(entries));
      const row = rows.find((candidate) => candidate.id === shipped);
      expect(row, 'a broken shipped row must still be listed').toBeDefined();
      return row;
    };
    // The module that would DECLARE the tier is exactly what failed, so the tier
    // is stated by the build itself (`failedRowTier`) — pinned here against what
    // the package really declares, so that copy cannot rot silently.
    const ptc = (await import('@noa/plugin-ptc')) as {
      default?: { manifest?: { tier?: string } };
      plugin?: { manifest?: { tier?: string } };
    };
    const declaredTier = (ptc.default ?? ptc.plugin)?.manifest?.tier;
    expect(declaredTier, 'the fixture id really is an `advanced` package').toBe('advanced');

    breakShipped.on = true;
    try {
      // ① No config row + `advanced` (default OFF): the operator never asked for
      //    this row, so it is CLOSED and its missing module is not news. It must
      //    also be drawn in its REAL tier — the hardcoded `standard` is what
      //    filed a failed `advanced` package under the wrong group.
      const neverOpened = await rowFor([]);
      expect(neverOpened?.error).toBeUndefined();
      expect(neverOpened?.manifest.tier).toBe(declaredTier);
      // ② The same id, explicitly closed — closed too, by the field they wrote.
      //    The tier is asserted HERE, on a row whose closedness holds under either
      //    rule, so this assertion kills the hardcoded `standard` on its own.
      const written = await rowFor([{ id: shipped, enabled: false }]);
      expect(written?.manifest.tier).toBe(declaredTier);
      expect(written?.error).toBeUndefined();
      // ③ Opened by the operator: now the row IS meant to load, so the reason has
      //    to come back where it can be acted on.
      expect((await rowFor([{ id: shipped, enabled: true }]))?.error).toMatch(/cannot load plugin/u);
    } finally {
      breakShipped.on = false;
    }

    // ④ A third-party spec has no manifest to consult and keeps the fail-open
    //    `standard` default — which is ON, so a failed third-party row the
    //    operator named still says why. Same rule, same branch, other tier.
    const local = './no-such-plugin-4b81.mjs';
    const localRow = (await buildTree([], [{ id: local }], options([{ id: local }])))
      .find((candidate) => candidate.id === local);
    expect(localRow?.manifest.tier).toBe('standard');
    expect(localRow?.error).toMatch(/cannot load plugin/u);
  });
});

/**
 * Contract group 6 — a CONTRIBUTOR's `disabled` is honoured, and the operator
 * outranks it.
 *
 * `PluginEntryOptions.disabled` is public (`core/plugin/loader.ts`) and means
 * exactly what it means for an operator's own row: the row STAYS (the panel must
 * be able to reopen it), no fiber is created and `apply` never runs. The tree
 * used to destructure the field and never read it, so a contribution that said
 * "do not activate this" activated anyway — a silent contract breach, and the
 * reason this group exists.
 *
 * The precedence is the second half, and it is the half a contributor could
 * otherwise abuse: `disabled` fills only the operator's SILENCE. A
 * `plugins.entries` row that says `enabled` decides, in both directions, because
 * the config document is the final intent — otherwise a contribution could pin a
 * feature against the operator. Under both sits the plugin's own tier default.
 */
describe('buildTree · a contributor\'s `disabled` is a default, not a second switch', () => {
  /** A probe that records whether the loader ever ran its body. */
  function probe(ran: boolean[], tier: 'standard' | 'advanced' = 'standard'): Plugin {
    return {
      name: 'contrib-probe',
      manifest: { title: '贡献探针', description: 'a contributed row', tier },
      apply: () => { ran.push(true); },
    };
  }

  /** `buildTree` for ONE contributed row, with the operator's rows as given. */
  function tree(entries: PluginEntryConfig[], contribution: PluginEntryOptions) {
    return buildTree([], entries, {
      rootDir: '.',
      provider,
      config: { approval: 'read-only' },
      extraPlugins: [contribution],
    });
  }

  it('keeps the row off without activating it, and lets the operator outrank it', async () => {
    // ① The operator never named the row, so the contributor is the only intent:
    //    `disabled: true` means OFF — listed, `disabled` on the loader's options.
    const off = await tree([], { id: 'contrib-probe', plugin: probe([]), disabled: true });
    const offRow = off.find((row) => row.id === 'contrib-probe');
    expect(offRow, 'a switched-off contributed row must still be listed').toBeDefined();
    expect(offRow?.enabled).toBe(false);
    expect(offRow?.options.disabled).toBe(true);

    // ② The operator wrote `enabled: true` on the same id: the config document is
    //    the final intent, so the contribution cannot hold the row down.
    const on = await tree([{ id: 'contrib-probe', enabled: true }], {
      id: 'contrib-probe',
      plugin: probe([]),
      disabled: true,
    });
    expect(on.find((row) => row.id === 'contrib-probe')?.enabled).toBe(true);
    expect(on.find((row) => row.id === 'contrib-probe')?.options.disabled).toBe(false);

    // ③ The same field the other way: an operator row that says `enabled: false`
    //    closes a row the contributor left alone.
    const closed = await tree([{ id: 'contrib-probe', enabled: false }], { id: 'contrib-probe', plugin: probe([]) });
    expect(closed.find((row) => row.id === 'contrib-probe')?.enabled).toBe(false);

    // ④ Under BOTH sits the plugin's own tier default, so a contributor asking
    //    for an `advanced` row beats a tier that ships OFF (the operator is
    //    silent, and their silence is what `disabled` is allowed to fill).
    const advanced = await tree([], { id: 'contrib-probe', plugin: probe([], 'advanced'), disabled: false });
    expect(advanced.find((row) => row.id === 'contrib-probe')?.enabled).toBe(true);
    // ⑤ …and leaving it silent there falls back to that tier default: OFF.
    const advancedIdle = await tree([], { id: 'contrib-probe', plugin: probe([], 'advanced') });
    expect(advancedIdle.find((row) => row.id === 'contrib-probe')?.enabled).toBe(false);
  });

  it('really starts nothing for a switched-off contribution', async () => {
    // The tree's `enabled` flag is only a promise until the LOADER acts on it:
    // this is the end-to-end half — no fiber, no `apply`, and the row survives so
    // the panel can switch it back on.
    const { rootDir, sessionDir } = await dirs();
    const offRan: boolean[] = [];
    const off = await createAgentKernel({
      rootDir,
      sessionDir,
      provider,
      config: { approval: 'read-only' },
      extraPlugins: [{ id: 'contrib-probe', plugin: probe(offRan), disabled: true }],
    });
    const offRow = off.roster().find((row) => row.name === 'contrib-probe');
    expect(offRow, 'the row must stay on the panel').toBeDefined();
    expect(offRow?.state).toBe('disabled');
    expect(offRow?.enabled).toBe(false);
    expect(offRan, 'a switched-off row must never run its body').toEqual([]);
    await off.dispose();

    // The mirror: the operator opening it is what makes it run.
    const onRan: boolean[] = [];
    const on = await createAgentKernel({
      rootDir,
      sessionDir,
      provider,
      config: { approval: 'read-only', plugins: { entries: [{ id: 'contrib-probe', enabled: true }] } },
      extraPlugins: [{ id: 'contrib-probe', plugin: probe(onRan), disabled: true }],
    });
    expect(on.roster().find((row) => row.name === 'contrib-probe')?.state).toBe('active');
    expect(onRan).toEqual([true]);
    await on.dispose();
  });

  it('refuses a contributed row with no plugin BY NAME instead of dropping it', async () => {
    // A row that carries neither a plugin nor a group used to be the only shape
    // thrown for. A `group: true` row — the subtree a surface would bring — passed
    // that check and then hit a bare `continue`: no row, no diagnostic, no reason.
    // The contract is now one rule for both: a contributed row must carry a plugin,
    // and anything else names its id on the way out.
    const contribution = { id: 'contrib-group', group: true, entries: [] } as unknown as PluginEntryOptions;
    await expect(buildTree([], [], { rootDir: '.', provider, config: { approval: 'read-only' }, extraPlugins: [contribution] }))
      .rejects.toThrow(/contrib-group/u);
    // …and the plain malformed row keeps its own named refusal, not a silent skip.
    const bare = { id: 'contrib-bare' } as unknown as PluginEntryOptions;
    await expect(buildTree([], [], { rootDir: '.', provider, config: { approval: 'read-only' }, extraPlugins: [bare] }))
      .rejects.toThrow(/contrib-bare/u);
  });
});
