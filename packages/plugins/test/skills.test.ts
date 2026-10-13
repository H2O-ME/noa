import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatProvider, StreamEvent } from '@noa/core';
import { agentsSkillsRoot } from '@noa/core';
import { createAgentKernel, PluginHost, loadSkills, parseSkillFrontmatter, readSkillBody, skillsPlugin } from '../src/index.js';
import { rowsOf } from './plugin-rows.js';

async function writeSkill(root: string, name: string, content: string): Promise<void> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
}

/** Write one flat `<name>.md` skill directly into a root. */
async function writeFlatSkill(root: string, fileName: string, content: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, fileName), content, 'utf8');
}

/** A provider that answers one short text; no network. */
function provider(): ChatProvider {
  return {
    async *stream() {
      yield { type: 'text_delta', text: 'ok' } satisfies StreamEvent;
    },
  };
}

/**
 * Run a body under a throwaway home, so the user-level `.agents`/`.nova` roots
 * land inside it. The redirection is ASSERTED rather than assumed: the whole
 * point of these tests is that the standard home is read, and a test that
 * quietly resolved the developer's real `~/.agents` would prove nothing while
 * still passing.
 */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), 'nova-agents-home-'));
  const prevProfile = process.env['USERPROFILE'];
  const prevHome = process.env['HOME'];
  process.env['USERPROFILE'] = home;
  process.env['HOME'] = home;
  try {
    expect(home.startsWith(tmpdir())).toBe(true);
    expect(agentsSkillsRoot()).toBe(path.join(home, '.agents', 'skills'));
    return await fn(home);
  } finally {
    if (prevProfile === undefined) delete process.env['USERPROFILE'];
    else process.env['USERPROFILE'] = prevProfile;
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
  }
}

/** Assemble a real kernel over `rootDir`; no config persister is needed here. */
async function kernelFor(rootDir: string): Promise<Awaited<ReturnType<typeof createAgentKernel>>> {
  return createAgentKernel({
    rootDir,
    provider: provider(),
    config: { approval: 'read-only' },
    sessionDir: await mkdtemp(path.join(tmpdir(), 'nova-agents-s-')),
  });
}

describe('parseSkillFrontmatter', () => {
  it('extracts name, description and body, tolerating quotes', () => {
    const parsed = parseSkillFrontmatter(
      ['---', 'name: deploy-check', 'description: "Runs: release readiness checks"', '---', '', 'Step one.', 'Step two.'].join('\n'),
    );
    expect(parsed.name).toBe('deploy-check');
    expect(parsed.description).toBe('Runs: release readiness checks');
    expect(parsed.body).toBe('Step one.\nStep two.');
  });

  it('falls back to the directory name and treats files without frontmatter as plain body', () => {
    expect(parseSkillFrontmatter('Just instructions.').body).toBe('Just instructions.');
  });

  // The shape real `.agents` skills actually use: a wrapped description written as
  // a YAML block scalar. Reading `description: >-` as the literal `>-` is what a
  // naive `key: value` scan does, and it makes every such skill advertise its
  // description as ">-" in the index (observed on 8 of 12 skills in a real
  // ~/.agents/skills). Folded style joins lines with spaces; literal style keeps
  // newlines.
  it('reads a folded block scalar as one line, and a literal one with newlines', () => {
    const folded = parseSkillFrontmatter(
      ['---', 'name: makers-cli', 'description: >-', '  第一行说明。', '  第二行说明。', 'metadata:', '  author: edgeone', '---', 'BODY'].join('\n'),
    );
    expect(folded.description).toBe('第一行说明。 第二行说明。');
    expect(folded.name).toBe('makers-cli');
    expect(folded.body).toBe('BODY');

    const literal = parseSkillFrontmatter(
      ['---', 'name: x', 'description: |', '  第一行', '  第二行', '---', 'B'].join('\n'),
    );
    expect(literal.description).toBe('第一行\n第二行');
  });

  // An indented line is a CHILD of a key we do not read; it must not be mistaken
  // for a top-level `description`/`name` (which is how a nested `author: x` or a
  // second `name:` inside `metadata:` would hijack the index entry).
  it('ignores nested keys under other headers', () => {
    const parsed = parseSkillFrontmatter(
      ['---', 'name: top', 'metadata:', '  name: nested', '  description: nested desc', '---', 'B'].join('\n'),
    );
    expect(parsed.name).toBe('top');
    expect(parsed.description).toBeUndefined();
  });
});

