/**
 * The `Kernel` façade: the same object every surface drives.
 *
 * It is deliberately thin — it reads live services out of the container rather
 * than holding copies, so a rebuilt roster, a swapped provider or a new current
 * session is visible immediately and nothing here can go stale. `roster()` is
 * the traceability surface: `/plugins` prints it, and a capability that failed
 * to load is visible there instead of at the first tool call.
 */
import {
  jobs as jobsKey,
  llm as llmKey,
  pluginRpc as pluginRpcKey,
  sessions as sessionsKey,
  type AgentHooks,
  type AgentSession,
  type ModelCatalogPort,
} from '@noa/core';
import type { PluginHost } from './host.js';
import type { SkillMetadata } from './skills.js';
import type { Environment } from './runtime-env.js';
import { jobListener } from './job-listener.js';
import { commandRunner } from './kernel-commands.js';
import { modelControl } from './runtime-models.js';
import { setWorkspace } from './runtime-workspace.js';
import type { Kernel } from './runtime-types.js';

export function facade(env: Environment, modelCatalog?: ModelCatalogPort): Kernel {
  const host = (): PluginHost => {
    if (env.state.host === undefined) throw new Error('kernel has no active tool host');
    return env.state.host;
  };
  // Built once: the control reads everything else live through the env, so a
  // workspace rebuild or a session switch cannot leave it holding a stale
  // collaborator.
  const models = modelCatalog === undefined ? undefined : modelControl(env, modelCatalog);
  const commands = commandRunner(env);
  return {
    get agent(): AgentSession {
      const current = env.root.get(sessionsKey)?.current();
      if (current === undefined) throw new Error('kernel has no active session');
      return current;
    },
    get hooks(): AgentHooks {
      return env.hooks();
    },
    get host(): PluginHost {
      return host();
    },
    get llm() {
      return env.root.must(llmKey);
    },
    ...(models !== undefined ? { models } : {}),
    get commands() {
      return commands.catalog();
    },
    runCommand: commands.run,
    /**
     * The permission engine of the conversation in force: `mode` is per session
     * (so `/perm` changes the tier the operator is looking at, not everybody's),
     * while `policy` rides the shared process-wide cell, so a headless runner's
     * `setPolicy('never')` still binds every session through this accessor.
     */
    get permission() {
      return env.root.get(sessionsKey)?.current()?.permission ?? env.permission;
    },
    /**
     * The process's default tier for NEW sessions, read live off the env: a
     * surface writes it (`set_approval_mode`) and EVERY surface's next session
     * starts there — browser, qqbot, exec alike. Living on the env rather than
     * in the web controller is the fix for a default the chat channel never saw.
     */
    get approvalDefault() {
      return env.approvalDefault;
    },
    setApprovalDefault: (mode) => {
      env.approvalDefault = mode;
    },
    get jobs() {
      return env.root.must(jobsKey);
    },
    get skills(): SkillMetadata[] {
      return env.state.skills;
    },
    get allSkills(): SkillMetadata[] {
      return env.state.allSkills;
    },
    get disabled(): { plugins: readonly string[]; skills: readonly string[] } {
      return {
        plugins: env.state.rows.filter((row) => !row.enabled).map((row) => row.id),
        skills: env.state.skillsDisable,
      };
    },
    systemPrompt: env.systemPrompt,
    rootDir: () => env.state.rootDir,
    sessionEnv: () => env.sessionEnv(),
    buildFragment: env.buildFragment,
    pluginConfig: (id) => env.state.rows.find((row) => row.id === id)?.config,
    pluginRpc: () => env.root.get(pluginRpcKey),
    newAgentSession: (sessionOpts) => env.openCurrent(sessionOpts),
    activateSession: (agent) => {
      env.root.must(sessionsKey).activate(agent);
      env.root.must(jobsKey).setListener(jobListener(env));
    },
    roster: () => env.describePlugins(),
    setPluginEnabled: (name, enabled) => env.setPluginEnabled(name, enabled),
    setSkillEnabled: (name, enabled) => env.setSkillEnabled(name, enabled),
    setWorkspace: (dir) => setWorkspace(env, dir),
    dispose: () => host().dispose(),
  };
}