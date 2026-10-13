/**
 * 富消息（markdown + 按钮 + 媒体）的纯构造层。
 *
 * 从 `protocol.ts` 拆出，因为那边的 `QqApi` 回答「怎么把一个请求体发出去并核对回执」，
 * 这里回答「一条富回复长成哪些请求体」——纯函数、无 IO，平台字段的变化只落在这一份。
 * 官方约束：自定义 markdown 单/群聊全量开放；keyboard 挂在同一条 `msg_type 2` 消息上；
 * 媒体是 `msg_type 7`，`file_info` 由 `/files` 预上传取得（单/群互相独立）。
 */

/** 超长文本分片（官方 textChunkLimit 语义：单条上限，超出切片发送）。 */
export function chunkText(text: string, limit = 4500): string[] {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`qqbot: chunkText limit must be a positive integer (got ${String(limit)})`);
  }
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit));
  return chunks;
}

/** 一个按钮：指令按钮（点击即以用户身份发出 `data`）、跳转链接或回调（`INTERACTION_CREATE`）。 */
export interface QqButton {
  label: string;
  kind: 'command' | 'link' | 'callback';
  data: string;
}

/** keyboard 载荷：整卡最多 5 行、每行最多 5 个按钮（官方上限，这里不赘述校验）。 */
export interface QqKeyboard {
  rows: QqButton[][];
}

/**
 * 富发送内容：markdown 正文 + 按钮（`msg_type 2`），或待上传/已上传的媒体（`msg_type 7`）。
 *
 * `allowIds` 收紧可点的人（审批卡只给收卡者本人）；`file` 是待上传的公网 URL，
 * 由知道对端类型的那一层换成 `fileInfo`——上层不碰 file_info 的时效性。
 */
export interface RichSend {
  markdown?: string;
  keyboard?: QqKeyboard;
  allowIds?: readonly string[];
  /** `msg_type 7` 的 `media.file_info`（由 `uploadMedia` 取得；单群场景互不通用）。 */
  fileInfo?: string;
  file?: { fileType: 1 | 2 | 3 | 4; url: string };
  /**
   * 本地文件（工作区里真实存在的文件）：先走分片上传换 `file_info`，再发 `msg_type 7`。
   * URL 方式要求文件已在公网可访问，而 agent 产出的截图/视频只在本地，只能走这条。
   */
  localFile?: { fileType: 1 | 2 | 3 | 4; path: string };
}

/**
 * 卡片正文：行与行之间用零宽字符占位（官方给的换行写法）。
 *
 * markdown 里裸换行会把每一行渲染成独立段落，段落间距就是读者看到的「多出来的
 * 空行」——卡片越短越显眼（四行状态卡下面再挂一排按钮时最明显）。零宽字符把整段
 * 收进同一个段落，行还是分开的，间距没有了。
 */
export function cardText(lines: readonly string[]): string {
  return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\u200B`)).join('\n');
}

/** 官方 keyboard JSON：按钮动作用 `type` 区分（0 跳转、1 回调、2 指令）。 */
function keyboardBody(keyboard: QqKeyboard, allowIds?: readonly string[]): unknown {
  return {
    content: {
      rows: keyboard.rows.map((row, r) => ({
        buttons: row.map((button, i) => ({
          id: `btn_${r}_${i}`,
          render_data: { label: button.label, visited_label: button.label, style: 0 },
          action: {
            type: button.kind === 'link' ? 0 : button.kind === 'callback' ? 1 : 2,
            data: button.data,
            ...(button.kind === 'command' ? { enter: true } : {}),
            ...(allowIds !== undefined && allowIds.length > 0
              ? { permission: { type: 2, specify_user_ids: [...allowIds] } }
              : {}),
          },
        })),
      })),
    },
  };
}

export interface MessagePlan {
  /** 依次发出的请求体（每片一条）。 */
  bodies: Array<Record<string, unknown>>;
  /** 富形态被平台拒绝时的纯文本回落体；undefined = 没有回落（媒体/已是纯文本）。 */
  fallback?: Array<Record<string, unknown>>;
}

/**
 * 一条回复 → 官方请求体序列（含被动窗口字段与 msg_seq）。
 *
 * 三种形态：媒体（一段，file_info 即正文）；markdown（分片，keyboard 只随末片走，
 * 按钮出现在正文之后）；纯文本（分片）。markdown 的回落体由纯文本分片构成——
 * 富样式不可用绝不能把回复本身弄丢。
 */
export function buildMessagePlan(
  opts: { content: string; msgId?: string; rich?: RichSend },
  nextSeq: (msgId: string) => number,
): MessagePlan {
  // 每片各取一次 seq：同 msg_id 的多片回复靠递增的 msg_seq 去重，取早了会让
  // 第二片起全部撞在同一个 seq 上。
  const window = (): Record<string, unknown> =>
    opts.msgId === undefined ? {} : { msg_id: opts.msgId, msg_seq: nextSeq(opts.msgId) };
  const rich = opts.rich;
  if (rich?.fileInfo !== undefined) {
    return {
      bodies: [
        {
          msg_type: 7,
          media: { file_info: rich.fileInfo },
          ...(opts.content.length > 0 ? { content: opts.content } : {}),
          ...window(),
        },
      ],
    };
  }
  if (rich?.markdown !== undefined) {
    const chunks = chunkText(rich.markdown);
    return {
      bodies: chunks.map((chunk, i) => ({
        msg_type: 2,
        markdown: { content: chunk },
        ...(i === chunks.length - 1 && rich.keyboard !== undefined
          ? { keyboard: keyboardBody(rich.keyboard, rich.allowIds) }
          : {}),
        ...window(),
      })),
      ...(opts.content.trim().length > 0
        ? {
            fallback: chunkText(opts.content).map((chunk) => ({ msg_type: 0, content: chunk, ...window() })),
          }
        : {}),
    };
  }
  return { bodies: chunkText(opts.content).map((chunk) => ({ msg_type: 0, content: chunk, ...window() })) };
}
