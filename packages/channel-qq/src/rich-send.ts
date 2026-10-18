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
 * 卡片正文：行与行之间用零宽字符占位。
 *
 * 官方 `换多行` 那一节的写法是**单独一行**的零宽字符——QQ 会把连续空行折叠掉，`\n\n`
 * 只给一个空行，要更多就得插零宽字符行。这里是它的变体：把零宽字符挂在每行**行尾**
 * （末行除外），让整段落进同一个段落、消掉行距。
 *
 * 两次实测（2026-10，QQ 手机端）记在这里，因为这是这块唯一的经验依据，而它并不支持
 * 「零宽字符就是那个多出来的空行」这个最顺手的解释：
 *
 *  - 四行状态卡的行距是 25px，与纯文本气泡一致——这段确实紧贴，变体用法达到了目的；
 *  - 但它的**首行之上**还多出正好一行的高度（39px vs 14px）；
 *  - 那个多出来的空行只出现在挂了 keyboard 的卡片上：同内容的纯文本回落、单行 markdown
 *    回复都没有。所以更可能是平台给「带按钮的 markdown 卡片」留的版式。
 *
 * 正文本身从不以换行开头（`lines.join('\n')` 与本函数都不会前置），所以它不是我们的文本
 * 里的空行；而按钮只能挂在 markdown 消息上（纯文本 + keyboard 平台不渲染按钮），
 * 躲开这张卡片就等于丢掉按钮。
 */
export function cardText(lines: readonly string[]): string {
  return lines.map((line, i) => (i === lines.length - 1 ? line : `${line}\u200B`)).join('\n');
}

/**
 * 官方 keyboard JSON：按钮动作用 `type` 区分（0 跳转、1 回调、2 指令）。
 *
 * `permission` 是**必填**（官方表格 `msg-btn.md`：`action.permission.type` 必填，
 * 0 指定用户可操作 / 1 仅管理者可操作 / 2 所有人可操作 / 3 指定身份组，3 仅频道）。
 * 这里原先只在 `allowIds` 非空时才写它，于是 `/status` 那张卡整卡没有 `permission`，
 * 点下去被平台判成无权访问——用户实测的原话就是「无权限访问」。所以**永远**写出来。
 *
 * 收紧时用 `type: 0` 而不是 `type: 2`：`type: 2` 的定义是「所有人可操作」，再带一个
 * `specify_user_ids` 并不构成限制（两条语义互不相容，平台按 `type` 判），群里任何人
 * 就都能点「允许」——而「一张群里所有人可见的卡，不该谁都能批」正是 `allowIds` 存在的
 * 理由。单聊里没有第二个人，`type: 0` 与 `type: 2` 等效，所以这个选择两个场景都对。
 *
 * `unsupport_tips` 同为必填（客户端不支持该 action 时弹的 toast）。指令按钮回指它自己的
 * `data`：手打那条命令与点按钮殊途同归，卡片正文里也是这么写的。
 */
function keyboardBody(keyboard: QqKeyboard, allowIds?: readonly string[]): unknown {
  const ids = allowIds ?? [];
  return {
    content: {
      rows: keyboard.rows.map((row, r) => ({
        buttons: row.map((button, i) => ({
          id: `btn_${r}_${i}`,
          render_data: { label: button.label, visited_label: button.label, style: 0 },
          action: {
            type: button.kind === 'link' ? 0 : button.kind === 'callback' ? 1 : 2,
            permission: ids.length > 0 ? { type: 0, specify_user_ids: [...ids] } : { type: 2 },
            data: button.data,
            ...(button.kind === 'command' ? { enter: true } : {}),
            unsupport_tips: unsupportTips(button),
          },
        })),
      })),
    },
  };
}

/** 客户端不支持该 action 时弹的文案（官方必填字段）。 */
function unsupportTips(button: QqButton): string {
  if (button.kind === 'link') return '当前 QQ 版本不支持按钮跳转，请复制链接打开';
  if (button.kind === 'callback') return '当前 QQ 版本不支持该按钮，请改用文字指令';
  return `当前 QQ 版本不支持按钮，请直接回复 ${button.data}`;
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
