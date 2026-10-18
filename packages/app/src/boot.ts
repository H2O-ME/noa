/**
 * The ONE assembly point: config + provider → a live kernel.
 *
 * Ported from nova's `bootKernel` (`packages/cli/src/kernel-boot.ts`), minus the
 * surface registry: this product has ONE consumer of the kernel (the QQ channel
 * host), so there is no argv-to-surface resolution to keep in sync.
 *
 * Two options are load-bearing and are NOT defaults:
 *
 *  - `userQuestions: true`. The default is fail-closed, and correctly so for an
 *    unattended process — but this channel DOES have someone to answer: a peer
 *    replies in the chat window and `peers.ts` settles the wait from that reply.
 *    Leaving it false is the silent failure where `ask_user_question` exists, the
 *    UI exists, and the question never happens.
 *  - `perRequestCompact: true`. One inbound message is one whole task, so the
 *    auto-compact gate belongs inside every request rather than at turn
 *    boundaries (the same reason `nova exec` sets it).
 */
import os from 'node:os';
import type { ChatProvider, ModelCatalogPort } from '@noa/core';
import { createAgentKernel, createLlmReviewer, type CallReviewer, type Kernel } from '@noa/plugins';
import { loadConfig, type Config } from './config.js';
import { readPluginEntries } from './config-read.js';
import { readPluginEntryConfig, modelDefaultsPort, setPluginEntry, setSkillEnabled } from './config-write.js';
import { modelCatalogPort } from './model-catalog.js';
import { loadModelsDev } from './models-dev.js';
import { buildNoaSystemPrompt, readSoul } from './prompt.js';
import { configuredModel, createEmbedProvider, createProvider, createReviewProvider, createTitleProvider, createTranscribeProvider } from './provider.js';

/** Everything a boot needs; the provider is injectable so tests never dial out. */
export interface BootOptions {
  /** The workspace the agent works in (also what its file tools are rooted at). */
  rootDir: string;
  config: Config;
  /** A test's fake provider; omitted means "build the real client from config". */
  provider?: ChatProvider;
  /**
   * The home every path resolves under; defaults to the real one.
   *
   * Load-bearing for more than tests: the kernel re-reads `plugins.entries` from
   * the FILE on every roster (that is what makes a row switch take effect), so the
   * writer and reader here must point at the same home the config was loaded
   * from.
   */
  homedir?: string;
  /**
   * Where a non-fatal boot diagnostic goes. Defaults to `console.warn`, the same
   * place the host's other warnings go; tests pass a collector instead.
   *
   * These are things the process carries on without and the operator cannot
   * otherwise see: metadata that could not be resolved, a cache that could not be
   * written. Losing them silently is how "the model never receives images" ends up
   * with no explanation anywhere.
   */
  onNotice?: (message: string) => void;
}

/** Assemble the kernel: provider, config slice, durable row writer, first session. */
export async function bootKernel(opts: BootOptions): Promise<Kernel> {
  const provider = opts.provider ?? (await createProvider(opts.config));
  // Read per SESSION OPEN, not captured here: the title model is a config key,
  // and a boot-time capture would keep titling with a model the operator already
  // replaced. A failure to read means "no titles" — a label never blocks a run.
  const homedir = opts.homedir;
  const notice = opts.onNotice ?? ((message: string) => { console.warn(`提示：${message}`); });
  // The product's own persona, not the kernel's fallback: identity + the QQ
  // channel's rendering and send-window facts. The operator's `SOUL.md`, when
  // they wrote one, replaces the identity block and nothing else.
  const systemPrompt = buildNoaSystemPrompt(await readSoul(homedir ?? os.homedir()));
  // The smart-approval reviewer: a separate model call that classifies a gated
  // tool call before the human is bothered. Absent only when there is no endpoint
  // (a boot that already failed) — otherwise `auto` would degrade to asking the
  // human about every command, which is the fatigue this exists to remove.
  const reviewer = buildReviewer(opts.config);
  // The memory system's embedding client. Absent unless `embedModel` is set, and
  // absent is fine: the memory plugin reads the capability with `ctx.get` and
  // falls back to keyword scoring. Nothing here has to know that, because the
  // capability is published only when there is something to publish.
  const embedder = createEmbedProvider(opts.config);
  // The QQ channel's inbound-voice transcriber. Absent unless `sttModel` is set,
  // and absent is fine: the channel answers 「收到一条语音，未配置转写」and keeps the
  // rest of the message. Same conditional-publish discipline as `embedder`.
  const transcriber = createTranscribeProvider(opts.config);
  // What the operator pays, for the channel's `/usage`. Not a client and not a
  // model — a price table is a fact the deployment wrote down — so it is passed
  // through as-is. Absent means `/usage` reports tokens and says the model is
  // unpriced, which is the honest read: an unpriced model is not a free one.
  const pricing = opts.config.pricing;
  const titleProvider = async (): Promise<ChatProvider | undefined> => {
    try {
      return createTitleProvider(await loadConfig(homedir));
    } catch {
      return undefined;
    }
  };
  // The model catalog, with models.dev as its metadata source. Awaited because
  // loading the index is one file read plus at most one download, and doing it
  // here keeps the per-request capability lookup off the disk and off the network
  // — that lookup runs while a turn is being assembled.
  const catalog = await buildCatalog(opts, notice);
  return await createAgentKernel({
    rootDir: opts.rootDir,
    provider,
    model: provider.model ?? configuredModel(opts.config) ?? '',
    config: toKernelConfig(opts.config),
    // The product's persona, replacing the kernel's generic fallback.
    systemPrompt,
    perRequestCompact: true,
    userQuestions: true,
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(embedder === undefined ? {} : { embedder }),
    ...(transcriber === undefined ? {} : { transcriber }),
    ...(pricing === undefined ? {} : { pricing }),
    // 模型座位：有了目录才有 `/model`（否则那条指令会如实说本进程不支持切换）。
    // 「切换」与「写默认」是两个权威，所以是两个座位：前者改这个进程的 client，后者
    // 改配置文件，好让下次启动还从那里开始。没有 `provider` 段的装配（内核测试、
    // 嵌入式调用）就没有目录可列 —— 缺省比编一个空的目录诚实。
    ...(catalog === undefined ? {} : { modelCatalog: catalog }),
    modelDefaults: modelDefaultsPort(homedir),
    // The anchor for bare module specs in `plugins.entries`: this app's own
    // module URL, because the packages it ships are siblings of THIS executable.
    appModulesUrl: import.meta.url,
    // The config file, as this process is allowed to touch it. Without it the
    // channel's pairing flow could not persist an enrolled owner, and a restart
    // would ask the operator to enroll again.
    persist: {
      readPluginEntry: (id) => readPluginEntryConfig(id, homedir),
      readPluginEntries: () => readPluginEntries(homedir),
      setPluginEntry: (id, patch) => setPluginEntry(id, patch, homedir),
      setSkillEnabled: (name, enabled) => setSkillEnabled(name, enabled, homedir),
    },
    titleProvider,
  });
}

