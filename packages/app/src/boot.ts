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
import type { ChatProvider } from '@noa/core';
import { createAgentKernel, type Kernel } from '@noa/plugins';
import { loadConfig, type Config } from './config.js';
import { readPluginEntries } from './config-read.js';
import { readPluginEntryConfig, setPluginEntry, setSkillEnabled } from './config-write.js';
import { configuredModel, createProvider, createTitleProvider } from './provider.js';

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
}

/** Assemble the kernel: provider, config slice, durable row writer, first session. */
export async function bootKernel(opts: BootOptions): Promise<Kernel> {
  const provider = opts.provider ?? (await createProvider(opts.config));
  // Read per SESSION OPEN, not captured here: the title model is a config key,
  // and a boot-time capture would keep titling with a model the operator already
  // replaced. A failure to read means "no titles" — a label never blocks a run.
  const homedir = opts.homedir;
  const titleProvider = async (): Promise<ChatProvider | undefined> => {
    try {
      return createTitleProvider(await loadConfig(homedir));
    } catch {
      return undefined;
    }
  };
  return await createAgentKernel({
    rootDir: opts.rootDir,
    provider,
    model: provider.model ?? configuredModel(opts.config) ?? '',
    config: toKernelConfig(opts.config),
    perRequestCompact: true,
    userQuestions: true,
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
  approval: 'read-only' | 'auto-edit' | 'full';
  userInstructions?: string;
  maxTurns?: number;
  autoCompactTokenLimit?: number;
  projectDocMaxTokens?: number;
  plugins?: { entries: readonly { id: string; enabled?: boolean; config?: unknown }[] };
  skillsDisable?: readonly string[];
} {
  return {
    approval: config.approval ?? 'read-only',
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