describe('loadSkills', () => {
  it('collects skills, with project roots winning name conflicts over user roots', async () => {
    const project = await mkdtemp(path.join(tmpdir(), 'nova-skills-p-'));
    const user = await mkdtemp(path.join(tmpdir(), 'nova-skills-u-'));
    await writeSkill(project, 'alpha', '---\nname: alpha\ndescription: project alpha\n---\nPROJECT BODY');
    await writeSkill(project, 'beta', '---\nname: beta\ndescription: project beta\n---\nB');
    await writeSkill(user, 'alpha', '---\nname: alpha\ndescription: user alpha\n---\nUSER BODY');
    await writeSkill(user, 'gamma', 'not-a-frontmatter body');

    const skills = await loadSkills([
      { dir: project, level: 'project' },
      { dir: user, level: 'user' },
    ]);
    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta', 'gamma']);
    const alpha = skills.find((s) => s.name === 'alpha');
    expect(alpha?.description).toBe('project alpha');
    expect(alpha?.level).toBe('project');
    await expect(readSkillBody(alpha!)).resolves.toBe('PROJECT BODY');
    const gamma = skills.find((s) => s.name === 'gamma');
    expect(gamma?.description).toBe('');
  });

  it('ignores missing roots and directories without SKILL.md', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-skills-'));
    await mkdir(path.join(root, 'empty-dir'), { recursive: true });
    const skills = await loadSkills([
      { dir: path.join(root, 'does-not-exist'), level: 'project' },
      { dir: root, level: 'user' },
    ]);
    expect(skills).toEqual([]);
  });
});

describe('skillsPlugin', () => {
  it('registers a `skill` tool that loads bodies on demand', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-skills-'));
    await writeSkill(root, 'deploy-check', '---\nname: deploy-check\ndescription: checks\n---\n1. Run pnpm verify');
    const skills = await loadSkills([{ dir: root, level: 'project' }]);
    const host = new PluginHost(root);
    await host.sync(rowsOf([skillsPlugin(skills)]));

    expect(host.tools.map((t) => t.name)).toEqual(['skill']);
    expect(await host.permissionFor('skill')).toBe('read');
    const tool = host.tools[0]!;
    await expect(tool.execute({ name: 'deploy-check' }, { rootDir: root })).resolves.toBe('1. Run pnpm verify');
    await expect(tool.execute({ name: 'nope' }, { rootDir: root })).resolves.toContain('unknown skill "nope"');
    await expect(tool.execute({ name: 'nope' }, { rootDir: root })).resolves.toContain('deploy-check');
  });
});

describe('skills hardening', () => {
  it('parses frontmatter and body from a BOM-prefixed SKILL.md', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-skills-bom-'));
    await writeSkill(root, 'bommed', '\uFEFF---\nname: bommed\ndescription: has a BOM\n---\nBODY TEXT');
    const skills = await loadSkills([{ dir: root, level: 'project' }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('bommed');
    expect(skills[0]?.description).toBe('has a BOM');
    await expect(readSkillBody(skills[0]!)).resolves.toBe('BODY TEXT');
  });

  it('readSkillBody refuses a body over the byte cap instead of dumping it into context', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-skills-cap-'));
    const big = 'x'.repeat(256 * 1024 + 1);
    await writeSkill(root, 'huge', `---\nname: huge\ndescription: too big\n---\n${big}`);
    const skills = await loadSkills([{ dir: root, level: 'project' }]);
    const body = await readSkillBody(skills[0]!);
    expect(body).toContain('exceeds');
    expect(body.length).toBeLessThan(200);
  });
});

describe('flat `<name>.md` skills', () => {
  it('discovers a flat file and takes the name from frontmatter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-flat-'));
    await writeFlatSkill(root, 'file-name.md', '---\nname: front-name\ndescription: flat skill\n---\nFLAT BODY');
    const skills = await loadSkills([{ dir: root, level: 'project' }]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('front-name');
    expect(skills[0]?.description).toBe('flat skill');
    expect(skills[0]?.file).toBe(path.join(root, 'file-name.md'));
    await expect(readSkillBody(skills[0]!)).resolves.toBe('FLAT BODY');
  });

  it('falls back to the file name minus `.md` when frontmatter omits a name', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-flat-'));
    await writeFlatSkill(root, 'bare.md', 'Just instructions.');
    const skills = await loadSkills([{ dir: root, level: 'project' }]);
    expect(skills.map((s) => s.name)).toEqual(['bare']);
  });

  it('ignores non-markdown files and mixes flat files with directory packages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'nova-flat-'));
    await writeFlatSkill(root, 'notes.txt', '---\nname: notes\n---\nno');
    await writeFlatSkill(root, 'flat.md', '---\nname: flat\ndescription: f\n---\nF');
    await writeSkill(root, 'packaged', '---\nname: packaged\ndescription: p\n---\nP');
    const skills = await loadSkills([{ dir: root, level: 'project' }]);
    expect(skills.map((s) => s.name).sort()).toEqual(['flat', 'packaged']);
  });
});

