/**
 * The assembly environment: the container, the mutable parts a workspace or
 * mode change re-points, and the closures every other assembly file reads.
 *
 * Split from `runtime.ts` so the factory body stays readable and the shared
 * shape (what the roster and the façade are allowed to touch) is declared in
 * exactly one place. Everything here is created once per kernel.
 */
import path from 'node:path';
import {
  agentsSkillsRoot,
  buildContextFragment,
  compaction as compactionKey,
  Context,
  jobs as jobsKey,
  llm as llmKey,
  JobRegistry,
  localDateKey,
  APP_DIR,
  appHome,
  deriveUserQuestions,
  sessions as sessionsKey,
  shell as shellKey,
  spill as spillKey,
  tools as toolsKey,
  userQuestions as userQuestionsKey,
  type AgentHooks,
  type AgentSession,
  type ApprovalBroker,
  type ApprovalMode,
  type ChatProvider,
  type CompactedSession,
  type CompactSessionOptions,
  type Plugin,
  type QuestionBroker,
  type SessionEnvInfo,
} from '@noa/core';
import { collectProjectDocs } from './agents-md.js';
import { modelShell } from './builtin/shell-select.js';
import { PluginHost } from './host.js';
import { composeHooks } from './hooks.js';
import { buildSystemPrompt } from './system-prompt.js';
import { loadSkills, type SkillMetadata, type SkillRoot } from './skills.js';
import type { CreateKernelOptions, PluginRosterEntry } from './runtime-types.js';
import type { PluginEntryConfig } from './plugin-tree.js';
import type { PluginRow } from './plugin-tree.js';
import { jobListener } from './job-listener.js';
import { openAgentSession, type OpenSessionOptions, type PermissionService } from './runtime-session.js';
import { makeKernelAskWiring, kernelAskAudit } from './session-ask.js';
import type { ApprovalPolicyCell } from './permission.js';
import { executionEnvironmentProvider, pluginConfigProvider, pluginRpcProvider } from './plugin-services.js';
import {
  approvalProvider,
  compactionProvider,
  jobsProvider,
  llmProvider,
  sessionsProvider,
  skillsProvider,
  spillProvider,
  surfaceRegistryProvider,
  userQuestionsProvider,
} from './services.js';
/** What the assembly mutates: the parts a workspace/mode change re-points. */
export interface State {
  rootDir: string;
  projectDocs: string[];
  /**
   * The skills in force: discovery MINUS `skillsDisable`. This is what the
   * `<available_skills>` fragment and the `skill` tool are built from, so one
   * list governs both doors.
   */
  skills: SkillMetadata[];
  /**
   * Every DISCOVERED skill, switched-off ones included. The Skill 中心 reads
   * this, never `skills`: a disabled skill must stay on the page that turns it
   * back on, and it is absent from `skills` by definition — reading the filtered
   * list there would make the switch one-way (the row would vanish on the flip
   * that disabled it, with no way to undo).
   */
  allSkills: SkillMetadata[];
  host: PluginHost | undefined;
  /**
   * Skills the Skill 中心 turned off (config `skills.disable`, by name, both
   * levels). Mutable: the settings panel flips it through `setSkillEnabled`,
   * and `loadWorkspace` re-reads it after every switch.
   */
  skillsDisable: string[];
  /**
   * The plugin tree as last resolved, including rows that are off or could not
   * be loaded. The management panel reads THIS: a switched-off row leaves no
   * fiber, so the tree is the only place its row can still come from — reading
   * the live container instead would make a switch one-way.
   */
  rows: PluginRow[];
  /**
   * The operator's `plugins.entries`, as the tree is built from.
   *
   * Mutable, and re-read on every roster when the assembly has a config file
   * (`persist.readPluginEntries`): the file is the truth, so a switch that wrote
   * it must be visible to the very next `reroster`. Seeded from the assembly's
   * snapshot for headless/embedded kernels, which have no file to re-read.
   */
  pluginEntries: readonly PluginEntryConfig[];
  /**
   * Serializes `reroster` runs. A roster is read-entries → load-workspace →
   * build tree → `host.sync`; two of them running at once (a workspace switch
   * racing a settings save) can interleave so that the OLDER config snapshot is
   * the one that syncs last, silently rolling the live tree back.
   */
  rerosterQueue: Promise<void>;
  /**
   * This build's in-process plugins, built ONCE per kernel.
   *
   * The loader diffs by plugin identity, so rebuilding them per roster would
   * replace every row on every workspace switch. Kernel facts reach them as
   * thunks over live state and each row's own settings arrive through `config`,
   * which is what makes a single build correct for the kernel's lifetime.
   */
  builtins: readonly Plugin[] | undefined;
  /** The kernel's own slash commands; cached for the same identity reason. */
  kernelCommands: Plugin | undefined;
  /** The configured surfaces wrapped as rows; cached for the same reason. */
  surfacePlugins: readonly Plugin[] | undefined;
  /**
   * The skill writer, when this invocation has a config file. Read by
   * `setSkillEnabled`; absent means a flip refuses rather than pretends.
   */
  persistSkills: ((name: string, enabled: boolean) => Promise<readonly string[]>) | undefined;
  /**
   * The capability providers, published through the same tree as every other
   * row (they head it, so a consumer always finds its service).
   */
  providers: readonly Plugin[];
}

