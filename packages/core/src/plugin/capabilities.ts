/**
 * The capability seams — one name per thing the application can replace.
 *
 * The container (`context.ts` / `fiber.ts`) says *how* plugins load; this file
 * says *what they load for*. Every entry is a `ServiceKey` (a provider registers
 * it, consumers declare it in `inject` and read it with `ctx.must(key)`) or an
 * `EventKey` (a lifecycle point others hook into), and each one is a seam an
 * operator can fill from `~/.noa/config.json` without touching source: drop a
 * capability by leaving its provider out, replace one by loading another.
 *
 * The interface next to each key is the contract — deliberately behavioural, not
 * a snapshot of today's implementation: a tool registry can be backed by a
 * sandbox, a compaction service by a cheaper summarizer model, an LLM service by
 * any OpenAI-compatible endpoint. `core` owns these shapes; the provider plugins
 * live where they belong (the `plugins` package for the shipped ones).
 *
 * Two rules keep this list from rotting:
 *  - a key is added only when something already *consumes* it (no speculative
 *    seams), and
 *  - the interface describes what a consumer needs, not what the current
 *    provider happens to have.
 */
import type { DecideResult, PermissionPort } from '../approval.js';
import type { BeforeTurnEndContext, BeforeTurnEndVerdict, ChatRequest, ToolCall, ToolCallScope, ToolCallVerdict, ToolDefinition, ToolPermissionKind } from '../types.js';
import type { CompactedSession, CompactSessionOptions } from '../compact.js';
import type { JobRegistry } from '../jobs.js';
import type { AgentSession } from '../kernel/session.js';
import type { AgentSurface, AgentSurfaceRequest } from '../kernel.js';
import type { AskQuestionsFn } from '../user-question.js';
import { event, type EventKey } from './events.js';
import { key, type ServiceKey } from './types.js';

/* ── loader ────────────────────────────────────────────────────────────── */

/**
 * The plugin tree itself, as a service.
 *
 * A plugin holding this reaches the same row lifecycle the host does — `create`,
 * `update`, `remove` — so a plugin can contribute its own subtree at runtime
 * instead of asking the host for a named extension point. It sits here with the
 * other keys rather than next to its implementation because this file is the one
 * place that says WHAT can be replaced; `loader.ts` only says how loading works.
 */
export const loader: ServiceKey<import('./loader.js').PluginLoader> =
  key<import('./loader.js').PluginLoader>('loader');

/* ── llm ───────────────────────────────────────────────────────────────── */

/**
 * The model end. `provider` is the wire client the loop streams from; the
 * identity bits are what surfaces display and what the cache-affinity header
 * needs, so a surface never reaches into provider internals.
 */
export interface LlmService {
  readonly provider: import('../types.js').ChatProvider;
  /**
   * Model id in force as the endpoint knows it (display, metadata lookups).
   * LIVE, not a boot-time copy: the provider owns the id (`ChatProvider.model`)
   * and a picker retargets it in place, so a surface that cached this string at
   * boot would keep drawing yesterday's model.
   */
  readonly model: string;
  /**
   * Pin subsequent requests of one session to a cache node. Called by the
   * session plumbing itself, so affinity can no longer be left unbound by a
   * surface that forgot to wire it.
   */
  bindSession(sessionId: string | undefined): void;
}

export const llm: ServiceKey<LlmService> = key<LlmService>('llm');

/* ── execution-environment ─────────────────────────────────────────────── */

/**
 * The shared facts an EXECUTION plugin runs on.
 *
 * A plugin that runs agent work of its own (`subagent`, `ptc`) needs the live
 * provider, the live tool registry, the composed hooks, the persona and the
 * workspace root. Publishing them as one service is what lets such a plugin be
 * an ordinary package: it declares `inject` and reads this, instead of the host
 * constructing it through a per-package factory the kernel has to name.
 *
 * Every function member is a LIVE read. The registry grows as rows load and the
 * root moves when the workspace does, so a snapshot taken at provider-activation
 * time would serve stale facts to every later turn.
 */
