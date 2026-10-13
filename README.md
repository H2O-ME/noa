# Noa

> **Nova − v（View）= Noa。**
>
> NovaAgent 有浏览器 UI 与终端视图；这个项目恰好剥离了所有视图层，只留下**纯粹的内核与远端消息通道**。同一个名字也自然读作 **Nova On Air**（云端常驻的 Nova）或 **Node Open Agent**。

一个**常驻云端的通用 agent 运行时**，以 QQ 官方机器人为入口：在服务器上跑一个进程，把 QQ 私聊 / 群聊当成对话通道，每个对端绑定一段**跨重启存活的持久会话**，由任意 OpenAI 兼容端点驱动模型。

- **是**：无人值守（unattended）的 agent 进程。没有浏览器界面，没有终端 UI，只有消息通道。典型部署是**无 GUI 的云服务器**，或**用手机遥控**一台常开的机器。
- **不是**：聊天应用、编程专用 IDE，也不是某个模型的套壳——内核与通道解耦，换端点 / 换模型只改一行配置。

与 OpenClaw / Hermes 的相似处：云端常驻、以 IM 通道为入口、通用任务 agent、多设备接入。不同处：内核是自研的**插件化容器**（服务键 / 事件键 / 贡献点），通道只是其中一个插件；同一内核事件流可以长出别的 surface（本地项目 NovaAgent 的浏览器 UI / REPL / headless 三种形态与它同源），「通道」与「内核」是彻底分开的两层。

## 快速开始

```bash
pnpm install
pnpm build

noa init                 # 写入 ~/.noa/config.json 起始配置（已存在时不覆盖）
# 填好 provider.baseURL / apiKey / model 与通道行的 appId / clientSecret
noa --check              # 只做启动检查：装配内核、按通道行真实状态报告，然后退出
noa                      # 启动常驻机器人
```

首次入网：手机 QQ 私聊机器人发送 `/pair <pairingCode>`（配对码在通道行的 `config` 里，启动时会打印到控制台）。

## 架构

pnpm workspace，8 个包，依赖严格单向：

| 包 | 职责 |
| --- | --- |
| `@noa/core` | 内核：agent 循环、消息模型、会话持久化、插件容器（**零上游依赖**） |
| `@noa/ai` | OpenAI 兼容流式客户端（手写 fetch + SSE，含重试与用量提取） |
| `@noa/plugins` | 能力插件 + 内核装配单点 `createAgentKernel()` |
| `@noa/plugin-subagent` / `plugin-context` / `plugin-ptc` | 三个扩展插件包，按 spec **动态装载**（包缺席只坏一行） |
| `@noa/channel-qq` | QQ 官方机器人通道（WebSocket 网关 + REST 被动回复） |
| `@noa/app` | 应用壳：配置、内核装配、常驻宿主、`noa` 可执行入口 |

- **一切皆插件**：`plugins.entries[] = { id, enabled, config }` 是唯一开关，一行就是一个插件；行的 `config` 由**该插件自己的 schema** 校验，宿主不认识任何插件名。
- **单一装配点**：`createAgentKernel()`，壳只负责 argv / 配置 / 生命周期。
- **数据全在 `~/.noa/`**（`config.json` / `sessions/` / `plugins/` / `cache/`），**工作区目录零写入**。

## 配置

`~/.noa/config.json`，严格 schema（未知键加载即报错）：

```jsonc
{
  "provider": { "baseURL": "https://…/v1", "apiKey": "{env:MY_KEY}", "model": "…" },
  "approval": "read-only",
  "workspace": "/srv/work",
  "plugins": {
    "entries": [
      {
        "id": "@noa/channel-qq",
        "enabled": true,
        "config": { "appId": "…", "clientSecret": "…", "pairingCode": "…", "maxTier": "read-only" }
      }
    ]
  }
}
```

`{env:NAME}` 按**归属**展开：核心段（`provider`）的未解析引用拦住启动，插件行里的降级成诊断——某个插件的密钥没设置，不会把整个产品拖下水。

## 命令

| 命令 | 说明 |
| --- | --- |
| `noa` | 启动常驻机器人（读 `~/.noa/config.json`） |
| `noa init` | 写入起始配置；已存在时不覆盖 |
| `noa --check` | 只做启动检查，按通道行的真实状态报告后退出 |
| `noa --check --json` | 同上，JSON 输出（给 systemd / 服务管理器读） |
| `--workspace <dir>` | 指定工作区（覆盖配置里的 `workspace`） |

## 通道能力

- **身份授权**：入网口令长期有效、可多设备先后入网；未绑定者的消息**既不进模型也不建会话**；权限上限 `maxTier` 默认 `read-only`，对端可用 `/perm` 调低、不能调高。
- **持久会话绑定**：`peerId → 会话文件` 落盘，重启续接；会话接力 `/sessions` `/use` `/unbind`。
- **无人值守审批**：审批固定 `never`；提问推到聊天窗，对端用 `/answer` 作答、`/stop` 解阻塞。
- **出站账本（outbox）**：结论走「回复预留」额度、旁白吃更低额度——配额耗尽也**绝不吞掉结论**。
- **富交互**：markdown、按钮、审批卡、富媒体（图片 / 文件分片上传）。
- **斜杠命令**：复用内核命令目录（与本地 NovaAgent 的命令 runner 同一实现），插件注册的命令无需重启即可用。

## 开发

```bash
pnpm build        # 全量构建（tsdown）
pnpm typecheck    # 逐包类型检查（改了底层包要先 build）
pnpm test         # vitest run
pnpm check        # lint + typecheck + --changed 测试（开发快环）
pnpm dev          # tsx 直跑 app 源码（免构建调试）
```

TypeScript strict（`noUncheckedIndexedAccess`）、ESM-only；构建 tsdown、测试 vitest、lint oxlint、包管理 pnpm。运行时零第三方依赖（zod 仅用于配置校验）。