/** The assembled pieces every other assembly file reaches for. */
export interface Environment {
  root: Context;
  state: State;
  jobs: JobRegistry;
  provider: ChatProvider;
  /**
   * The KERNEL-level approval broker, used only for calls that belong to no
   * session (an embedder driving the loop directly, a kernel test). Every real
   * conversation gets its OWN broker from `openSession`, because
   * `ApprovalBroker.attach` holds one publisher: a shared broker meant the newest
   * session stole the card of whatever ask was already outstanding.
   */
  bridge: ApprovalBroker;
  /**
   * The KERNEL-level question seam, same role as `bridge`: the fallback for a
   * session-less `ask_user_question` call. A real conversation asks through its
   * own broker (`AgentSession.questions`), reached by session id.
   */
  questions: QuestionBroker;
  /**
   * The KERNEL-level permission engine: the fallback for session-less calls, and
   * what `Kernel.permission` answers when no session exists. It shares the ONE
   * `policyCell` with every session engine, so `setPolicy('never')` still binds
   * the whole process; its `mode` is deliberately NOT what a conversation uses —
   * that is per session (`AgentSession.permission`).
   */
  permission: PermissionService;
  /**
   * The process-wide 'ask' | 'never' cell, shared by `permission` and by every
   * engine `openSession` builds. One cell, so a headless runner's stance cannot
   * be true for one conversation and false for another.
   */
  policyCell: ApprovalPolicyCell;
  /**
   * The process's default tier for NEW sessions — what a surface's settings
   * row picked. Mutable on the env (not a per-surface field) because sessions
   * are created by several surfaces; the qqbot channel's conversations must
   * start at the same default the browser's would. `undefined` = the boot
   * config's `approval` is the default, unchanged.
   */
  approvalDefault?: ApprovalMode;
  systemPrompt: string;
  sessionEnv(): SessionEnvInfo;
  buildFragment(): string;
  hooks(): AgentHooks;
  /** Re-scan docs + skills for the current workspace root. */
  loadWorkspace(): Promise<SkillMetadata[]>;
  /** The session FACTORY (what the `sessions` provider calls). */
  openSession(sessionOpts?: OpenSessionOptions): Promise<AgentSession>;
  /** Open through the service, which is what makes it the current session. */
  openCurrent(sessionOpts?: OpenSessionOptions): Promise<AgentSession>;
  /** Rebuild the tool host + roster for the current workspace/mode. */
  reroster(): Promise<void>;
  /**
   * Every known plugin's row, loaded or not: live rows from the container plus
   * manifest rows for the disabled ones (which leave no fiber).
   */
  describePlugins(): PluginRosterEntry[];
  /** Flip one plugin's switch: persist the disable list, then re-roster. */
  setPluginEnabled(name: string, enabled: boolean): Promise<readonly string[]>;
  /** Flip one skill's switch: persist the disable list, then reload the index. */
  setSkillEnabled(name: string, enabled: boolean): Promise<readonly string[]>;
}