export interface ExecutionEnvironment {
  readonly provider: import('../types.js').ChatProvider;
  /** The tools registered right now (the loop's own view). */
  tools(): ToolDefinition[];
  /** The composed hook chain of the current roster. */
  hooks(): import('../types.js').AgentHooks;
  readonly systemPrompt: string;
  rootDir(): string;
  /** The turn cap in force, when the kernel has one. */
  readonly maxTurns?: number;
  /** Report a delegated run's lifecycle to the session in force. */
  onSubagentProgress(progress: import('../tools/subagent.js').SubagentProgress): void;
}

export const executionEnvironment: ServiceKey<ExecutionEnvironment> =
  key<ExecutionEnvironment>('execution-environment');

/* ── plugin-rpc ────────────────────────────────────────────────────────── */

/**
 * Namespaced plugin operations, for the plugins that own a settings page or a
 * runtime status.
 *
 * A plugin registers handlers under its own namespace and gets a disposer, so
 * the operations disappear with its fiber: a switched-off plugin cannot answer,
 * and the host needs no per-plugin request family. The payload stays `unknown`
 * on purpose — the owning plugin is the only thing that knows what its
 * operations mean, so it validates them itself.
 */
export interface PluginRpc {
  /** Claim one namespace; the returned disposer releases it (tie it to a fiber). */
  register(name: string, handler: (op: string, payload: unknown) => Promise<unknown>): import('./types.js').Dispose;
  /** Run one operation. Throws when no loaded plugin owns the namespace. */
  invoke(name: string, op: string, payload: unknown): Promise<unknown>;
}

export const pluginRpc: ServiceKey<PluginRpc> = key<PluginRpc>('plugin-rpc');

/* ── plugin-config ─────────────────────────────────────────────────────── */

/**
 * The durable plugin tree, as a PLUGIN is allowed to touch it.
 *
 * A plugin that owns settings has to be able to save them, and the previous
 * answer was a named writer per first-party plugin on the surface side
 * (`saveQqBotConfig`, `setPluginsEnabled`) — which is the "adding a plugin means
 * editing the host" defect in its purest form. With this port a plugin writes
 * ITS OWN row: the panel says "this row looks like that now", and the shape
 * inside `config` stays the plugin's business.
 *
 * Absent in assemblies with no durable config (headless runs, kernel tests): a
 * plugin that wants to persist then reports that it cannot, instead of pretending.
 *
 * The port writes to the RAW document, so `{env:NAME}` references the operator
 * wrote survive a toggle rather than being replaced by their expanded secrets.
 */
export interface PluginConfigPort {
  /**
   * One row's settings AS WRITTEN in the config document.
   *
   * Deliberately the raw text, not the value the plugin was applied with: the
   * load path expands `{env:NAME}` references, so a plugin handed its resolved
   * config cannot tell a literal secret from a reference to one. A settings page
   * that echoes the reference NAME (rather than the secret) needs the raw form,
   * and a save that leaves a field alone must leave its reference alone.
   * @param id - the row's id.
   * @returns the stored config, or undefined when the row has none.
   */
  readEntry(id: string): Promise<unknown>;
  /**
   * Upsert one row's switch and/or its own settings.
   *
   * A field left absent is left as stored, so the row switch and a plugin's
   * settings page never blank each other's work. `config` is merged ONE KEY AT A
   * TIME into what is already stored: a settings form submits the fields it owns,
   * and everything else in the row — including a `{env:NAME}` reference the
   * operator wrote for a field the form did not touch — survives. A key whose
   * value is `null` is removed, which is how a form clears an optional field.
   *
   * The merge is deliberately shallow: a nested object is a value, not a tree to
   * reconcile, so a plugin that owns a structured setting still writes it whole
   * and does not have to reason about what the host did to its sub-keys.
   * @param id - the row's id (a built-in's name or a module specifier).
   * @param patch - the fields to write.
   */
  setEntry(id: string, patch: { enabled?: boolean; config?: unknown }): Promise<void>;
}

export const pluginConfig: ServiceKey<PluginConfigPort> = key<PluginConfigPort>('plugin-config');

/* ── tools ─────────────────────────────────────────────────────────────── */

/** One registered tool with its owner and static permission kind. */
export interface ToolEntry {
  plugin: string;
  tool: ToolDefinition;
  permission: ToolPermissionKind;
}

