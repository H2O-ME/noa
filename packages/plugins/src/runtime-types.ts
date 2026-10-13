/**
 * The `Kernel` handle a surface CONSUMES (and the roster rows it reports).
 *
 * Split from the assembly INPUT (`runtime-assembly.ts`: `KernelConfig` +
 * `CreateKernelOptions`) because the two are read by different code — the input
 * by whoever calls `createAgentKernel`, this by every caller of the handle —
 * and the file had outgrown the structure budget holding both. The input types
 * are re-exported below so `runtime-types.js` stays the one seam importers use.
 */
import type {
  AgentHooks,
  AgentSession,
  ApprovalMode,
  JobRegistry,
  LlmService,
  ModelControl,
  PermissionPort,
  PluginClientBundle,
  PluginRpc,
  PluginTier,
  SessionEnvInfo,
} from '@noa/core';
import type { CommandSummary } from './kernel-commands.js';
import type { SkillMetadata } from './skills.js';
import type { PluginHost } from './host.js';

export type { CreateKernelOptions, KernelConfig } from './runtime-assembly.js';

export interface Kernel {
  /** The CURRENT AgentSession handle (audit/job fan-out/per-request compact target). */
  readonly agent: AgentSession;
  /** The composed hook chain of the current roster (subagent nesting shares it). */
  readonly hooks: AgentHooks;
  readonly host: PluginHost;
  /** The model end: provider + model id + cache affinity (a capability seam). */
  readonly llm: LlmService;
  /**
   * The model picker's handle — present only when the assembly was given a
   * `modelCatalog` AND the provider can retarget (`ChatProvider.setModel`).
   * Absent means the seat should not render at all, rather than render dead.
   */
  readonly models?: ModelControl;
  /**
   * Every slash command the kernel can run **on itself**, live from the
   * registry — first-party and third-party alike, so a surface renders one menu
   * instead of keeping a catalog of its own. Commands that need a surface
   * affordance (a theme switch, an exit, the model picker) are NOT here: they
   * belong to the surface that can carry them out.
   */
  readonly commands: readonly CommandSummary[];
  /**
   * Run one by name. Reporting happens in the command's own transcript row
   * (`command` events), and an unknown name reports there too — the caller is
   * never left with a silent no-op or a thrown error to render.
   */
  runCommand(name: string, args: string): Promise<void>;
  /**
   * The permission engine in force — the CONVERSATION's, not the kernel's.
   *
   * `mode` here is the tier of the session the operator is looking at (that is
   * what `/perm` must change), while `policy` rides the process-wide cell every
   * session engine shares. Read through `PermissionPort` rather than the
   * concrete service because a session may hand the loop a narrower engine; the
   * accessor falls back to the kernel engine only when no session exists.
   */
  readonly permission: PermissionPort;
  /**
   * The process's default tier for NEW sessions — what a surface's settings
   * row picked (the web tier select writes it through `set_approval_mode`).
   * Lives on the kernel rather than in any one surface because conversations
   * are created by SEVERAL surfaces: a default the qqbot channel never sees
   * would apply to browser sessions only, which is the "设置了也不执行" bug.
   * `undefined` = fall back to the boot config's `approval`.
   */
  get approvalDefault(): ApprovalMode | undefined;
  setApprovalDefault(mode: ApprovalMode | undefined): void;
  readonly jobs: JobRegistry;
  /**
   * The skills in force (discovery minus `skillsDisable`). This is the list the
   * `<available_skills>` fragment and the `skill` tool are built from.
   */
  readonly skills: SkillMetadata[];
  /**
   * Every DISCOVERED skill, switched-off ones included. A management surface
   * reads this, never `skills`: a disabled skill is absent from `skills` by
   * definition, so listing from there would let a reader switch a skill off and
   * then lose the row that switches it back on.
   */
  readonly allSkills: SkillMetadata[];
  readonly systemPrompt: string;
  rootDir(): string;
  sessionEnv(): SessionEnvInfo;
  /** The session-start context fragment for the CURRENT workspace. */
  buildFragment(): string;
  /**
   * What is actually loaded right now: every plugin's name, state and declared
   * dependencies. This is the traceability surface — `/plugins` prints it, and
   * a boot that lost a capability is visible here instead of at the first call.
   */
  roster(): readonly PluginRosterEntry[];
  /**
   * Flip one plugin row's switch: upserts its entry in the durable plugin tree
   * (via the surface's config port) and re-rosters in place. Returns the ids now
   * switched off. Throws for an unknown id and for a `core` row, which is
   * load-bearing and refuses to be turned off.
   */
  setPluginEnabled(id: string, enabled: boolean): Promise<readonly string[]>;
  /**
   * Flip one skill's switch: rewrites the durable `skills.disable` list and
   * reloads the skill index in place. Returns the names now disabled. Throws
   * for unknown skill names.
   */
  setSkillEnabled(name: string, enabled: boolean): Promise<readonly string[]>;
  /**
   * The names currently switched off, as a management surface lists them.
   * Read-only: the switch methods above are the only writers and they return the
   * same list, so a panel never has to derive switch state from its own rows.
   */
  readonly disabled: { readonly plugins: readonly string[]; readonly skills: readonly string[] };
  /**
   * Create another AgentSession on this kernel's wiring (its own log + live
   * surface; shared host/permission/jobs) and make it current — `/new` and a
   * resume/session switch from a surface (web, cli `/new`).
   */
  newAgentSession(opts?: { resumeFile?: string; sessionDir?: string }): Promise<AgentSession>;
  /**
   * Make an ALREADY-CREATED session current again. A PLUGIN does not go through
   * this member: a plugin that owns its own conversations (qqbot peer switch)
   * injects the `sessions` service and calls `sessions.activate(agent)`
   * directly. In-repo surface switches (`/resume`, web session switch) create
   * and make current in one step via `newAgentSession`, so this member has no
   * production caller in the repo today — it is a kernel-handle seam like
   * `routes`, not a wired path.
   */
  activateSession(agent: AgentSession): void;
  /** Re-point the tool root + docs + skills + host at another directory. */
  setWorkspace(dir: string): Promise<SkillMetadata[]>;
  /**
   * One row's own settings, as written — the generic read a consumer of a plugin
   * uses.
   *
   * Deliberately by ID and untyped: the kernel has no opinion about any plugin's
   * settings shape, and a consumer that needs them (a command that displays the
   * code mode, a surface that renders a status) names the row itself. This
   * replaced a typed `codeMode()` member, which put one plugin's vocabulary
   * (`PtcMode`) into the contract every surface implements.
   * @param id - the row's id; `undefined` when no such row exists.
   * @returns the row's config, or undefined when the row is absent or has none.
   */
  pluginConfig(id: string): unknown;
  /**
   * Every loaded plugin's operations, by the id its config row uses.
   *
   * Absent only when the assembly provided no registry (an embedded kernel with a
   * hand-built container), which is why it is a method returning undefined rather
   * than a hard dependency: a surface that has no plugin pages simply never calls
   * it, and one that does gets the same registry the plugins registered with.
   * @returns the registry, or undefined when this assembly has none.
   */
  pluginRpc(): PluginRpc | undefined;
  /** Unload every plugin (a clean shutdown; process exit is the usual path). */
  dispose(): Promise<void>;
}

