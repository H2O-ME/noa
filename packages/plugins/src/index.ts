/**
 * The plugin world: the container-backed tool host, the built-in plugins, the
 * kernel assembly, and the capability providers that fill the seams.
 *
 * ONE plugin shape is public here: core's `Plugin`
 * (`{ name, manifest?, Config?, inject?, apply(ctx, config) }`), loaded onto a
 * `Context` by core's `PluginLoader`. Built-ins, optional packages and third
 * parties write against exactly the same contract — a plugin declares its own
 * row (manifest), its own config schema and the services it injects, so adding
 * one is never a change to this package.
 */
export * from './permission.js';
export * from './host.js';
export * from './toolbox.js';
export * from './hooks.js';
export * from './services.js';
export * from './plugin-services.js';
export * from './plugin-tree.js';
export { resolveModuleSpec, resolvableFromProduct } from './module-spec.js';
export * from './surface-registry.js';
export * from './headless-compact.js';
export * from './builtin/index.js';
export * from './runtime.js';
export * from './runtime-env.js';
export * from './runtime-facade.js';
export * from './kernel-commands.js';
export * from './runtime-models.js';
export * from './runtime-roster.js';
export * from './runtime-switch.js';
export * from './runtime-session.js';
export * from './agents-md.js';
export * from './agents-md-init.js';
export * from './system-prompt.js';
export { resolveInRoot, READ_MAX_BYTES } from './builtin/fs.js';
export { startBashJob } from './builtin/bash.js';
export {
  bashOnPath,
  commandInvocation,
  findExecutable,
  modelShell,
  panelShell,
  ptyInvocation,
  shellCandidates,
  shellFamily,
  shellName,
  POWERSHELL_UTF8_PREFIX,
} from './builtin/shell-select.js';
export type { ShellCandidate, ShellFamily } from './builtin/shell-select.js';
export type { BashJobRequest } from './builtin/bash.js';
export * from './skills.js';
