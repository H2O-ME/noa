/**
 * What a surface must SUPPLY to assemble a kernel: the config slice it derives
 * from `~/.noa/config.json` and the factory options it injects.
 *
 * Split from `runtime-types.ts` (which declares the `Kernel` handle a surface
 * CONSUMES) because the two are different contracts read by different code:
 * this one by whoever calls `createAgentKernel`, that one by every caller of
 * the resulting handle.
 */
import type { ChatProvider, ModelCatalogPort, PluginEntryOptions, SubagentProgress, SurfaceRows } from '@noa/core';
import type { PluginEntryConfig } from './plugin-tree.js';
import type { ApprovalMode } from './permission.js';

/** The surface-independent slice of `~/.noa/config.json` the kernel needs. */
export interface KernelConfig {
  approval: ApprovalMode;
  /** config.systemPrompt — appended session directives, not the persona. */
  userInstructions?: string;
  maxTurns?: number;
  autoCompactTokenLimit?: number;
  /**
   * Token budget for the injected AGENTS.md chain
   * (config.projectDocMaxTokens). Deployment-varying, so it is config rather
   * than a constant: a large operator handbook wants more than the default.
   */
  projectDocMaxTokens?: number;
  /**
   * The plugin tree, as the operator wrote it.
   *
   * One list, one field per row: `{ id, enabled?, config? }`. The id is a
   * built-in plugin's name or a module specifier, and `enabled` is the ONLY
   * switch — there is deliberately no second list, because two lists that can
   * disagree are how a switched-off plugin used to come back on (`disable`
   * beating `enable`, plus a config-derived opt-in that outvoted both).
   *
   * A row's `config` is validated by THAT plugin's own `Config` schema, so the
   * kernel never learns what a plugin's settings look like.
   */
  plugins?: { entries?: readonly PluginEntryConfig[] };
  /**
   * Skills the Skill 中心 turned off (`skills.disable`): by name, both levels.
   * Applied where the index is built (the workspace loader), so a disabled
   * skill is absent from the `<available_skills>` block AND from the `skill`
   * tool — one rule, not two. A name matching nothing is refused by the switch
   * rather than written as a dead entry.
   */
  skillsDisable?: readonly string[];
}

