/**
 * User-facing console copy — the ONE place this product's Chinese strings live.
 *
 * Kept apart from the code that prints them so the wording can be reviewed as
 * wording (and translated) without reading control flow, and so no message is
 * assembled twice with slightly different words.
 */
import { CHANNEL_ROW_ID } from './channel-row.js';

/** The startup banner: what is running, where its data is, what it will do. */
export function bannerLines(info: {
  version: string;
  dataDir: string;
  configPath: string;
  workspace: string;
  model: string;
  approval: string;
}): string[] {
  return [
    `Noa v${info.version} — QQ 机器人（agent 常驻进程）`,
    `  数据目录  ${info.dataDir}`,
    `  配置文件  ${info.configPath}`,
    `  工作区    ${info.workspace}`,
    `  模型      ${info.model === '' ? '(未命名)' : info.model}`,
    `  审批档位  ${info.approval}（auto=智能审批，full=全放行；对端可用 /perm 切换）`,
  ];
}

/** The channel is live: what the operator can do next. */
export const CHANNEL_LIVE =
  'QQ 通道已启动：每个 QQ 对话各自绑定一段持久会话，回复走平台的被动回复窗口。Ctrl+C 退出。';

/**
 * The deprecated-key notes were more than a report: the file has been rewritten.
 *
 * Said out loud because a start-up that edits the operator's own config without
 * mentioning it is the kind of surprise that makes someone distrust the file.
 */
export const CONFIG_HEALED = '提示：上面的废弃键已按当前形状重写回配置文件，之后启动不再提示。';

/**
 * Three causes, three next actions — merging them into one hint is the bug.
 *
 * The parameter type is the three kinds that HAVE a refusal; the fourth row
 * state (`active`) means the row is fine and the channel's own credential check
 * decides, so passing it here is a type error rather than a "未知状态" string.
 */
export function channelRefusal(
  state: { kind: 'absent' } | { kind: 'off' } | { kind: 'failed'; error: string },
): string {
  switch (state.kind) {
    case 'absent':
      return `QQ 通道未启动：配置文件的 plugins.entries 里没有「${CHANNEL_ROW_ID}」这一行，这个包不会因此被加载。`
        + `运行 \`noa init\` 写入一份起始配置，或手工加上这一行（id 为 ${CHANNEL_ROW_ID}，enabled: true），`
        + '并在它的 config 里填写 appId 与 clientSecret。';
    case 'off':
      return `QQ 通道未启动：「${CHANNEL_ROW_ID}」这一行在 plugins.entries 里，但它是关着的（enabled: false）——`
        + '关着的行不建 socket。把这一行改成 enabled: true 后重启。';
    case 'failed':
      return `QQ 通道未启动：「${CHANNEL_ROW_ID}」这一行开着，但它没能加载——${state.error}。`
        + '这不是「没开」：请按上面的原因修好加载（模块装不上就重装依赖，config 校验失败就按点到的键改配置）。';
  }
}

/** The row loaded and is on, but no channel is running: the credentials are missing. */
export function credentialRefusal(): string {
  return `QQ 通道未启动：「${CHANNEL_ROW_ID}」这一行已打开且加载成功，但通道没有起来——`
    + '它的 config 里 appId / clientSecret 还没填，或引用的 {env:NAME} 没有设置。'
    + '填好后重启；凭据被网关拒绝时，原因会打印在这条日志的下一行。';
}

/** `--help`: the whole surface of the command, in the order a person needs it. */
export function helpText(): string {
  return `Noa — QQ 机器人（agent 常驻进程）

用法：
  noa                  启动常驻机器人（读 ~/.noa/config.json）
  noa init             写入一份起始配置；已存在时不覆盖
  noa --check          只做启动检查：装配内核、按通道行的真实状态报告，然后退出
  noa --check --json   同上，输出 JSON（给 systemd / 服务管理器读）

选项：
  --workspace <dir>   指定工作区（覆盖配置里的 workspace）
  -h, --help          显示本帮助
  -v, --version       显示版本

配置与数据都在 ~/.noa/ 下；工作区目录零写入。`;
}