/** One live plugin, as `/plugins` reports it. */
export interface PluginRosterEntry {
  /** The entry id: a built-in's name, or the module specifier that loaded it. */
  name: string;
  state: string;
  inject: readonly string[];
  /**
   * Whether the row is currently loaded. A row switched off in the operator's
   * tree keeps its place here with `enabled: false` — a disabled plugin leaves
   * no fiber, so its row comes from the resolved tree (see `describePlugins`).
   */
  enabled: boolean;
  /**
   * Where the plugin came from: a built-in (`builtin`), a package loaded by
   * specifier (`extra`), a capability provider (`capability`), or the surface's
   * own assembly (`surface`). The settings panel groups rows by this.
   */
  origin: PluginOrigin;
  /**
   * Which layer this plugin belongs to, as its OWN manifest declares it — the
   * manager's grouping axis and the switch's ceiling. `core` rows get no switch
   * (and the switch refuses); `advanced` rows ship off.
   */
  tier: PluginTier;
  /** The operator-facing title from the plugin's manifest; never the identifier. */
  title: string;
  /**
   * The row's one-line description, from the plugin's manifest. Optional
   * because a plugin that declares no manifest has only its model-facing
   * `description`, and one with neither has nothing to say.
   */
  description?: string;
  /**
   * Why a row has no fiber although it should have one: its package could not
   * be loaded (module missing / bad export), or its config failed validation.
   * Absent for every healthy row — a plugin that loaded, or one that is simply
   * off, has no error to report.
   */
  error?: string;
  /**
   * Whether this plugin answers a settings `page` operation, from its manifest.
   * The browser derives its settings navigation from this flag alone.
   */
  page?: boolean;
  /**
   * The plugin's BROWSER-side bundle, when it ships one. Absent means the
   * plugin is server-only (the common case — most plugins extend the kernel
   * container with tools/services and need nothing in the browser beyond what
   * the host already ships). A plugin that contributes UI capabilities
   * (fence renderers, genui panels) declares where its client bundle is served
   * so the browser loader can fetch and register it on boot.
   *
   * `rev` rides the boot graph: a plugin rebuild bumps it, which busts the
   * loader's per-entry memo together with the host's immutable asset caching.
   * The path is served by the host's `RouteRegistry` under the same prefix
   * (`/plugins/<name>/client.js`) — the loader builds that URL from the
   * plugin's name, so the bundle is discoverable without a separate manifest.
   */
  clientBundle?: PluginClientBundle;
}

/** Where a roster row came from (the plugin manager's grouping axis). */
export type PluginOrigin = 'builtin' | 'surface' | 'extra' | 'capability';

/**
 * One known row, loaded or not: what the plugin manager draws.
 *
 * Loaded rows report their live container state; rows that are off, or whose
 * package could not be loaded, come from the resolved tree instead — otherwise a
 * turned-off plugin would vanish from the very page that turns it back on.
 *
 * This is the part of a row that comes from the tree ALONE (`describePlugins`
 * builds it before it knows anything about a fiber), which is why every field
 * here is one the resolved manifest can answer. `PluginRosterEntry` is this plus
 * the live container's half.
 */
export interface PluginDescriptor {
  name: string;
  origin: PluginOrigin;
  /** Which layer the plugin belongs to — see `PluginRosterEntry.tier`. */
  tier: PluginTier;
  /** The operator-facing title; see `PluginRosterEntry.title`. */
  title: string;
  /** The row's one-line description; see `PluginRosterEntry.description`. */
  description?: string;
  /** Why a row has no fiber although it should have one; see `PluginRosterEntry.error`. */
  error?: string;
  /** Whether the plugin answers a settings `page` operation; see `PluginRosterEntry.page`. */
  page?: boolean;
  /** The plugin's browser bundle; see `PluginRosterEntry.clientBundle`. */
  clientBundle?: PluginClientBundle;
}