describe('discovery roots (standard .agents first, the app home second)', () => {
  it('finds user-level skills in ~/.agents/skills', async () => {
    await withTempHome(async (home) => {
      await writeSkill(agentsSkillsRoot(), 'shared', '---\nname: shared\ndescription: from .agents\n---\nSHARED');
      const kernel = await kernelFor(await mkdtemp(path.join(tmpdir(), 'noa-ws-')));
      const shared = kernel.allSkills.find((s) => s.name === 'shared');
      expect(shared).toBeDefined();
      expect(shared?.level).toBe('user');
      // The path proves the root really was the standard home, not a stray dir.
      expect(shared?.file).toBe(path.join(home, '.agents', 'skills', 'shared', 'SKILL.md'));
    });
  });

  it('lets .agents win a name conflict against the app home at both levels', async () => {
    await withTempHome(async (home) => {
      const ws = await mkdtemp(path.join(tmpdir(), 'noa-ws-'));
      await writeSkill(path.join(home, '.agents', 'skills'), 'dup', '---\nname: dup\ndescription: agents user\n---\nA');
      await writeSkill(path.join(home, '.noa', 'skills'), 'dup', '---\nname: dup\ndescription: app user\n---\nN');
      await writeSkill(path.join(ws, '.agents', 'skills'), 'dup', '---\nname: dup\ndescription: agents project\n---\nP');
      await writeSkill(path.join(ws, '.noa', 'skills'), 'dup', '---\nname: dup\ndescription: app project\n---\nQ');
      const kernel = await kernelFor(ws);
      const dup = kernel.allSkills.filter((s) => s.name === 'dup');
      expect(dup).toHaveLength(1);
      expect(dup[0]?.description).toBe('agents project');
      expect(dup[0]?.level).toBe('project');
      expect(dup[0]?.file).toBe(path.join(ws, '.agents', 'skills', 'dup', 'SKILL.md'));
    });
  });

  it('keeps the app-home roots working when only they exist', async () => {
    await withTempHome(async (home) => {
      const ws = await mkdtemp(path.join(tmpdir(), 'noa-ws-'));
      await writeSkill(path.join(ws, '.noa', 'skills'), 'legacy', '---\nname: legacy\ndescription: app project\n---\nL');
      await writeSkill(path.join(home, '.noa', 'skills'), 'legacy-user', '---\nname: legacy-user\ndescription: app user\n---\nU');
      const kernel = await kernelFor(ws);
      expect(kernel.allSkills.map((s) => s.name).sort()).toEqual(['legacy', 'legacy-user']);
      expect(kernel.allSkills.find((s) => s.name === 'legacy')?.level).toBe('project');
      expect(kernel.allSkills.find((s) => s.name === 'legacy-user')?.level).toBe('user');
    });
  });

  it('skips absent roots silently instead of throwing', async () => {
    await withTempHome(async () => {
      // No `.agents` and no app home anywhere: discovery must answer with an
      // empty list, not an error, because both levels are optional.
      const ws = await mkdtemp(path.join(tmpdir(), 'noa-ws-'));
      const kernel = await kernelFor(ws);
      expect(kernel.allSkills).toEqual([]);
      await expect(kernel.setWorkspace(await mkdtemp(path.join(tmpdir(), 'noa-ws-')))).resolves.toEqual([]);
    });
  });

  it('picks up user-level flat files and reports them as system-level', async () => {
    await withTempHome(async (home) => {
      await writeFlatSkill(agentsSkillsRoot(), 'flat-user.md', '---\nname: flat-user\ndescription: d\n---\nB');
      const kernel = await kernelFor(await mkdtemp(path.join(tmpdir(), 'noa-ws-')));
      const row = kernel.allSkills.find((s) => s.name === 'flat-user');
      expect(row?.level).toBe('user');
      expect(row?.file).toBe(path.join(home, '.agents', 'skills', 'flat-user.md'));
    });
  });
});
