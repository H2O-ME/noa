import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { tools as toolsKey, type Plugin } from '@noa/core';
import { registerTool } from './toolbox.js';
import { parseSkillFrontmatter } from './skill-frontmatter.js';

/**
 * Skills (AGENTS.md §5): a tiny YAML frontmatter (name, description) in either
 * the directory-package form `<name>/SKILL.md` or the flat form `<name>.md`.
 * Only name+description load at startup; the body is read on demand, so the
 * system prompt never bloats. `runtime-env.ts` orders the roots, and
 * `skill-frontmatter.ts` owns the header grammar.
 */

export interface SkillRoot {
  dir: string;
  /** Earlier roots win name conflicts; pass project roots before user roots. */
  level: 'project' | 'user';
}

export interface SkillMetadata {
  name: string;
  description: string;
  /** Absolute path of the skill file (SKILL.md or a flat `<name>.md`). */
  file: string;
  level: 'project' | 'user';
}

/** Body cap: a skill is progressive-loading guidance, not a data dump. */
export const SKILL_BODY_MAX_BYTES = 256 * 1024;

/**
 * The frontmatter grammar lives in `skill-frontmatter.ts`; re-exported so callers
 * of this module (and its tests) need one import for the whole skill surface.
 */
export { parseSkillFrontmatter, type SkillFrontmatter } from './skill-frontmatter.js';

/**
 * Collect skills from the given roots (in order; first root listing a name
 * owns it). Roots that do not exist are skipped, so an optional user-level
 * directory costs nothing.
 *
 * Two entry shapes are recognized, matching the shared `.agents` convention:
 * a directory holding `SKILL.md`, and a flat `<name>.md`. A name falls back to
 * the frontmatter, then to the directory name / the file name minus `.md`.
 */
export async function loadSkills(roots: SkillRoot[]): Promise<SkillMetadata[]> {
  const byName = new Map<string, SkillMetadata>();
  for (const root of roots) {
    const entries = await readdir(root.dir, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) continue;
    // Sorted so a flat `foo.md` and a `foo/` package in the SAME root resolve
    // the same way on every run: readdir order is the filesystem's, not ours.
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const locator = locateSkillFile(root.dir, entry);
      if (locator === undefined) continue;
      const raw = await readFile(locator.file, 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      const parsed = parseSkillFrontmatter(raw);
      const name = parsed.name ?? locator.fallbackName;
      if (name.length === 0 || byName.has(name)) continue;
      byName.set(name, {
        name,
        description: parsed.description ?? '',
        file: locator.file,
        level: root.level,
      });
    }
  }
  return [...byName.values()];
}

/** The two recognized entry shapes; `undefined` for anything else. */
function locateSkillFile(rootDir: string, entry: Dirent): { file: string; fallbackName: string } | undefined {
  if (entry.isDirectory()) return { file: path.join(rootDir, entry.name, 'SKILL.md'), fallbackName: entry.name };
  if (!entry.isFile() || !entry.name.endsWith('.md')) return undefined;
  return { file: path.join(rootDir, entry.name), fallbackName: entry.name.slice(0, -'.md'.length) };
}

/** Full instructions of a skill: the skill file content minus frontmatter. */
export async function readSkillBody(skill: SkillMetadata): Promise<string> {
  const raw = await readFile(skill.file, 'utf8');
  const body = parseSkillFrontmatter(raw).body;
  // Hard cap on what enters the context: an oversized skill file is almost
  // certainly misplaced data, not instructions.
  if (Buffer.byteLength(body, 'utf8') > SKILL_BODY_MAX_BYTES) {
    return `Error: skill "${skill.name}" body exceeds ${SKILL_BODY_MAX_BYTES} bytes and was not loaded`;
  }
  return body;
}

/**
 * Registers the `skill` agent tool: the model can load a skill's full
 * instructions by name before following them (AGENTS.md §5).
 */
export function skillsPlugin(skills: SkillMetadata[]): Plugin {
  return {
    name: 'skill-tool',
    description: 'On-demand loading of project/user skills (SKILL.md instructions).',
    manifest: {
      title: '技能工具',
      description: '让模型按名加载技能的完整指令。技能索引不可用时整行不加载。',
      tier: 'core',
    },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(ctx, {
        name: 'skill',
        description:
          'Loads the full instructions of a skill by name. Available skills are listed in the <available_skills> block of the first user message; call this tool before following a skill. Args: name (required).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name, e.g. "deploy-check".' },
          },
          required: ['name'],
          additionalProperties: false,
        },
        async execute(args) {
          const name = typeof args['name'] === 'string' ? args['name'] : '';
          const skill = skills.find((s) => s.name === name);
          if (!skill) {
            const available = skills.map((s) => s.name).join(', ');
            return `Error: unknown skill "${name}"${available.length > 0 ? ` (available: ${available})` : ' (no skills installed)'}`;
          }
          return readSkillBody(skill);
        },
      }, 'read');
    },
  };
}
