/**
 * The settings panel's switches against a REAL kernel (`createAgentKernel`).
 *
 * A stub would assert the stub: the claims here are about the live container
 * agreeing with the durable CONFIG ROW — the one field (`plugins.entries`'
 * `enabled`) that both the boot path and the panel write, so a flip cannot
 * disagree with a restart. What is pinned:
 *
 *  - the roster lists rows from the plugin's OWN manifest, and a row that is
 *    off keeps its place there (so the page that turned it off can turn it back
 *    on) while its tools really are unregistered;
 *  - a `core` row refuses a switch outright — it is load-bearing;
 *  - a name that is in no row is refused rather than written as a dead entry;
 *  - ONE generic enable/disable round-trip through `setPluginEnabled`;
 *  - a DISABLED skill still appears in `allSkills`, for the same reason a plugin
 *    row does — the regression that made the Skill 中心's switch one-way.
 *
 * ONE test here is `.fails`: it is a tripwire for a defect still open in the
 * assembly (a switch writes the file but re-rosters from a stale config
 * snapshot). Its own comment carries the root cause; delete the marker when the
 * snapshot becomes live and the body will pass.
 *
 * Exactly one round-trip, not one per plugin: there is one field, one writer and
 * one reader, so a second copy would only be a second place to drift.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatProvider, StreamEvent } from '@noa/core';
import { createAgentKernel } from '../src/index.js';
import type { PluginEntryConfig } from '../src/index.js';

/** A provider that always answers with one short text; no network. */
function provider(): ChatProvider {
  return {
    async *stream() {
      yield { type: 'text_delta', text: 'ok' } satisfies StreamEvent;
    },
  };
}

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'nova-switch-'));
}

