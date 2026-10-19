/**
 * 这份部署**真的**注册了哪些工具——按 app 的形状装配一次内核，然后读模型实际收到的
 * 那张工具表。
 *
 * 存在的理由是一条实测过的故障：提示词曾经手写一份工具清单，无条件宣称
 * `run_code` / `subagent` / `skill` / `switch_workspace` 可用，而它们一个都没注册——
 * 模型据此对用户承诺能力，然后连吃四个 unknown tool。后来的修法是把清单拆成「无条件
 * 注册」与「可能有」两段，并在 `prompt.test.ts` 里钉住文本形状。
 *
 * 但文本形状只是**声明**。这个文件钉的是声明与装配之间那条缝：`NOA_TOOLS` 第一节点名
 * 的工具必须真的在表里，而第二节里凡是这个产品永远装不上的，就不该出现在那里。
 * 一次真的装配是唯一能回答这件事的方式——两个手写清单互相对照只会一起漂。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatProvider, ChatRequest } from '@noa/core';
import { describe, expect, it } from 'vitest';
import { bootKernel } from '../src/boot.js';
import { starterConfig } from '../src/channel-row.js';
import { loadConfig } from '../src/config.js';
import { NOA_TOOLS } from '../src/prompt.js';

/** 记录每次请求的工具表，然后回一句短文本让这一轮自然结束。 */
function capturingProvider(requests: ChatRequest[]): ChatProvider {
  return {
    model: 'fake',
    async *stream(req: ChatRequest) {
      requests.push(req);
      yield { type: 'text_delta' as const, text: 'ok' };
    },
  };
}

/**
 * 按 `noa init` 写下的那份起始配置装配一次内核，返回模型实际收到的工具名。
 *
 * 通道行的凭据留空（起始文件就是空的），所以这里不会拨 QQ 网关——而
 * `registerSendFileTool` 在凭据检查之后，因此 `qq_send_file` 也不在表里。这正是
 * 「真机上装了凭据才会有的那个工具」的诚实读法，不是测试的取巧。
 */
async function toolNamesAtBoot(): Promise<string[]> {
  const home = await mkdtemp(path.join(tmpdir(), 'noa-roster-home-'));
  const workspace = await mkdtemp(path.join(tmpdir(), 'noa-roster-ws-'));
  const dir = path.join(home, '.noa');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'config.json'),
    `${JSON.stringify(starterConfig(workspace), null, 2)}\n`,
    'utf8',
  );
  const requests: ChatRequest[] = [];
  const kernel = await bootKernel({
    rootDir: workspace,
    config: await loadConfig(home),
    provider: capturingProvider(requests),
    homedir: home,
    onNotice: () => undefined,
  });
  try {
    const idle = new Promise<void>((resolve) => {
      const unsubscribe = kernel.agent.subscribe((event) => {
        if (event.type === 'phase' && event.phase === 'idle') {
          unsubscribe();
          resolve();
        }
      });
    });
    await kernel.agent.prompt('hi');
    await idle;
    const tools = requests.at(-1)?.tools ?? [];
    return tools.map((tool) => tool.name).sort();
  } finally {
    await kernel.dispose();
    // 一次装配会落会话文件与记忆索引；测试不该把临时 home 留在 %TEMP% 里。
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

/**
 * 从提示词第一节里取出它点名「无条件可用」的工具名。
 *
 * 只取**条目行**（`- \`name\` …`），并在每个条目里的第一个 ` Not ` 处截断——那条
 * 从句说的是「不要用 `cat` / `ls` 代替 `read_file`」，那些名字是反例不是工具。手抄
 * 第二份清单会跟着漂，所以这里从文本里取。
 */
function claimedAvailableTools(): string[] {
  const available = NOA_TOOLS.slice(0, NOA_TOOLS.indexOf('MAY also carry'));
  const bullets = available.match(/^- .*$/gm) ?? [];
  const names = new Set<string>();
  for (const bullet of bullets) {
    const head = bullet.split(' Not ')[0] ?? bullet;
    for (const match of head.matchAll(/`([a-z_]+)`/g)) names.add(match[1]!);
  }
  return [...names];
}

describe('the tools this deployment really registers', () => {
  it('registers every tool the prompt names as unconditionally available', async () => {
    const names = await toolNamesAtBoot();
    const claimed = claimedAvailableTools();
    // 取法本身要有效：少于十条说明解析规则坏了，而不是提示词变短了。
    expect(claimed.length).toBeGreaterThanOrEqual(11);
    for (const name of claimed) {
      expect(names, `提示词说 ${name} 可用，但装配出来的表里没有它`).toContain(name);
    }
  });

  it('never registers switch_workspace, and the prompt no longer offers it', async () => {
    // `bootKernel` 从不传 `workspace: { onChange }`，所以这个工具在本产品里永远不注册
    // ——工作区是启动时定死的（配置的 `workspace` / `--workspace`）。提示词里曾经列着
    // 它，那是第二个「点名却没装配」的清单条目。
    const names = await toolNamesAtBoot();
    expect(names).not.toContain('switch_workspace');
    expect(NOA_TOOLS).not.toContain('switch_workspace');
  });

  it('does register the goal tools, so naming them in the prompt is not a phantom', async () => {
    // `goal` 由 `kernelPlugins` 内部接线（不是 `CreateKernelOptions` 的一个字段），
    // 所以它无条件注册——与 `switch_workspace` 的区别就在这里，值得钉住：
    // 两个看起来同类的名字，一个是真工具，一个是空承诺。
    const names = await toolNamesAtBoot();
    expect(names).toContain('create_goal');
    expect(names).toContain('update_goal');
    // 记忆插件在起始配置里默认开，所以它的两个工具也真的在。
    expect(names).toContain('memory');
    expect(names).toContain('recall');
  });

  it('leaves the advanced-tier tools out until their rows are enabled', async () => {
    // ptc / subagent 是 advanced 档，起始配置没开；工作区里也没有 skills 目录。
    // 这三个名字留在「可能有」那一节是对的——它们取决于操作者，不取决于这份代码。
    const names = await toolNamesAtBoot();
    for (const name of ['run_code', 'subagent', 'skill']) {
      expect(names).not.toContain(name);
    }
  });
});
