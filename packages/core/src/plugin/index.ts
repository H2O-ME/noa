/**
 * The plugin framework: services, fibers, effects and typed events.
 *
 * Everything in NovaAgent — the model client, the tool registry, the session
 * log, compaction, jobs, approvals, the surfaces themselves — is a plugin
 * loaded onto a `Context`. There is no privileged core to patch: a plugin that
 * replaces `llm` or `sessions` changes the product, and a plugin that reads
 * them is reloaded when its provider is swapped.
 *
 * ```ts
 * const root = Context.createRoot();
 * await root.plugin(llmPlugin, { baseURL, model });
 * await root.plugin(fsToolPlugin);
 * const missing = root.unsatisfied();   // embedder-side boot check: declared-but-absent
 *                                       // (the kernel assembles do not call this)
 * ```
 */
export { Context } from './context.js';
export { registerCommand, registerTool } from './registration.js';
export { objectConfig, type ConfigFieldSpec, type ConfigFieldType } from './schema.js';
export {
  type PluginPageDescriptor,
  type PluginSettingAction,
  type PluginSettingField,
  type PluginSettingStatus,
} from './settings-page.js';
export { Fiber, type FiberState, type Runtime } from './fiber.js';
export { PluginLoader, type PluginEntry, type PluginEntryOptions } from './loader.js';
export { EventRegistry, event, isBailed, type EventKey, type Listener, type Next, type OnOptions } from './events.js';
export {
  ServiceStore,
  ServiceUnavailable,
  type InterceptMap,
  type ServiceImpl,
  type ServiceInterceptor,
} from './store.js';
export {
  enabledByDefault,
  isRequiredTier,
  key,
  manifestOf,
  pluginName,
  resolvePlugin,
  rowEnabled,
  type AnyPlugin,
  type AnyServiceKey,
  type Awaitable,
  type ConfigSchema,
  type Dispose,
  type Plugin,
  type PluginBase,
  type PluginClientBundle,
  type PluginConstructor,
  type PluginFunction,
  type PluginManifest,
  type PluginObject,
  type PluginSwitch,
  type PluginTier,
  type ResolvedPlugin,
  type ServiceKey,
  type ServiceOf,
} from './types.js';
export {
  afterToolResult,
  approval,
  beforeLlmCall,
  beforeToolCall,
  beforeTurnEnd,
  commands,
  compaction,
  contextInsights,
  executionEnvironment,
  jobs,
  llm,
  loader,
  pluginConfig,
  pluginRpc,
  routes,
  sessions,
  shell,
  skills,
  spill,
  surfaces,
  tools,
  userQuestions,
  type ApprovalService,
  type CommandDefinition,
  type CommandEntry,
  type CommandRegistry,
  type CommandRunContext,
  type CompactionService,
  type ExecutionEnvironment,
  type LlmService,
  type PluginConfigPort,
  type PluginRoute,
  type PluginRouteHandler,
  type PluginRpc,
  type RouteRegistry,
  type ShellService,
  type SessionOpenOptions,
  type SessionService,
  type SkillInfo,
  type SkillRegistry,
  type SpillService,
  type SurfaceRegistry,
  type SurfaceRows,
  type ToolEntry,
  type ToolRegistry,
  type UserQuestionsService,
} from './capabilities.js';
