import path from 'node:path';
import { stat, realpath } from 'node:fs/promises';
import type { Plugin, ToolExecuteContext } from '@noa/core';
import { tools as toolsKey } from '@noa/core';
import { registerTool } from '../toolbox.js';

/**
 * `switch_workspace` — the model's own way to move the working root when the
 * task crosses projects (the user says "现在去处理另一个仓库"). The plugin
 * itself never mutates state it cannot see: it resolves and validates the
 * target, then hands it to the runner-supplied `onChange`, which rebuilds the
 * plugin host (fs/bash/search roots), the skills list and the session env.
 * The new root applies from the NEXT tool dispatch onward — mid-batch calls
 * already preflighted on the old host keep their root.
 */

export interface WorkspacePluginOptions {
  /**
   * Runner callback that re-points the whole workspace-bound surface (tool
   * host roots, skills, env fragment cwd) at `dir`. The plugin validates the
   * directory first; the runner decides what a change costs (host rebuild).
   */
  onChange: (dir: string) => void | Promise<void>;
}

export function workspacePlugin(options: WorkspacePluginOptions): Plugin {
  return {
    name: 'workspace',
    description: 'Switch the workspace root the tools operate on.',
    manifest: { title: '切换工作区', description: '把工具的工作根切到另一个目录。', tier: 'standard' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(
        ctx,
        {
          name: 'switch_workspace',
          description:
            'Switch the workspace root for file/bash/search tools to another directory. ' +
            'Args: path (required) — absolute, or relative to the current root. ' +
            'Use this when the user asks to work on a different project or directory; ' +
            'the change applies from the next tool call and the next turn sees the new root.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Target directory (absolute or relative to the current root).' },
            },
            required: ['path'],
            additionalProperties: false,
          },
          async execute(args, c: ToolExecuteContext) {
            const raw = typeof args['path'] === 'string' ? args['path'] : '';
            if (raw.trim().length === 0) return 'Error: path must be a non-empty string';
            const resolved = path.resolve(c.rootDir, raw.trim());
            const real = await realpath(resolved).catch(() => undefined);
            if (real === undefined) return `Error: directory does not exist: ${raw}`;
            const info = await stat(real).catch(() => undefined);
            if (info === undefined || !info.isDirectory()) return `Error: not a directory: ${raw}`;
            if (real === c.rootDir) return `Already at workspace root: ${real}`;
            await options.onChange(real);
            return `Workspace switched to ${real}. File, bash and search tools now operate there; the next turn runs against the new root.`;
          },
        },
        // Moving the operating root is a user-visible change of scope — same
        // gate class as executing a command (asks in read-only/auto-edit).
        'execute',
      );
    },
  };
}
