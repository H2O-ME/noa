/**
 * `noa`：无人值守 QQ 机器人形态的 surface。
 *
 * **通道不在这里建**。它随 `@noa/channel-qq` 那一行插件一起启停（见 `plugin.ts`）：
 * 行开着才有 socket，关掉即收走。这个 surface 因此只剩两件事——认领 `qqbot` 这个
 * 子命令（argv 形状必须在 cli 侧同步可答），以及常驻。
 *
 * 常驻前先问一次通道在不在（`runningQqBotChannel`）：行没开或凭据没填时，干等是一个
 * **无法诊断**的挂起，而那句原因正是操作者要的下一步。这也让这个 surface 不假称自己
 * 拥有通道：它只是「谁在服务这次 argv」的答案。
 *
 * 审批策略钉 `never`（与 `exec` 同款，确定性拒绝）：无人值守的进程里，远端 QQ 对端
 * 不该成为提权入口。桌面那边（`nova --web`）不钉——那里有人，对端的 `/approve`
 * 可以照常被转发。
 */
import type { AgentSurface, AgentSurfaceRuntime } from '@noa/core';
import { runningQqBotAccess, runningQqBotChannel } from '../plugin.js';

export const qqbotSurface: AgentSurface = {
  name: 'qqbot',
  claim: (request) => request.flags.positional[0] === 'qqbot',
  start: async (runtime: AgentSurfaceRuntime): Promise<void> => {
    const channel = runningQqBotChannel();
    if (channel === undefined) {
      throw new Error(
        'QQ 机器人通道未启动：请在插件管理里打开 @noa/channel-qq 这一行'
          + '（配置文件的 plugins.entries），并在它的 config 里填写 appId 与 clientSecret'
          + '（密钥可用 {env:NAME} 引用）。',
      );
    }
    // No human at this end: sees the read-only tools, everything else refused
    // before it is even asked. The peer can still change its own tier with
    // /perm, which is a tier the gate holds — not a bypass of the policy.
    runtime.kernel.agent.setApprovalPolicy('never');
    console.log('[qqbot] 通道已随插件启动：QQ 对话各自绑定一段持久会话 · 审批 never（read-only 只读工具可用）· Ctrl+C 退出');
    // The enrollment secret goes to the CONSOLE, because this is the headless
    // deployment: there is no settings page here, so without this line an operator
    // could never bind their phone — the plugin has no other way to reach them.
    // Printed once at startup rather than on every message, and never in a reply.
    const access = runningQqBotAccess();
    if (access !== undefined) {
      const owners = access.owners();
      if (owners.length === 0) {
        const code = access.pairingCode();
        console.log(
          code === undefined
            ? '[qqbot] 还没有绑定任何 QQ 号，且没有配置配对码；在插件行的 config 里设置 pairingCode 后重启即可入网。'
            : `[qqbot] 还没有绑定任何 QQ 号。用手机 QQ 私聊本机器人发送：/pair ${code}`,
        );
      } else {
        console.log(`[qqbot] 已绑定 ${owners.length} 个 QQ 号；新增设备请在设置页或 config 里换新配对码。`);
      }
    }
    // Shutdown goes through the kernel's own teardown, not through a stop() this
    // surface remembers to call: disposing the host unwinds the plugin fibers,
    // and the channel's effect closes the socket on the way out.
    const shutdown = (): void => {
      void runtime.kernel.dispose().finally(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // 常驻：socket 自己持有事件循环，这个等待只是「这个 surface 不结束」。
    await new Promise<never>(() => undefined);
  },
};