/**
 * The tool registry. Everything the model can call is here, built-in and
 * third-party alike; `register` returns its own undo, so a provider's
 * registration disappears with the fiber that made it.
 */
export interface ToolRegistry {
  /** Live view — read at call time, since later plugins add tools. */
  all(): readonly ToolDefinition[];
  entries(): readonly ToolEntry[];
  find(name: string): ToolDefinition | undefined;
  /**
   * Effective permission kind for one call: the tool's own `permissionFor`
   * classifier wins over the static kind, and a broken classifier fails
   * closed (never silently downgrades to `read`).
   */
  permissionFor(name: string, args?: Record<string, unknown>): Promise<ToolPermissionKind | undefined>;
  /**
   * Register a tool; the returned undo is what an owner ties to its fiber
   * (`ctx.effect(() => registry.register(...))`). `owner` names the plugin the
   * tool belongs to — the loading adapter fills it in, so duplicate-name errors
   * and `/plugins` both name a real plugin rather than the registry.
   */
  register(tool: ToolDefinition, options?: { permission?: ToolPermissionKind; owner?: string }): () => void;
}

export const tools: ServiceKey<ToolRegistry> = key<ToolRegistry>('tools');

/* ── commands ──────────────────────────────────────────────────────────── */

export interface CommandRunContext {
  /** The workspace root the command runs against (re-read each time). */
  rootDir: string;
  log(message: string): void;
}

/** One slash command, provided by a plugin and offered by every surface. */
export interface CommandDefinition {
  /** Slash name without the leading '/'. */
  name: string;
  description: string;
  run(args: string, ctx: CommandRunContext): void | Promise<void>;
}

export interface CommandEntry {
  plugin: string;
  command: CommandDefinition;
}

export interface CommandRegistry {
  all(): readonly CommandDefinition[];
  entries(): readonly CommandEntry[];
  register(command: CommandDefinition): () => void;
}

export const commands: ServiceKey<CommandRegistry> = key<CommandRegistry>('commands');

/* ── approval ──────────────────────────────────────────────────────────── */

/**
 * The gate itself: the mode readout plus the per-call decision. The shipped
 * provider is plugins' `PermissionService`, which satisfies this shape
 * structurally — the seam costs no adapter.
 */
export interface ApprovalService extends PermissionPort {
  /**
   * Decide one call. A denial keeps the reason the user typed, so the model
   * reads the operator's actual instruction rather than a bare "denied".
   */
  decideDetailed(toolName: string, kind: ToolPermissionKind, call: ToolCall): Promise<DecideResult>;
}

export const approval: ServiceKey<ApprovalService> = key<ApprovalService>('approval');

/* ── sessions ──────────────────────────────────────────────────────────── */

/**
 * How one session is opened.
 *
 * `canAskUser` is the one per-call policy: whether a human can answer THIS
 * conversation's `ask_user_question`. It belongs here rather than on the kernel
 * because it is not derivable from the process — a bot peer created by a plugin
 * inside a browser-hosted kernel has an answerer in the process and nobody
 * watching ITS stream, and a question card published there would park the run with
 * nothing able to release it. Omitted means the assembly's own answer.
 */
export interface SessionOpenOptions {
  resumeFile?: string;
  sessionDir?: string;
  canAskUser?: () => boolean;
}

/**
 * Session lifecycle: opening, switching and creating handles. One kernel can
 * hold several (a bot channel keeps one per peer), so `current()` is what
 * everything that has to follow "the live conversation" reads.
 *
 * `get` is the OTHER half of that sentence and exists because `current()` is a
 * SELECTION, not an execution fact: with several sessions running at once, a
 * consumer holding a `ToolCallScope` must be able to reach the exact session
 * that issued a call — the approval gate reads its permission engine, the
 * `ask_user_question` tool reads its question seam, a resume path reads its
 * pending asks. Routing any of those through `current()` is how one peer's tier
 * and one peer's approval prompt ended up governing another peer's call.
 */
