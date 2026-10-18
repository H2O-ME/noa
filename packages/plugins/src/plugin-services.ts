/**
 * The HOST capabilities that let an optional package be a normal plugin.
 *
 * These exist because the alternative was a host-side factory per package: the
 * roster used to construct `subagentPlugin(options)` and `ptcPlugin(options)`
 * itself, which meant the kernel knew every optional plugin by name and had to
 * be edited whenever one was added. A capability provider is the other way
 * round — the host publishes what any execution plugin needs, and the plugin
 * declares `inject` and reads it.
 */
import {
  embeddings as embeddingsKey,
  executionEnvironment as executionEnvironmentKey,
  modelControl as modelControlKey,
  modelDefaults as modelDefaultsKey,
  pluginConfig as pluginConfigKey,
  pricing as pricingKey,
  sessions as sessionsKey,
  tools as toolsKey,
  transcription as transcriptionKey,
  type EmbeddingClient,
  type ExecutionEnvironment,
  type ModelControl,
  type ModelDefaultsPort,
  type Plugin,
  type PluginConfigPort,
  type PricingTable,
  type TranscriptionClient,
} from '@noa/core';
import type { CreateKernelOptions } from './runtime-types.js';
import type { Environment } from './runtime-env.js';

/**
 * The model SWITCHING seat, published only when a model catalog was supplied.
 *
 * Conditionally provided for the same reason as the clients below: the consumer
 * (the QQ channel's `/model`) reads it with `ctx.get`, so "this assembly has no
 * picker" must be an ABSENT SERVICE rather than one that throws on use. Built by
 * `modelControl` from the live env, so a switch is visible to every reader of the
 * same client instead of being a copy that goes stale.
 * @param control - the control the facade would otherwise hold privately.
 * @returns the provider plugin, or undefined when there is nothing to provide.
 */
export function modelControlProvider(control: ModelControl | undefined): Plugin | undefined {
  if (control === undefined) return undefined;
  return {
    name: 'model-control',
    description: 'Model listing and in-place switching, for surfaces that offer a model picker.',
    manifest: {
      title: '模型切换',
      description: '列出端点提供的模型并在原地切换（装配时提供了模型目录后可用）。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(modelControlKey, control);
    },
  };
}

/**
 * The model DEFAULT writer, published only when the surface has a config file to
 * rewrite.
 *
 * Separate from the switch above because it is a different authority (see
 * `ModelDefaultsPort`): one changes this process, the other changes what the next
 * process starts with. A channel that finds this absent says so instead of
 * reporting a switch it cannot persist.
 * @param port - the writer the host built, or undefined.
 * @returns the provider plugin, or undefined when there is nothing to provide.
 */
export function modelDefaultsProvider(port: ModelDefaultsPort | undefined): Plugin | undefined {
  if (port === undefined) return undefined;
  return {
    name: 'model-defaults',
    description: 'Persisting a model id as the deployment default, for `/model default`.',
    manifest: {
      title: '默认模型',
      description: '把某个模型写成部署的默认（改写配置文件），供 `/model default` 使用。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(modelDefaultsKey, port);
    },
  };
}

/**
 * The embedding seam, published only when the install has an embedding model.
 *
 * Conditionally provided on purpose. The consumer (the memory plugin) reads it
 * with `ctx.get` and degrades to keyword scoring when it is absent, so "no
 * `embedModel` configured" must be an ABSENT SERVICE rather than a service that
 * throws on use — the difference is whether a consumer can tell the two states
 * apart at load time, and it can only do that if absence is spelled as absence.
 * @param client - the embedding client the surface built, or undefined.
 * @returns the provider plugin, or undefined when there is nothing to provide.
 */
export function embeddingsProvider(client: EmbeddingClient | undefined): Plugin | undefined {
  if (client === undefined) return undefined;
  return {
    name: 'embeddings',
    description: 'Text embeddings from the configured embedding model, for plugins that need semantic recall.',
    manifest: {
      title: '向量模型',
      description: '把文本转成向量，供需要语义检索的插件使用（配置 embedModel 后可用）。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(embeddingsKey, client);
    },
  };
}

/**
 * The transcription seam, published only when the install has a speech-to-text model.
 *
 * Conditionally provided for the same reason as `embeddingsProvider`: the consumer
 * (the QQ channel) reads it with `ctx.get` and degrades to 「未配置转写」when it is
 * absent, so "no `sttModel` configured" must be an ABSENT SERVICE rather than a
 * service that throws on use.
 * @param client - the transcription client the surface built, or undefined.
 * @returns the provider plugin, or undefined when there is nothing to provide.
 */
export function transcriptionProvider(client: TranscriptionClient | undefined): Plugin | undefined {
  if (client === undefined) return undefined;
  return {
    name: 'transcription',
    description: 'Speech-to-text from the configured transcription model, for channels that receive voice messages.',
    manifest: {
      title: '语音转写',
      description: '把语音消息转成文字，供接收语音的通道使用（配置 sttModel 后可用）。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(transcriptionKey, client);
    },
  };
}


/**
 * The pricing seam, published only when the deployment wrote a price table.
 *
 * Conditionally provided for the same reason as the two clients above: a consumer
 * reads it with `ctx.get`, and "this deployment did not price its models" must be
 * an ABSENT SERVICE so the consumer can tell it apart from "priced at zero" at
 * load time. `/usage` then reports tokens and says the model is unpriced instead
 * of printing $0.00 — a number nobody can distinguish from free.
 *
 * A plain table rather than a client: there is no implementation to discover and
 * no IO to do, only arithmetic (see `core/pricing.ts`). Publishing the data IS
 * the whole job.
 * @param table - the deployment's price table, or undefined.
 * @returns the provider plugin, or undefined when there is nothing to provide.
 */
export function pricingProvider(table: PricingTable | undefined): Plugin | undefined {
  if (table === undefined) return undefined;
  return {
    name: 'pricing',
    description: 'Per-model prices (USD per million tokens), for surfaces that estimate cost.',
    manifest: {
      title: '模型价格',
      description: '各模型每百万 token 的价格，供估算成本用（配置 pricing 后可用）。',
      tier: 'core',
    },
    apply: (ctx): void => {
      ctx.provide(pricingKey, table);
    },
  };
}

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
