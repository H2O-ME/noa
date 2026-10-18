/**
 * 中途插话：一个人在你干活的时候又说了句话。
 *
 * 这不是「下一轮」，也不是「工具输出」。它落在**正在跑的那一轮中间**——夹在工具结果
 * 之间——而模型对那个位置的默认解读是错的：一串工具结果后面跟一条 user 消息，最自然
 * 的读法是「上一轮结束了，新的一轮开始了」，于是它会把这句当成新任务，把手上没做完的
 * 事丢掉，或者把它当成问题来回答然后收尾。
 *
 * 所以插话带一个**显式标记**。这不是修饰：位置本身是有歧义的，而标记把歧义消掉——
 * 说清「这是同一个人的话」「它插在活儿中间」「它是就着当前这件事说的」「它不会再送
 * 一遍」。这一段措辞是这一整套机制里唯一真正承重的东西，其余（同步提交、队列、
 * 回执）都是为了让这句话在正确的时刻出现在正确的数组位置上。
 *
 * 借自 Hermes Agent 的 `format_steer_marker`（`agent/prompt_builder.py`）：它同样把
 * 插话写成一条独立的 `role:"user"` 消息、紧跟最新的工具结果、包在开闭标记里。这里
 * 照抄的是**这个形状**，措辞按 Noa 的处境重写（Hermes 的版本要处理它自己的
 * `display_kind` 与子 agent 扇出，Noa 没有那两样）。
 *
 * 标记写进**持久日志**（不是只给模型看的临时尾巴）。理由：这确实是这段对话里真实
 * 发生过的事——「用户在我干活的时候插了一句话」是对话语义的一部分，压缩摘要和标题
 * 都该看见它；把它做成只存在于请求里的投影，等于让重启后的历史与当时模型看到的历史
 * 不是同一份。
 */

/**
 * 标记的**标签**，也就是它可被认出来的那一部分。
 *
 * 单独导出，因为系统提示词要引用它，而提示词是手写的：把它留在这里一份、在提示词里
 * 再抄一份，两边就会各自演化——模型于是在等一个永远不会出现的标记，而那种失配没有
 * 任何运行时报错。`prompt.test.ts` 拿这个常量去断言提示词里写的确实是它。
 */
export const INTERJECTION_LABEL = 'MID-RUN MESSAGE FROM THE USER';

/** 插话正文的开标记（模型看到的第一行）。 */
export const INTERJECTION_OPEN =
  `[${INTERJECTION_LABEL} — they typed this while you were still working, so it `
  + 'reaches you here, between tool results, instead of as a new turn. It is the same '
  + 'person speaking to you, not tool output. Take it as guidance on the work in hand: '
  + 'if it adds to the task, work it in; if it changes or cancels the task, follow it and '
  + 'say what you dropped. It is delivered once, at this position.]';

/** 插话正文的闭标记。 */
export const INTERJECTION_CLOSE = `[/${INTERJECTION_LABEL}]`;

/**
 * 把一段插话包成模型看到的样子。
 * @param text - 用户原话（已 trim）。
 * @returns 带开闭标记的正文。
 */
export function formatInterjection(text: string): string {
  return `${INTERJECTION_OPEN}\n${text}\n${INTERJECTION_CLOSE}`;
}

/**
 * 从一段正文里取回用户原话；不是插话就原样返回。
 *
 * 存在的理由是**展示**：日志里存的是带标记的正文（见文件头），而队列泳道、`/undo`
 * 预览这类地方要给人看的是他自己打的那句话，不是给模型的说明。标记是精确的开头/
 * 结尾，所以这个剥离是确定的，不是「看起来像就去掉」。
 * @param content - 一条 user 消息的正文。
 * @returns 用户原话。
 */
export function interjectionText(content: string): string {
  if (!content.startsWith(INTERJECTION_OPEN)) return content;
  const body = content.slice(INTERJECTION_OPEN.length);
  if (!body.endsWith(INTERJECTION_CLOSE)) return content;
  return body.slice(0, -INTERJECTION_CLOSE.length).replace(/^\n/, '').replace(/\n$/, '');
}