export interface CreateKernelOptions {
  rootDir: string;
  provider: ChatProvider;
  config: KernelConfig;
  /** Model id as the endpoint knows it — published on the `llm` service. */
  model?: string;
  /**
   * Model metadata for the picker (display names + context windows). Omitting
   * it means "no picker": the kernel then offers no `models` control, and a
   * surface that would render a model seat simply does not. The model IDS are
   * not part of this port — they come from the endpoint itself
   * (`ChatProvider.listModels`), so a gateway that adds a model needs no
   * release from this product.
   */
  modelCatalog?: ModelCatalogPort;
  /** Resume an existing JSONL log for the FIRST session handle. */
  resumeFile?: string;
  /** Plugins the owning surface contributes, each with the id its config uses. */
  extraPlugins?: readonly PluginEntryOptions[];
  /**
   * The HOST APPLICATION's own module URL (`import.meta.url`), used as the anchor
   * for bare module specs in `plugins.entries` / `surfaces`.
   *
   * It has to be supplied by the caller, because the product's own packages are
   * siblings of the EXECUTABLE, not of this library: the QQ channel package
   * ships with `cli`, so a library-level anchor cannot resolve it and a config
   * row naming it could never load. Omit it and the anchor stays at the library
   * (`module-spec.ts`) — the behaviour embedded kernels and kernel tests keep.
   */
  appModulesUrl?: string;
  /**
   * Wires the model-facing `switch_workspace` tool. Provide the runner-side
   * callback (which typically calls `kernel.setWorkspace` plus its own
   * feedback); omit to leave the tool unregistered (headless exec).
   */
  workspace?: { onChange: (dir: string) => void | Promise<void> };
  /** Nested-subagent visibility feed (live rows). Best-effort, may be unset. */
  onSubagentProgress?: (progress: SubagentProgress) => void;
  /**
   * Whether this surface has a person who can answer `ask_user_question`.
   *
   * Defaults to FALSE, and that default is the fail-closed one: an unattended run
   * (headless `exec`, the bot channel) that offered the tool an answerer would
   * park inside the ask until something aborted it, with no card on any surface to
   * release it. A surface that does have a human sets this, and its
   * `resolveQuestion` is what settles the wait.
   *
   * Set it ONLY when assembling for a surface the kernel cannot ask: the cli's
   * built-in surfaces are registered `AgentSurface`s now, so the registry's
   * recorded winner answers for them — this explicit value covers assemblies
   * with no registry (kernel tests, embedders). A config-loaded surface goes
   * through `packages/cli/src/surface-host.ts`, which derives the value from
   * the surface's own declaration as a fallback — do not hand-copy it there.
   */
  userQuestions?: boolean;
  /**
   * Headless single-run mode: one run spans the whole task, so auto-compact
   * gates inside every request (wrapAutoCompact) instead of at boundaries.
   */
  perRequestCompact?: boolean;
  /** Persona override; defaults to the shipped static prompt. */
  systemPrompt?: string;
  /**
   * Plugin-owned sections appended to the persona prompt at environment
   * creation. Resolved ONCE (at roster build), so each kernel's prompt is
   * byte-stable for its lifetime — the contract the prefix cache depends on.
   * Sections are additive: they tail the persona under their own headings and
   * never rewrite it.
   */
  systemPromptSections?: ReadonlyArray<{ name: string; text: string }>;
  /** Session-file bucket override (qqbot archives under sessionsRoot()/qqbot). */
  sessionDir?: string;
  /**
   * The session-TITLE model's client, read once per conversation at its first
   * real prompt. A thunk over the config FILE, not a boot-time capture: the
   * settings page writes that file, and a capture would keep titling new
   * sessions with a model the operator already replaced. Absent or rejecting
   * means no titles — every listing falls back to the first prompt.
   */
  titleProvider?: () => Promise<ChatProvider | undefined>;
  /**
   * The config file, as this kernel is allowed to touch it.
   *
   * Absent in headless/test assemblies (whose config is not the operator's
   * file): a write then throws instead of pretending to persist. The writer
   * patches the RAW document (never the expanded `Config`), so `{env:NAME}`
   * references survive a toggle.
   *
   * `setPluginEntry` is addressed by row ID and says nothing about any plugin:
   * the kernel has no per-plugin writer, which is what lets a third-party plugin
   * keep settings without a host change. Plugins reach it through the
   * `plugin-config` service; the kernel itself uses it for the row switches.
   */
  persist?: {
    /** One row's config AS WRITTEN (references intact). */
    readPluginEntry(id: string): Promise<unknown>;
    /**
     * The plugin tree AS LOADED — every `plugins.entries` row, expanded.
     *
     * This is a live read for the same reason `readModels` is one: the shell
     * owns the config file, so it owns the read, and a copy cached at assembly
     * goes stale the moment the operator flips a switch. Without it a flip wrote
     * the file while the tree was rebuilt from the boot-time SNAPSHOT, so the
     * kernel re-rostered the pre-flip tree and then reported the flip as failed —
     * both directions. It must be the EXPANDED form (the same one `config` gets),
     * or a re-roster would hand a plugin the literal `{env:NAME}` reference that
     * the writer deliberately preserved on disk.
     */
    readPluginEntries?(): Promise<readonly PluginEntryConfig[]>;
    /** Upsert one row of the durable plugin tree (fields merged, not replaced). */
    setPluginEntry(id: string, patch: { enabled?: boolean; config?: unknown }): Promise<void>;
    /** Rewrite `skills.disable`; returns the list now in force. */
    setSkillEnabled(name: string, enabled: boolean): Promise<readonly string[]>;
  };
  /**
   * The surfaces this kernel serves, as one bundle: the REGISTRY the resolver
   * reads/writes, and the surface implementations already loaded by the caller
   * (`loadSurfacePlugins`).
   *
   * The roster turns each one into an ordinary plugin ROW (`surfacePlugin`), so
   * a surface appears in `/plugins`, carries its own manifest and can be
   * switched off by id — the same shape every other plugin has. The registry is
   * passed in rather than built here because it must outlive the kernel and be
   * shared by the resolver and the container service.
   *
   * `loaded` (not specs) because the caller has to import the modules anyway to
   * answer "which surface claims this invocation" — that is a pure predicate
   * over argv needing no kernel. Passing the loaded objects means ONE import and
   * one identity, so `registry.current()` and the plugin row are the same
   * object. Load them with the shared primitive (`loadSurfacePlugins`), never by
   * hand.
   */
  surfaces?: SurfaceRows;
}

