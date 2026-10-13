import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Generate a starter AGENTS.md at the workspace root (the /init command).
 *
 * Separate from the discovery chain on the read side: this writes a template,
 * `collectProjectDocs` reads operator-authored docs. They share only the file
 * name, and the template's content is not part of any budget.
 * @param root - the workspace root to seed.
 * @returns the absolute path written.
 */
export async function writeAgentsMd(root: string): Promise<string> {
  const file = path.join(root, 'AGENTS.md');
  const parts: string[] = ['# AGENTS.md', '', 'Instructions for Nova agents working in this workspace.', '', '## Workspace'];
  try {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (pkg.name) parts.push(`- package: ${pkg.name}`);
    if (pkg.scripts) {
      parts.push('- scripts:');
      for (const [name, script] of Object.entries(pkg.scripts)) {
        parts.push(`  - \`${name}\`: \`${script}\``);
      }
    }
  } catch {
    parts.push('- no package.json at the workspace root');
  }
  await writeFile(file, `${parts.join('\n')}\n`, 'utf8');
  return file;
}
