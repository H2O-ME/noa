/**
 * The tool and command registries, as container services.
 *
 * This is what a plugin registers *into*, and what the loop, the surfaces and
 * the approval gate read *from* — so it is the busiest seam in the system. It
 * owns only the registry semantics (uniqueness, ownership, live views); what a
 * tool *does* stays in the plugin that registered it.
 *
 * Ownership is read from the registering plugin's own fiber — the `Context` a
 * plugin body receives carries that fiber, so `ctx.fiber.name` IS the plugin's
 * name. It used to be threaded in by a loading adapter, which meant a plugin
 * loaded by any other route registered its tools under `'assembly'`.
 */
import type { Context, Plugin, ToolDefinition } from '@noa/core';
import {
  commands as commandsKey,
  tools as toolsKey,
  type CommandEntry,
  type CommandRegistry,
  type ToolEntry,
  type ToolRegistry,
} from '@noa/core';

export const toolboxPlugin: Plugin = {
  name: 'toolbox',
  manifest: { title: '工具注册表', description: '宿主工具注册表的唯一持有者；一切工具都注册在它上面。', tier: 'core' },
  apply: (ctx: Context): void => {
    const entries: ToolEntry[] = [];
    let snapshot: ToolDefinition[] | undefined;

    const registry: ToolRegistry = {
      all: () => {
        // Stable reference while the registry is unchanged: the loop asks every
        // turn, and the ai client keys its wire cache on array identity.
        snapshot ??= entries.map((entry) => entry.tool);
        return snapshot;
      },
      entries: () => entries,
      find: (name) => entries.find((entry) => entry.tool.name === name)?.tool,
      permissionFor: async (name, args) => {
        const entry = entries.find((item) => item.tool.name === name);
        if (entry === undefined) return undefined;
        if (args === undefined || entry.tool.permissionFor === undefined) return entry.permission;
        try {
          return await entry.tool.permissionFor(args);
        } catch {
          // Fail closed: a broken classifier must not fall back to the static
          // kind (often `read`), which would auto-allow under read-only.
          return 'execute';
        }
      },
      register: (tool, options) => {
        const owner = options?.owner ?? 'assembly';
        if (entries.some((entry) => entry.tool.name === tool.name)) {
          throw new Error(`duplicate tool name "${tool.name}" (plugin "${owner}")`);
        }
        const entry: ToolEntry = { plugin: owner, tool, permission: options?.permission ?? 'read' };
        entries.push(entry);
        snapshot = undefined;
        return () => {
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
          snapshot = undefined;
        };
      },
    };

    const commands: CommandEntry[] = [];
    const commandRegistry: CommandRegistry = {
      all: () => commands.map((entry) => entry.command),
      entries: () => commands,
      register: (command) => {
        if (commands.some((entry) => entry.command.name === command.name)) {
          throw new Error(`duplicate command "/${command.name}"`);
        }
        const entry: CommandEntry = { plugin: ctx.fiber?.name ?? 'assembly', command };
        commands.push(entry);
        return () => {
          const index = commands.indexOf(entry);
          if (index >= 0) commands.splice(index, 1);
        };
      },
    };

    ctx.provide(toolsKey, registry);
    ctx.provide(commandsKey, commandRegistry);
  },
};

/**
 * The registration idiom now lives in CORE (`core/src/plugin/registration.ts`),
 * next to the keys it registers into. It moved so an extension plugin package
 * can depend on `core` ALONE — importing these helpers from this package would
 * have made the kernel frame and its own extension packages a dependency cycle.
 * Re-exported here so `@noa/plugins`'s public API is unchanged.
 */
export { registerCommand, registerTool } from '@noa/core';