/**
 * The config's own fields, projected onto the kernel's slice.
 *
 * A straight pass-through on purpose: the plugin switches the kernel reads are
 * the ones the operator wrote (`plugins.entries`), so there is no second table
 * here that could disagree with the file.
 * @param config - the loaded config.
 * @returns the kernel config slice.
 */
export function toKernelConfig(config: Config): {
  approval: 'full' | 'auto';
  userInstructions?: string;
  maxTurns?: number;
  autoCompactTokenLimit?: number;
  projectDocMaxTokens?: number;
  plugins?: { entries: readonly { id: string; enabled?: boolean; config?: unknown }[] };
  skillsDisable?: readonly string[];
} {
  return {
    approval: config.approval ?? 'auto',
    ...(config.systemPrompt !== undefined ? { userInstructions: config.systemPrompt } : {}),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
    ...(config.autoCompactTokenLimit !== undefined
      ? { autoCompactTokenLimit: config.autoCompactTokenLimit }
      : {}),
    ...(config.projectDocMaxTokens !== undefined ? { projectDocMaxTokens: config.projectDocMaxTokens } : {}),
    plugins: { entries: config.plugins?.entries ?? [] },
    ...(config.skills?.disable !== undefined ? { skillsDisable: config.skills.disable } : {}),
  };
}

/**
 * Build the smart-approval reviewer from config, or nothing when there is no
 * endpoint to review on.
 *
 * The model is `reviewModel` when set, else the main model — the reviewer is a
 * SEPARATE CALL either way (its own client, temperature 0, a one-word answer), so
 * the agent is never reviewing itself in the same request.
 * @param config - the loaded config.
 * @returns the reviewer, or undefined when no endpoint is configured.
 */
function buildReviewer(config: Config): CallReviewer | undefined {
  const provider = createReviewProvider(config);
  return provider === undefined ? undefined : createLlmReviewer({ provider });
}

/**
 * Build the model catalog, loading models.dev for it.
 *
 * Absent when there is no endpoint: a boot without a `provider` section has no
 * ids to list, and an empty catalog would be a lie about a menu.
 *
 * models.dev is loaded HERE rather than lazily per request so the lookup the
 * request path needs is a memory read. A failure to load is not fatal and not
 * hidden: the port still answers, every lookup simply says "unknown", and the
 * reason is printed.
 * @param opts - the boot's options (for the endpoint and the home).
 * @param notice - where a non-fatal diagnostic goes.
 * @returns the port, or undefined when there is nothing to describe.
 */
async function buildCatalog(
  opts: BootOptions,
  notice: (message: string) => void,
): Promise<ModelCatalogPort | undefined> {
  const provider = opts.config.provider;
  const baseURL = provider?.baseURL;
  if (typeof baseURL !== 'string' || baseURL.length === 0) return undefined;
  const modelsDev = await loadModelsDev({ homedir: opts.homedir, log: notice });
  const declared = provider?.inputModalities;
  return modelCatalogPort(baseURL, {
    modelsDev,
    ...(declared === undefined ? {} : { inputModalities: declared }),
    log: notice,
  });
}
