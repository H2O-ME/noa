/**
 * The two HOST capabilities that let an optional package be a normal plugin.
 *
 * These exist because the alternative was a host-side factory per package: the
 * roster used to construct `subagentPlugin(options)` and `ptcPlugin(options)`
 * itself, which meant the kernel knew every optional plugin by name and had to
 * be edited whenever one was added. A capability provider is the other way
 * round — the host publishes what any execution plugin needs, and the plugin
 * declares `inject` and reads it.
 */
import {
  executionEnvironment as executionEnvironmentKey,
  pluginConfig as pluginConfigKey,
  pluginRpc as pluginRpcKey,
  sessions as sessionsKey,
  tools as toolsKey,
  type ExecutionEnvironment,
  type Plugin,
  type PluginConfigPort,
  type PluginRpc,
} from '@noa/core';
import type { CreateKernelOptions } from './runtime-types.js';
import type { Environment } from './runtime-env.js';

/**
 * The shared execution facts an execution plugin runs on.
 *
 * `subagent` and `ptc` both need the same things — the live provider, the live
 * tool registry, the composed hooks, the persona, the workspace root and a way
 * to report progress — so they are published once here instead of every
 * assembly site hand-copying them into a factory call.
 * @param env - the live environment.
 * @param opts - the assembly options.
 * @returns the provider plugin.
 */
export function executionEnvironmentProvider(env: Environment, opts: CreateKernelOptions): Plugin {
  const value: ExecutionEnvironment = {
    provider: env.provider,
    // Live reads: the registry grows as rows load, and a snapshot taken at
    // provider-activation time would miss every tool registered after it.
    tools: () => [...env.root.must(toolsKey).all()],
    hooks: () => env.hooks(),
    systemPrompt: env.systemPrompt,
    rootDir: () => env.state.rootDir,
    ...(opts.config.maxTurns !== undefined ? { maxTurns: opts.config.maxTurns } : {}),
    // The delegation's lifecycle is a kernel fact every surface wants, so it is
    // wired here rather than left to callers.
    onSubagentProgress: (progress) => {
      env.root.get(sessionsKey)?.current()?.observeSubagent(progress);
    },
  };
  return {
    name: 'execution-environment',
    description: 'Shared execution facts (provider, tools, hooks, persona, workspace) for execution plugins.',
    manifest: {
      title: '执行环境',
      description: '向执行类插件提供模型端点、工具注册表、钩子与工作区等共享事实。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(executionEnvironmentKey, value);
    },
  };
}

/**
 * The namespaced plugin RPC registry.
 *
 * A plugin that owns a settings page or a runtime status registers its handlers
 * here, and they are removed with ITS fiber — so a switched-off plugin cannot
 * answer an operation, and the host needs no per-plugin frame family.
 *
 * Deliberately dumb about payloads: the owning plugin validates its own
 * operations, because only it knows what they mean.
 * @returns the provider plugin.
 */
export function pluginRpcProvider(): Plugin {
  const handlers = new Map<string, (op: string, payload: unknown) => Promise<unknown>>();
  const service: PluginRpc = {
    register: (name, handler) => {
      if (handlers.has(name)) throw new Error(`duplicate plugin RPC namespace "${name}"`);
      handlers.set(name, handler);
      return () => {
        handlers.delete(name);
      };
    },
    invoke: async (name, op, payload) => {
      const handler = handlers.get(name);
      // An unknown namespace is the honest answer for a plugin that is off or
      // absent: the browser asked something no loaded plugin answers.
      if (handler === undefined) throw new Error(`no loaded plugin answers "${name}" (is it enabled?)`);
      return handler(op, payload);
    },
  };
  return {
    name: 'plugin-rpc',
    description: 'Namespaced plugin operations (settings, probes, runtime status), owned by the plugin fiber.',
    manifest: {
      title: '插件操作',
      description: '插件以自己的命名空间注册操作，随插件卸载一并撤销。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(pluginRpcKey, service);
    },
  };
}

/**
 * The durable plugin tree, as a plugin may write it.
 *
 * Present only when the surface supplied a writer (`opts.persist`): a
 * headless run has no config file of the operator's to patch, and a plugin that
 * wants to save then gets a clear refusal instead of a silent no-op. Wiring it
 * as a SERVICE is what lets a plugin own its settings without the host growing a
 * named writer per plugin.
 *
 * **A write re-rosters.** Storing a setting and acting on it are one step: the
 * operator saved credentials and expects the channel to dial, not to wait for the
 * next restart. Doing it HERE rather than at each call site is what keeps a
 * plugin's own save from being the one write that "stored but did nothing" — the
 * port is the only door, so it is the only place that has to remember.
 * @param opts - the assembly options.
 * @param reroster - converge the live tree after a write.
 * @returns the provider plugin.
 */
export function pluginConfigProvider(opts: CreateKernelOptions, reroster: () => Promise<void>): Plugin {
  const persist = opts.persist;
  const service: PluginConfigPort = {
    readEntry: async (id) => {
      if (persist === undefined) {
        throw new Error('this invocation has no config file to read (headless run or embedded kernel)');
      }
      return persist.readPluginEntry(id);
    },
    setEntry: async (id, patch) => {
      if (persist === undefined) {
        throw new Error('this invocation has no writable config file (headless run or embedded kernel)');
      }
      await persist.setPluginEntry(id, patch);
      await reroster();
    },
  };
  return {
    name: 'plugin-config',
    description: 'Reads and writes one plugin row (its switch and its own settings) in the durable config document.',
    manifest: {
      title: '插件配置',
      description: '插件读写自己那一行的开关与设置；写入后插件树立即收敛，配置与运行态不脱节。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(pluginConfigKey, service);
    },
  };
}