export interface SessionService {
  current(): AgentSession | undefined;
  /**
   * The live handle for one session id, or undefined when this kernel holds
   * none. Handles that have been disposed are not returned: a session whose
   * `dispose()` ran is finished, and handing it back would let a dead handle be
   * used as the target of a new decision.
   */
  get(sessionId: string): AgentSession | undefined;
  /** Every live handle, in creation order (diagnostics, session pickers). */
  list(): readonly AgentSession[];
  open(options?: SessionOpenOptions): Promise<AgentSession>;
  /** Re-point "current" at an existing handle (peer switch, `/session`). */
  activate(session: AgentSession): void;
}

export const sessions: ServiceKey<SessionService> = key<SessionService>('sessions');

/* ── compaction ────────────────────────────────────────────────────────── */

/**
 * The compaction strategy — the summarizer prompt, retention budget and
 * archive policy behind `/compact` and the auto thresholds. Replaceable as a
 * unit, which is the point: summarization is where the token bill is decided.
 */
export interface CompactionService {
  run(options: CompactSessionOptions): Promise<CompactedSession>;
}

export const compaction: ServiceKey<CompactionService> = key<CompactionService>('compaction');

/* ── jobs ──────────────────────────────────────────────────────────────── */

/** Background work (background bash, subagents). The registry is the seam. */
export const jobs: ServiceKey<JobRegistry> = key<JobRegistry>('jobs');

/* ── shell ─────────────────────────────────────────────────────────────── */

/**
 * The shell commands actually run in, as resolved by the plugin that runs them.
 *
 * This exists so the host never has to know WHICH plugin executes commands. The
 * context fragment tells the model what shell it is working in
 * (`shell=<name>`), and that value has to come from whoever owns shell
 * execution — otherwise the prompt and the tool disagree the moment an operator
 * points `shellPath` at a different binary, or swaps the shell plugin for
 * another one. The previous answer was the host reading the `bash` row's config
 * BY NAME, which is the coupling this seam removes.
 *
 * Optional by nature: a kernel with no shell-executing row has no provider, and
 * the consumer falls back to probing the environment.
 */
export interface ShellService {
  /** The shell's display name, e.g. `bash`, `pwsh`. */
  readonly name: string;
  /** The resolved binary path (what a terminal or a subprocess would spawn). */
  readonly path: string;
}

export const shell: ServiceKey<ShellService> = key<ShellService>('shell');

/* ── spill ─────────────────────────────────────────────────────────────── */

/**
 * Where oversized tool output goes. Only the *destination* is replaceable:
 * the truncation policy (head + hint + tail inside the byte budget) is a
 * message-format contract shared with the log projection, so it stays in core.
 */
export interface SpillService {
  /**
   * Directory for one session's spilled payloads; omit the id for the shared
   * root (that is also the trusted read root the read tool exempts from
   * approval, since the content is what the model already saw).
   */
  dir(sessionId?: string): string;
}

export const spill: ServiceKey<SpillService> = key<SpillService>('spill');

/* ── skills ────────────────────────────────────────────────────────────── */

/**
 * One discovered skill, *index only*: name, description, and which root it came
 * from. The body is deliberately absent — reading a skill is a tool call, which
 * is what keeps skills progressive instead of a boot-time context dump.
 */
export interface SkillInfo {
  name: string;
  description: string;
  source: 'project' | 'user';
}

export interface SkillRegistry {
  all(): readonly SkillInfo[];
  /** Re-scan the roots (after a workspace switch). */
  reload(): Promise<readonly SkillInfo[]>;
}

export const skills: ServiceKey<SkillRegistry> = key<SkillRegistry>('skills');

/* ── user questions ────────────────────────────────────────────────────── */

/**
 * "Can this surface ask a human?" as a service, mirroring dsh's root-level
 * `user-questions` row. The ASK TOOL reads this key at call time instead of
 * being handed an answerer (or nothing) as an assembly option, so:
 *
 *  - a surface with a person registers the provider (it owns the answerer);
 *  - a surface without one leaves the key unprovided, and the tool reports the
 *    typed `NO_PROVIDER` refusal rather than parking a run no card can release;
 *  - the three hand-copied `userQuestions: true` booleans (`kernel-boot`,
 *    `web/controller`, `surface-host`) disappear — the answer is a fact about
 *    the container, not a parameter each assembly site must remember.
 *
 * The provider is a callback, not the broker: the broker is per kernel
 * (`QuestionBroker`) while the DECISION to answer is the surface's. Reading it
 * lazily is what keeps a re-roster from stranding a captured function.
 */