/** Build the container, publish the capability providers, wire the closures. */
export function createEnvironment(opts: CreateKernelOptions): Environment {
  const { provider, config } = opts;
  const root = Context.createRoot();
  const jobs = new JobRegistry();
  const systemPrompt = opts.systemPrompt ?? buildSystemPrompt(opts.systemPromptSections ?? []);
  const state: State = {
    rootDir: opts.rootDir,
    projectDocs: [],
    skills: [],
    allSkills: [],
    host: undefined,
    skillsDisable: [...(config.skillsDisable ?? [])],
    rows: [],
    pluginEntries: config.plugins?.entries ?? [],
    rerosterQueue: Promise.resolve(),
    builtins: undefined,
    kernelCommands: undefined,
    surfacePlugins: undefined,
    persistSkills: opts.persist?.setSkillEnabled,
    providers: [],
  };

  // ONE policy cell for the whole kernel: `never` says "this process has no
  // interactive answerer", which is true for every conversation here, while the
  // TIER is per session. Sharing the cell by reference is what keeps those two
  // facts from being confused with each other.
  const policyCell: ApprovalPolicyCell = { policy: 'ask' };
  const { bridge, questions, permission } = makeKernelAskWiring({
    approval: config.approval,
    rootDir: () => state.rootDir,
    tools: () => root.get(toolsKey)?.all() ?? [],
    policyCell,
    // Only session-less calls route here (kernel tests, embedders); a real
    // conversation audits into its own log (`openAgentSession`).
    audit: kernelAskAudit(() => root.get(sessionsKey)?.current()),
  });

  const env: Environment = {
    root,
    state,
    jobs,
    provider,
    bridge,
    questions,
    permission,
    policyCell,
    systemPrompt,
    sessionEnv: () => ({
      platform: process.platform,
      cwd: state.rootDir,
      // Read LIVE from the ROW that owns shell execution, by SERVICE — the host
      // does not know which plugin that is. No provider means no
      // shell-executing row is loaded, and probing the environment is then the
      // honest answer (and the one the terminal panel already uses).
      shell: root.get(shellKey)?.name ?? modelShell(undefined).name,
      // Local date, matching the session bucket: a UTC slice calls every
      // evening run west of the meridian "yesterday".
      today: localDateKey().join('-'),
    }),
    buildFragment: () =>
      buildContextFragment(env.sessionEnv(), config.userInstructions, state.skills, state.projectDocs),
    hooks: () => composeHooks(root),
    loadWorkspace: () => loadWorkspace(env, config.projectDocMaxTokens),
    openSession: (sessionOpts) => openSession(env, opts, sessionOpts),
    openCurrent: (sessionOpts) => root.must(sessionsKey).open(sessionOpts),
    reroster: () => reroster(env, opts),
    describePlugins: () => describePlugins(env),
    setPluginEnabled: (name, enabled) => setPluginEnabled(env, name, enabled),
    setSkillEnabled: (name, enabled) => setSkillEnabled(env, name, enabled),
  };

  // ── capability providers: one plugin per seam ───────────────────────────
  //
  // Registered through the SAME tree as every other row (the roster puts them
  // first). They are not a second lifecycle: a provider that loaded outside the
  // loader could neither be diffed against the previous roster nor torn down
  // with it, which is how the old assembly ended up wiring the container twice.
  //
  // Order is a contract: a consumer activated before its provider would find the
  // service absent, so these stay at the head of the tree.
  const providers: Plugin[] = [
    executionEnvironmentProvider(env, opts),
    pluginRpcProvider(),
    // The port that writes the durable tree re-rosters through the SAME path the
    // settings panel uses, so a plugin's save and a panel switch cannot disagree
    // about what "applied" means.
    pluginConfigProvider(opts, () => reroster(env, opts)),
    approvalProvider(permission),
    llmProvider({ provider, model: opts.model ?? '' }),
    // `jobs-service`, not `jobs`: the model-facing `jobs` TOOL plugin owns that
    // name, and a shared name made the tool's switch unsheddable (see
    // `jobsProvider`). The service key is still `jobs`.
    jobsProvider(jobs),
    spillProvider(),
    compactionProvider(),
    skillsProvider(() => state.skills, () => loadWorkspace(env, config.projectDocMaxTokens)),
    sessionsProvider(env.openSession),
    // The surface registry, provided INTO the container. The instance is built
    // by the caller (see `surfaceRegistryProvider`): it has to exist before the
    // kernel so the roster loads surface plugins into the registry the resolver
    // will read. Providing it is what makes a surface an ordinary row.
    ...(opts.surfaces !== undefined ? [surfaceRegistryProvider(opts.surfaces.registry)] : []),
    // The answerer seam the ask tool reads per call. This is the ONE source:
    // "does the surface in force have a human?" is answered from the registry,
    // lazily, so no assembly site hand-copies a boolean and no surface with a
    // human can be forgotten again. A registry that has not resolved yet (or a
    // surface with no human) answers false → the tool reports NO_PROVIDER
    // instead of parking a run no card can release.
    //
    // `opts.userQuestions` is the fallback for assemblies that supply no
    // registry (kernel tests, embedders): it is ORed, never required.
    userQuestionsProvider(questions.asker, () => {
      const current = opts.surfaces?.registry.current();
      if (current !== undefined) return deriveUserQuestions(current);
      return opts.userQuestions === true;
    }),
  ];
  state.providers = providers;
  return env;
}

