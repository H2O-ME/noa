import {
  createSubagentTool,
  executionEnvironment as executionEnvironmentKey,
  tools as toolsKey,
  type Plugin,
} from '@noa/core';
import { registerTool } from '@noa/core';

/**
 * `subagent` — isolated delegation, as an ORDINARY plugin.
 *
 * The tool it registers comes from core (`createSubagentTool`); what this module
 * owns is the wiring. That wiring used to be the HOST's business: the roster
 * called `subagentPlugin({ provider, tools, hooks, … })`, so the kernel knew this
 * package by name and had to be edited to change it. Now the plugin declares the
 * `execution-environment` service in `inject` and reads it, exactly like any
 * third-party package would — which is what "no special cases" means in code.
 *
 * Ships OFF (`advanced`): a fresh install has no delegation, and the operator
 * turns it on in 插件管理 (or writes its entry).
 */
const plugin: Plugin = {
  name: '@noa/plugin-subagent',
  description: 'Isolated subagent runs for self-contained subtasks.',
  manifest: {
    title: '子代理',
    description: '把自成一体的子任务交给一个隔离的子代理执行，父代理只看结果。',
    tier: 'advanced',
  },
  inject: [executionEnvironmentKey, toolsKey],
  apply: (ctx) => {
    const env = ctx.must(executionEnvironmentKey);
    const tool = createSubagentTool({
      provider: env.provider,
      tools: env.tools,
      hooks: env.hooks,
      systemPrompt: env.systemPrompt,
      rootDir: env.rootDir,
      ...(env.maxTurns !== undefined ? { maxTurns: env.maxTurns } : {}),
      onProgress: env.onSubagentProgress,
    });
    // 'read', not 'execute': a delegation is not itself the side effect. Every
    // consequence is a nested tool call, and those pass this same gate one by one
    // (the nested loop reuses the parent's `hooks` chain). Gating the call asked
    // the wrong question — "run subagent?" instead of the concrete `bash` inside
    // it — and made the read-only recon fan-out, the tool's main use, unstartable
    // by default. The reference declares no permission on its subagent tool
    // either; it pins the CHILD policy to 'never' instead.
    registerTool(ctx, tool, 'read');
  },
};

export default plugin;
export { plugin };