export interface UserQuestionsService {
  /** The answerer, or undefined when this surface has nobody to ask. */
  answerer(): AskQuestionsFn | undefined;
}

export const userQuestions: ServiceKey<UserQuestionsService> = key<UserQuestionsService>('userQuestions');

/* ── surfaces ──────────────────────────────────────────────────────────── */

/**
 * The human-facing end, as a registry: the browser UI, the terminal UI, the bot
 * channel and the headless runners are all implementations of `AgentSurface`,
 * and whoever owns the invocation resolves which one to start by asking this
 * service rather than by an argv if-chain. A third-party surface package
 * registers here exactly like an official one.
 *
 * It is provided INTO the container by the assembly (`surfaceRegistryProvider`
 * in the plugins package), and a surface module named in config becomes a
 * plugin row whose `apply` registers itself here — the same shape every other
 * capability uses. The registry instance is built before the kernel so the
 * roster can load surfaces into the same registry the resolver will read: the
 * object precedes the container, but its PROVIDER does not, and that is what
 * makes a surface an ordinary plugin rather than a special case outside the
 * container. (The earlier revision left this key declared with no provider and
 * called that an honest seam; it was not — it was a registry living outside the
 * container, which is why a surface could not appear in `/plugins`.)
 */
export interface SurfaceRegistry {
  all(): readonly AgentSurface[];
  /** The surface that claims this invocation, in registration order. */
  resolve(request: AgentSurfaceRequest): AgentSurface | undefined;
  register(surface: AgentSurface): () => void;
  /**
   * The surface most recently returned by `resolve` — i.e. the one serving this
   * invocation. Recorded as a side effect of resolving so a consumer that only
   * has the registry (the `userQuestions` service) can answer "does the surface
   * in force have a human?" WITHOUT the resolution result being threaded through
   * the kernel assembly by hand. Undefined before the first resolve, which is
   * the correct fail-closed answer.
   */
  current(): AgentSurface | undefined;
}

export const surfaces: ServiceKey<SurfaceRegistry> = key<SurfaceRegistry>('surfaces');

/**
 * The surfaces a caller has already loaded, ready for the assembly to adopt.
 * `loaded` (not module specs) because the caller has to import the modules
 * anyway to answer "which surface claims this invocation" — that is a pure
 * predicate over argv needing no kernel. Passing the loaded objects means ONE
 * import and one identity, so `registry.current()` and a surface's plugin row
 * are the same object. `registry` is the same instance the resolver reads.
 */
export interface SurfaceRows {
  registry: SurfaceRegistry;
  loaded: readonly AgentSurface[];
}

/* ── context insights ──────────────────────────────────────────────────── */

/**
 * Reading a session's window: what it is made of right now, how it grew request
 * by request, why it changed, and what the run did to the workspace's files.
 *
 * A SERVICE rather than something a surface computes for itself, because the
 * answers cost a walk over the whole session log and are optional: the
 * `context` plugin owns this seam at the `advanced` tier, so an operator who
 * does not want the reading is not paying for it. Its presence IS the switch —
 * a consumer that finds no provider renders nothing, and there is no second
 * flag to keep in step with the roster.
 *
 * Provider usage anchors the reading where usage exists (`prompt` / `cached` /
 * `output` on each point) and the token estimate fills the gaps; a consumer
 * must never present an estimate as a bill.
 */
export const contextInsights: ServiceKey<import('../context-insights.js').ContextInsights> =
  key<import('../context-insights.js').ContextInsights>('contextInsights');

/* ── HTTP route registry ──────────────────────────────────────────────── */

/**
 * One HTTP route a plugin has registered. The handler receives the parsed URL
 * and the raw request/response and answers however it likes (a static asset,
 * a JSON payload, a redirect). The host always stands the auth gate in FRONT
 * of plugin routes — a plugin cannot expose an unauthenticated endpoint — and
 * never inspects the response, so plugin responses ride the same origin as the
 * host WebUI behind the host's cookie.
 *
 * `prefix` is matched against the request path's leading characters after the
 * leading slash (`/plugins/<name>/assets` matches every path that starts with
 * it). The first registered prefix that matches wins; the host falls through
 * to its own handlers otherwise.
 */
