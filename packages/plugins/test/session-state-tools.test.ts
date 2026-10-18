/**
 * Session-state tools must DECLARE themselves as such (`ownsSessionState`).
 *
 * The marker is what lets a nested ephemeral run (a subagent) exclude them by
 * flag instead of by name: a subagent has no board of its own, so a state tool
 * let through either writes the PARENT's state (emit inherited) or silently
 * pretends success (emit absent). The declaration is the tool's own duty —
 * `nestedToolset` never hard-codes names — so it is pinned here per tool: a
 * state tool that drops the marker re-opens the pollution path with no test
 * noticing.
 */
import { describe, expect, it } from 'vitest';
import { PluginHost, builtinPlugins } from '../src/index.js';
import { rowsOf } from './plugin-rows.js';

async function builtins(): Promise<Map<string, import('@noa/core').ToolDefinition>> {
  const host = new PluginHost('.');
  await host.sync(
    rowsOf(
      builtinPlugins({
        rootDir: () => host.rootDir,
        // The goal tools exist only when the assembly supplied the live-goal
        // reader (a kernel fact, not a tool option) — the same rule production
        // follows, so the test supplies a stand-in reader to get them loaded.
        goal: { current: () => null },
      }),
    ),
  );
  return new Map(host.tools.map((tool) => [tool.name, tool]));
}

describe('ownsSessionState declaration', () => {
  it('is declared by the todo board and the goal tools', async () => {
    const tools = await builtins();
    expect(tools.get('todo_write')?.ownsSessionState).toBe(true);
    expect(tools.get('create_goal')?.ownsSessionState).toBe(true);
    expect(tools.get('update_goal')?.ownsSessionState).toBe(true);
  });

  it('is NOT declared by stateless builtins', async () => {
    const tools = await builtins();
    for (const name of ['bash', 'read_file', 'list_dir', 'jobs']) {
      expect(tools.get(name)?.ownsSessionState ?? false).toBe(false);
    }
  });
});
