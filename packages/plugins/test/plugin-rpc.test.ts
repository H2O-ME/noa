/**
 * Contract group 4 — GENERIC plugin RPC, and its error isolation.
 *
 * `pluginRpc` is the one frame family every plugin-owned page answers through
 * (`{ plugin, op, payload }` → `plugin_request` / `plugin_response`), so the host
 * never learns a plugin's operation names. What the host DOES depend on is that
 * both failure modes arrive as an ordinary refusal:
 *
 *  - an **unknown namespace** — the plugin is off, absent, or the browser is
 *    asking something nobody loaded answers. A switched-off plugin leaves no
 *    handler, so this is also how "off means silent" is enforced;
 *  - a **throwing handler** — the plugin's own operation failed, and the caller
 *    must get the reason rather than a broken socket.
 *
 * The wire half (`web/src/plugin-frames.ts`) turns a rejection into the refusal
 * frame; the seam is only as good as the rejection it receives, which is what is
 * pinned here.
 */
import { describe, expect, it } from 'vitest';
import { loader as loaderKey, pluginRpc as pluginRpcKey, type PluginLoader } from '@noa/core';
import { PluginHost, pluginRpcProvider } from '../src/index.js';

/** A host whose only row is the RPC provider itself. */
async function rpcHost(): Promise<PluginHost> {
  const host = new PluginHost('.');
  await host.sync([{ id: 'plugin-rpc', plugin: pluginRpcProvider() }]);
  return host;
}

describe('plugin RPC', () => {
  it('refuses an unknown namespace instead of answering for a plugin that is off', async () => {
    const host = await rpcHost();
    const rpc = host.context.must(pluginRpcKey);
    // Also the switched-off case: a plugin's handlers are disposed with its
    // fiber, so "is it enabled?" and "does it answer?" are the same question.
    await expect(rpc.invoke('nobody', 'page')).rejects.toThrowError(/no loaded plugin answers "nobody"/u);
    await host.dispose();
  });

  it('refuses with the handler\'s own reason, and keeps the namespace usable', async () => {
    const host = await rpcHost();
    const rpc = host.context.must(pluginRpcKey);
    rpc.register('probe', async (op) => {
      if (op === 'boom') throw new Error('probe handler exploded');
      return { op };
    });

    await expect(rpc.invoke('probe', 'boom')).rejects.toThrowError(/probe handler exploded/u);
    // A failed operation must not take the namespace with it: the page that asked
    // can still ask something else.
    expect(await rpc.invoke('probe', 'status')).toEqual({ op: 'status' });
    await host.dispose();
  });

  it('unregisters a namespace with the plugin that declared it', async () => {
    const host = await rpcHost();
    const loader = host.context.must<PluginLoader>(loaderKey);
    const rpc = host.context.must(pluginRpcKey);
    await loader.create({
      id: 'page-owner',
      plugin: {
        name: 'page-owner',
        apply: (ctx) => {
          ctx.effect(() =>
            ctx.must(pluginRpcKey).register('page-owner', async (op) => ({ op })),
          );
        },
      },
    });
    expect(await rpc.invoke('page-owner', 'page')).toEqual({ op: 'page' });

    // Removing the row is what "switched off" means, and the registry follows it
    // with no per-plugin teardown step to forget.
    await loader.remove('page-owner');
    await expect(rpc.invoke('page-owner', 'page')).rejects.toThrowError(/no loaded plugin answers/u);
    await host.dispose();
  });
});
