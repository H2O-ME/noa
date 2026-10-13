/**
 * The registration idiom for the two container-owned registries.
 *
 * These helpers live in core, next to the keys they register into (`tools`,
 * `commands`), for one concrete reason: an extension plugin package must be
 * able to depend on `core` ALONE. They use nothing but `Context` (`ctx.must` /
 * `ctx.effect` / `ctx.fiber`), and hosting them here is what lets the extension
 * packages avoid importing the plugins package — that edge would otherwise
 * make the kernel frame and its own extension packages a dependency cycle.
 */
import type { ToolDefinition, ToolPermissionKind } from '../types.js';
import { commands as commandsKey, tools as toolsKey } from './capabilities.js';
import type { CommandDefinition } from './capabilities.js';
import type { Context } from './context.js';

/**
 * Register one tool under the calling plugin's own name, with its undo tied to
 * that plugin's fiber.
 *
 * This is the ONE registration idiom for first-party tools — the same two lines
 * (`ctx.effect` + `registry.register`) every plugin would otherwise retype, and
 * therefore the same two lines that used to drift (some plugins passed `owner`,
 * some did not, and the loading adapter had to paper over it). A plugin that
 * registers a tool should also list `tools` in its `inject`, which is what makes
 * a replaced registry re-point it rather than strand it.
 * @param ctx - the registering plugin's context.
 * @param tool - the tool definition the model will see.
 * @param permission - highest-impact kind this tool needs; drives the approval gate.
 */
export function registerTool(ctx: Context, tool: ToolDefinition, permission: ToolPermissionKind): void {
  const registry = ctx.must(toolsKey);
  const owner = ctx.fiber?.name ?? 'assembly';
  ctx.effect(() => registry.register(tool, { permission, owner }), `tool(${tool.name})`);
}

/** Register one slash command, owned by the calling plugin's fiber. */
export function registerCommand(ctx: Context, command: CommandDefinition): void {
  const registry = ctx.must(commandsKey);
  ctx.effect(() => registry.register(command), `command(/${command.name})`);
}
