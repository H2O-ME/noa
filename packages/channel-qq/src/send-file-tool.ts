/**
 * `qq_send_file`：把本地文件发到**本会话所在的 QQ 对话**。
 *
 * 从 `plugin.ts` 拆出，因为它是另一件事：那边是这一行的装配与生命周期，这里只有
 * 「模型怎么把一张图发回给它正在服务的那个人」。
 *
 * 为什么需要它：模型说的话自己会回去（`PeerTurns.run` 返回答案、回复座位发出去），
 * 但**文件不会**——agent 刚产出的截图只有被上传才到得了对方，而没有这个工具时模型
 * 唯一的动作是 `bash`/`open`，那是把图打开在**桌面上**给一个拿着手机的人看。
 *
 * 目标不由模型指定：`path` 之外没有第二个参数，发到哪由「当前会话属于哪个 QQ 对话」
 * 决定（`sendFileToCurrentConversation`）。所以这不是回到「能对任意对端发消息」的旧
 * 工具——那种工具的问题（`peerId` 从没告诉过模型）在这里依然不存在。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { registerTool, type Context } from '@noa/core';

export interface SendFileToolOptions {
  /** 实际发送：由插件接上 outbox（窗口规则、配额、回落都在那边）。 */
  send: (file: { path: string; caption?: string }) => Promise<string>;
  /** 本进程的工作区，用来判断这次读取是否越界。 */
  rootDir: () => string;
}

/** 注册这一个工具（owner = 本插件 fiber，随行卸载一起消失）。 */
export function registerSendFileTool(ctx: Context, options: SendFileToolOptions): void {
  registerTool(
    ctx,
    {
      name: 'qq_send_file',
      description:
        'Send a LOCAL file (image/video/audio/document) to the QQ chat this conversation belongs to. Use this when the user asked to be sent a picture or file over QQ — do NOT use bash/open for that. Args: path (required, absolute or workspace-relative), caption (optional text shown with the file).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Local file path, workspace-relative or absolute.' },
          caption: { type: 'string', description: 'Optional text sent together with the file.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      /** 工作区内的文件是 agent 自己产出的：读取免费；越界读取才过审批门。 */
      permissionFor(args: Record<string, unknown>) {
        const raw = typeof args['path'] === 'string' ? args['path'] : '';
        const root = options.rootDir();
        const abs = path.resolve(root, raw);
        return root.length > 0 && (abs === root || abs.startsWith(root + path.sep)) ? 'read' : 'read-external';
      },
      async execute(args: Record<string, unknown>) {
        const filePath = typeof args['path'] === 'string' ? args['path'] : '';
        const caption = typeof args['caption'] === 'string' ? args['caption'] : '';
        if (filePath.length === 0) return '没有给出文件路径，未发送。';
        if (!existsSync(filePath)) return `本地没有这个文件：${filePath}（未发送）。`;
        return await options.send({ path: filePath, caption });
      },
    },
    'read-external',
  );
}