/** Write one skill under `<root>/name/SKILL.md`. */
async function writeSkill(root: string, name: string, description: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBODY`, 'utf8');
}

/**
 * Assemble a kernel over a config document, with a recording persister.
 *
 * `entries` IS the operator's `plugins.entries`: the same field both the boot
 * path and a flip read, so a test can start from a row the document had already
 * switched off.
 */
async function assemble(opts: {
  skills?: boolean;
  entries?: PluginEntryConfig[];
  skillsDisable?: string[];
} = {}): Promise<{
  kernel: Awaited<ReturnType<typeof createAgentKernel>>;
  /** The document as the persister left it — one record per write. */
  writes: { id: string; enabled: boolean | undefined }[];
}> {
  const root = await tmp();
  if (opts.skills === true) {
    await writeSkill(path.join(root, '.noa', 'skills'), 'alpha', 'first skill');
    await writeSkill(path.join(root, '.noa', 'skills'), 'beta', 'second skill');
  }
  const writes: { id: string; enabled: boolean | undefined }[] = [];
  const skillsOff: string[] = [];
  // The fake persister OWNS a document, exactly as the real one does: the writer
  // patches it and the live reader reads it back. A stub that only recorded the
  // write could not express the contract this file exists to pin — that a flip
  // reaches the live container — because there would be nothing to re-read.
  const document: PluginEntryConfig[] = [...(opts.entries ?? [])];
  const kernel = await createAgentKernel({
    rootDir: root,
    provider: provider(),
    config: {
      approval: 'read-only',
      ...(opts.entries !== undefined ? { plugins: { entries: opts.entries } } : {}),
      ...(opts.skillsDisable !== undefined ? { skillsDisable: opts.skillsDisable } : {}),
    },
    sessionDir: await tmp(),
    persist: {
      readPluginEntry: (id) => Promise.resolve(document.find((entry) => entry.id === id)),
      readPluginEntries: () => Promise.resolve([...document]),
      // The durable write, as the operator's config file receives it: the row's
      // `enabled` field, and nothing else.
      setPluginEntry: (id, patch) => {
        writes.push({ id, enabled: patch.enabled });
        const at = document.findIndex((entry) => entry.id === id);
        if (at < 0) document.push({ id, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) });
        else document[at] = { ...document[at], ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}) };
        return Promise.resolve();
      },
      setSkillEnabled: (name, enabled) => {
        const at = skillsOff.indexOf(name);
        if (enabled) {
          if (at >= 0) skillsOff.splice(at, 1);
        } else if (at < 0) skillsOff.push(name);
        return Promise.resolve([...skillsOff]);
      },
    },
  });
  return { kernel, writes };
}

describe('the roster the panel draws', () => {
  it('describes every known row from the plugin\'s own manifest', async () => {
    const { kernel } = await assemble();
    const rows = kernel.roster();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(['builtin', 'surface', 'extra', 'capability']).toContain(row.origin);
      expect(['core', 'standard', 'advanced']).toContain(row.tier);
      // Every row carries the words the panel draws — a row with no title is a
      // row the operator cannot identify.
      expect(row.title.length, `${row.name} title`).toBeGreaterThan(0);
    }
    // The tier contract, read off the plugins' own manifests: `core` and
    // `standard` ship on (a `core` row is not even switchable), `advanced` ships
    // off until its `plugins.entries` row asks for it.
    expect(kernel.roster().find((row) => row.name === 'fs-read')).toMatchObject({ tier: 'core', enabled: true });
    expect(kernel.roster().find((row) => row.name === 'bash')).toMatchObject({ tier: 'standard', enabled: true });
    expect(kernel.roster().find((row) => row.name === '@noa/plugin-ptc'))
      .toMatchObject({ tier: 'advanced', enabled: false });
  });

  it('keeps a DISABLED row on the roster, with its tools really unregistered', async () => {
    const { kernel } = await assemble({ entries: [{ id: 'todo', enabled: false }] });
    const off = kernel.roster().find((row) => row.name === 'todo');
    // The regression this pins: a disabled plugin leaves no fiber, so without the
    // manifest row it would vanish from the very panel that disables it.
    expect(off).toBeDefined();
    expect(off?.enabled).toBe(false);
    expect(off?.state).toBe('disabled');
    // And it is really gone from the live container — "off" means nothing ran.
    expect(kernel.host.tools.some((tool) => tool.name === 'todo_write')).toBe(false);
    expect(kernel.disabled.plugins).toContain('todo');
  });

  it('refuses a load-bearing plugin instead of taking the tool surface down', async () => {
    const { kernel, writes } = await assemble();
    // The tier comes from the plugin's OWN manifest; the panel draws no switch
    // for a `core` row in the first place.
    await expect(kernel.setPluginEnabled('fs-read', false)).rejects.toThrowError(/load-bearing/u);
    // Nothing was persisted for a refused flip: the file must not record a
    // switch the kernel declined to apply.
    expect(writes).toEqual([]);
  });

  it('refuses a name that is in no row, rather than writing a dead entry', async () => {
    const { kernel, writes } = await assemble();
    await expect(kernel.setPluginEnabled('not-a-plugin', false)).rejects.toThrowError(/unknown plugin/u);
    expect(writes).toEqual([]);
  });

  it('round-trips one plugin switch: the flip reaches the live container', async () => {
    // The ONE round-trip, both directions. It starts from a row the BOOT document
    // already switched off, which is the direction that stayed broken longest: the
    // roster used to be rebuilt from the assembly-time config snapshot, so a flip
    // wrote the file and then re-rostered the tree from BEFORE the flip.
    const { kernel, writes } = await assemble({ entries: [{ id: 'todo', enabled: false }] });
    expect(kernel.roster().find((row) => row.name === 'todo')?.enabled).toBe(false);
    // A `standard` row the document never mentioned still loads: "absent" reads
    // as the row's own tier default, not as off.
    expect(kernel.roster().find((row) => row.name === 'search')?.enabled).toBe(true);

    const back = await kernel.setPluginEnabled('todo', true);
    expect(back).not.toContain('todo');
    expect(kernel.roster().find((row) => row.name === 'todo')?.enabled).toBe(true);
    expect(kernel.host.tools.some((tool) => tool.name === 'todo_write')).toBe(true);

    // …and off again, so the round trip is closed in both directions.
    await kernel.setPluginEnabled('todo', false);
    const off = kernel.roster().find((row) => row.name === 'todo');
    expect(off?.enabled).toBe(false);
    expect(kernel.host.tools.some((tool) => tool.name === 'todo_write')).toBe(false);

    // Both writes went to the ONE field the boot path and the panel share.
    expect(writes).toEqual([
      { id: 'todo', enabled: true },
      { id: 'todo', enabled: false },
    ]);
  });
});

describe('skill switches', () => {
  it('keeps a DISABLED skill on the management list (allSkills)', async () => {
    const { kernel } = await assemble({ skills: true });
    expect(kernel.allSkills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
    await kernel.setSkillEnabled('alpha', false);
    // The filtered list — what the model sees — drops it.
    expect(kernel.skills.map((skill) => skill.name)).toEqual(['beta']);
    // The discovery list keeps it, which is the ONLY reason the panel can still
    // show the row that turns it back on. This is the regression: reading the
    // panel's rows from `skills` made the switch one-way.
    expect(kernel.allSkills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
    expect(kernel.disabled.skills).toContain('alpha');
  });

  it('turns a disabled skill back on and restores it to the model-visible list', async () => {
    const { kernel } = await assemble({ skills: true });
    await kernel.setSkillEnabled('alpha', false);
    const back = await kernel.setSkillEnabled('alpha', true);
    expect(back).not.toContain('alpha');
    expect(kernel.skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('refuses a skill name nothing discovers, instead of storing a dead entry', async () => {
    const { kernel } = await assemble({ skills: true });
    await expect(kernel.setSkillEnabled('ghost', false)).rejects.toThrowError(/unknown skill/u);
    // The index is left exactly as it was: the refusal path re-reads the
    // workspace, so a throw must not leave the filter half-applied.
    expect(kernel.allSkills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
    expect(kernel.skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('subtracts the boot-time skills.disable list from the start', async () => {
    const { kernel } = await assemble({ skills: true, skillsDisable: ['alpha'] });
    expect(kernel.skills.map((skill) => skill.name)).toEqual(['beta']);
    // Still discoverable, so the panel lists it as OFF rather than not at all.
    expect(kernel.allSkills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta']);
    expect(kernel.disabled.skills).toEqual(['alpha']);
  });
});