/** Open one durable session handle over the live services. */
async function openSession(
  env: Environment,
  opts: CreateKernelOptions,
  sessionOpts?: OpenSessionOptions,
): Promise<AgentSession> {
  const llm = env.root.must(llmKey);
  const jobs = env.root.must(jobsKey);
  const agent = await openAgentSession(
    {
      config: opts.config,
      systemPrompt: env.systemPrompt,
      provider: llm.provider,
      rootDir: () => env.state.rootDir,
      tools: () => [...env.root.must(toolsKey).all()],
      hooks: env.hooks,
      jobs,
      buildFragment: env.buildFragment,
      cacheDir: (sessionId) => env.root.must(spillKey).dir(sessionId),
      policyCell: env.policyCell,
      // The tier a new conversation STARTS at: the process default when a
      // surface's settings row picked one (live read — a pick made after boot
      // still reaches the chat channel's next conversation), else the boot
      // config's `approval`.
      approvalDefault: () => env.approvalDefault,
      // The default answer is the surface in force, read LIVE (a plugin flip or a
      // late-claiming surface must be reflected without reopening the session);
      // a caller that knows better for its own conversation overrides it.
      canAskUser:
        sessionOpts?.canAskUser
        ?? (() => env.root.get(userQuestionsKey)?.answerer() !== undefined),
      compact: (options: CompactSessionOptions): Promise<CompactedSession> =>
        env.root.must(compactionKey).run(options),
      perRequestCompact: opts.perRequestCompact === true,
      ...(opts.titleProvider === undefined ? {} : { titleProvider: opts.titleProvider }),
      // Input modalities of the model in force, read per request. The provider
      // is the authority on WHICH model is active (`ChatProvider.model`) and the
      // catalog answers what that id can accept, so this reads both live rather
      // than capturing either: the user can switch models between turns, and an
      // image attached under a vision model must become a text placeholder the
      // moment the model in force cannot accept it.
      inputModalities: async () => {
        const catalog = opts.modelCatalog;
        const model = llm.provider.model;
        if (catalog?.capabilities === undefined || model === undefined) return undefined;
        try {
          return (await catalog.capabilities(model))?.inputModalities;
        } catch {
          // A catalog that cannot answer must not fail the turn: `undefined`
          // means "not declared", which fails OPEN (see `acceptsImages`).
          return undefined;
        }
      },
    },
    sessionOpts,
  );
  // Affinity is bound by the sessions provider (open AND activate), so this
  // factory only has to hand back a live handle.
  jobs.setListener(jobListener(env));
  return agent;
}

/** Project + user skills and the AGENTS.md chain for the current root. */
async function loadWorkspace(env: Environment, maxDocTokens?: number): Promise<SkillMetadata[]> {
  const dir = env.state.rootDir;
  // The chain's working directory is the workspace root itself, never
  // `process.cwd()`: the docs a session injects must follow its workspace, not
  // where the process was launched (a resumed session can root anywhere).
  env.state.projectDocs = await collectProjectDocs(dir, dir, ...(maxDocTokens !== undefined ? [maxDocTokens] : []));
  const all = await loadSkills(skillRoots(dir));
  // The Skill 中心's switch subtracts by NAME here — the one filter the whole
  // product reads: the `<available_skills>` block (built from `state.skills`
  // via `buildFragment`) and the `skill` tool (registered over the same list)
  // both see the filtered list, so one rule governs both doors. The UNFILTERED
  // discovery is kept alongside it so the panel can still list — and therefore
  // re-enable — a skill this filter removed. A name matching nothing warns at
  // assembly (the same typo discipline a plugin row's own config gets), not
  // here: this runs on every workspace switch, where warning every time would
  // spam.
  const off = new Set(env.state.skillsDisable);
  env.state.allSkills = all;
  env.state.skills = all.filter((skill) => !off.has(skill.name));
  return env.state.skills;
}

/**
 * The skill roots for `rootDir`, in precedence order — first listing of a name
 * wins.
 *
 * The cross-tool `.agents` standard comes FIRST at each level, because that is
 * where other agents and the operator's shared tooling install skills; nova's
 * own `.noa/skills` stays as the second root per level so an existing install
 * keeps working. `level` only drives the Skill 中心's project/system grouping,
 * so both roots at a level carry that level's value.
 * @param rootDir - the workspace root.
 * @returns the ordered roots to walk.
 */
function skillRoots(rootDir: string): SkillRoot[] {
  return [
    { dir: agentsSkillsRoot(rootDir), level: 'project' },
    { dir: path.join(rootDir, APP_DIR, 'skills'), level: 'project' },
    { dir: agentsSkillsRoot(), level: 'user' },
    { dir: path.join(appHome(), 'skills'), level: 'user' },
  ];
}

/**
 * The roster module reads the environment TYPE from here; this file reads its
 * `reroster` value — a one-way runtime edge with a type-only import back, so
 * there is no evaluation cycle.
 */
import { setPluginEnabled, setSkillEnabled } from './runtime-switch.js';
import { describePlugins, reroster } from './runtime-roster.js';