export interface PluginRoute {
  /** Path prefix this route answers, with a leading slash (e.g. `/plugins/genui/assets`). */
  prefix: string;
  /** Handler invoked when the prefix matches. */
  handler: PluginRouteHandler;
}

/** A route handler answers one HTTP request. */
export type PluginRouteHandler = (
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: URL,
) => Promise<void>;

/**
 * The route-registry service a host (the WebUI server today) publishes for
 * plugins to extend. Plugins register prefixes from their `apply(ctx)`; the
 * host queries the registry on each request before falling back to its own
 * handlers. A kernel without a host (exec / qqbot today) does not provide it,
 * so plugins that ship UI capabilities degrade gracefully when run headless.
 */
export interface RouteRegistry {
  /**
   * Append one route. Routes added later in the roster take precedence.
   * @returns a disposer that removes exactly this registration (by identity).
   *   Plugins MUST hook it to their own lifetime — `ctx.effect(disposer)` — so
   *   unloading the plugin retires its routes and their closures; a plugin
   *   that reloads would otherwise stack same-prefix overrides whose handlers
   *   outlive the fiber that created them.
   */
  register(route: PluginRoute): () => void;
  /** All currently-registered routes, in registration order. */
  routes(): readonly PluginRoute[];
  /**
   * Resolve a handler for one request path. Returns the FIRST matching route
   * searching REVERSE registration order, so a plugin loaded later overrides
   * an earlier plugin's prefix. `undefined` means "no plugin answered" — the
   * caller falls through to its own handlers.
   */
  handlerFor?(pathname: string): PluginRouteHandler | undefined;
}

export const routes: ServiceKey<RouteRegistry> = key<RouteRegistry>('routes');

/* ── lifecycle events ──────────────────────────────────────────────────── */

/**
 * Wrap the outgoing request (system prompt, tools, messages). **Waterfall**:
 * call `next()` to delegate and return your own rewritten request, or return
 * `undefined` to pass the delegated answer through unchanged.
 *
 * The tool set may be narrowed (PTC projection does it) or left alone, but
 * never widened: the tool array is part of the cached prefix and of what the
 * model is allowed to call, so a hook adding tools fails the request instead
 * of silently expanding the model's reach.
 */
export const beforeLlmCall: EventKey<[ChatRequest], ChatRequest | undefined> = event('llm/before');

/**
 * Decide one tool call. **Serial, first decisive verdict wins**: the approval
 * gate answers first (highest priority), then each hook may return
 * `{action:'deny'}` or `{action:'rewrite', args}`. Returning `undefined` passes.
 *
 * A `rewrite` ends the chain: the rewritten call is not re-approved, which is
 * why rewriting is operator-level trust (the hook runs as the operator, not as
 * the model).
 *
 * The second payload member is the call's `ToolCallScope` — WHICH run issued it
 * — and it exists because several sessions run concurrently in one kernel. A
 * listener that decides something session-specific (the approval gate reading a
 * tier) must read it from here; a process-global "current session" is a UI
 * selection and would let one peer's tier govern another's call.
 */
export const beforeToolCall: EventKey<[ToolCall, ToolCallScope], ToolCallVerdict | undefined> = event('tool/before');

/**
 * Transform a tool result on its way into the log. **Waterfall**: `next()` runs
 * the rest of the chain and returns the transformed result, which the wrapper
 * may then adjust further.
 */
export const afterToolResult: EventKey<[ToolCall, string], string | undefined> = event('tool/after');

/**
 * Decide whether the run should continue past its natural end (an assistant
 * turn with no tool calls). **Serial, first decisive verdict wins**: the first
 * hook that returns `{ action: 'steer', message }` injects its message and
 * forces another turn; `{ action: 'stop' }` and `undefined` pass.
 *
 * Fired ONLY at the natural end — not on `max_turns`, abort, or any
 * programmatic stop — so a plugin repairing the model's last output (a genui
 * fence the host rejected) gets exactly one chance per natural end. A quota
 * guard in the loop (`turn < maxTurns`) caps runaway steering.
 */
export const beforeTurnEnd: EventKey<[BeforeTurnEndContext], BeforeTurnEndVerdict | undefined> = event('turn/before-end');