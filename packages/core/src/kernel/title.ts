/**
 * Session-title generation over the title model.
 *
 * A session title is a LABEL, not a reply: a small request fired when the
 * conversation's first real prompt lands, then RE-FIRED as the conversation
 * grows (the kernel decides when — it owns the cadence), its input reduced to
 * a short excerpt of the recent prompts, and the whole thing best-effort — a
 * slow, misconfigured or absent title model costs nothing but the fallback
 * (the first prompt, which is what every listing showed before this existed).
 *
 * Lives in `kernel/` next to the session that fires it; the marker it produces
 * is `session-title.ts`'s concern.
 */
import { oneLineText } from '../text.js';
import { isContextFragment } from '../context-fragment.js';
import { stripTitleWrappers } from '../session/session-title.js';
import type { AgentMessage, ChatProvider, UserMessage } from '../types.js';

/** A title is a label: past this it is a sentence, and the listing caps anyway. */
export const SESSION_TITLE_MAX_CHARS = 24;

/** Total characters of conversation the title model may see per request. A
 *  title model is often the smallest model on the endpoint — handing it the
 *  whole transcript would be the one call that costs more than the turn. */
const TRANSCRIPT_BUDGET_CHARS = 2_000;

/** One prompt's share of that budget; a single pasted document gets one line. */
const PROMPT_LINE_CHARS = 400;

/** How many real prompts may land before the title is re-asked. Every turn
 *  would be a request per reply; never would freeze the label on a stale topic.
 *  Five keeps the label tracking the conversation at one small call per five. */
export const TITLE_REGEN_PROMPTS = 5;

/**
 * What the title model is asked for. The reference's instruction
 * (`dsh-session-title-llm`) is the model: a concise title, plain text of natural
 * language, no quotes / prefix / explanation / Markdown / code; the character
 * budget and "keep the current title while it still fits" are this product's own.
 * The wording it replaces asked for a phrase that "点名正在做的事", and that is
 * what came back: `**正在搜索图片文件**` — progress narration, wrapped in markdown
 * the instruction never forbade. A title names the TOPIC, not the current step.
 */
const TITLE_INSTRUCTION = [
  '根据给出的用户消息，为这次编程助手会话起一个简洁的标题。',
  '标题是概括会话主题的短语（不要用「正在…」这类进行时描述或完整句子），用消息本身的语言，不超过 12 个字。',
  '只输出标题纯文本：不要 Markdown（**、*、`、#）、引号、书名号、编号、前缀或任何解释。',
  '如果给出了当前标题且它仍然贴切，原样输出它；话题已经偏移才换新标题。',
].join('\n');

/**
 * The excerpt the title model sees: the RECENT user prompts, newest-wanted,
 * within a hard character budget. User prompts only — tool output and the
 * assistant's prose describe HOW the work went, the titles the human navigates
 * by are about WHAT was asked. Building from the END means a long conversation
 * keeps its latest topic, which is exactly what a growing title should track.
 * @param messages - the session's live messages.
 * @param currentTitle - the title already on record, if any (stated so the
 *   model can keep a still-accurate one instead of churning it every round).
 * @returns the prompt text for the title request.
 */
export function titleTranscript(messages: readonly AgentMessage[], currentTitle: string | undefined): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0 && used < TRANSCRIPT_BUDGET_CHARS; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== 'user' || isContextFragment(message)) continue;
    const content = typeof message.content === 'string' ? message.content : '';
    const line = oneLineText(content).trim().slice(0, PROMPT_LINE_CHARS);
    if (line.length === 0) continue;
    lines.unshift(line);
    used += line.length + 1;
  }
  return [
    ...(currentTitle !== undefined ? [`当前标题：${currentTitle}`] : []),
    ...lines,
  ].join('\n');
}

/**
 * Ask the title model for one label.
 * @param provider - the title model's own client (never the active chat client:
 *   swapping `setModel` on the shared instance would race the main run).
 * @param transcript - the excerpt from {@link titleTranscript}.
 * @param signal - cancels with the session (a disposed session must not keep a
 *   request in flight, and must not append after it).
 * @returns the cleaned title, or undefined when the model said nothing usable.
 */
export async function generateSessionTitle(
  provider: ChatProvider,
  transcript: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const ask: UserMessage = { id: 'title-ask', ts: Date.now(), role: 'user', content: transcript };
  let text = '';
  for await (const evt of provider.stream({
    systemPrompt: TITLE_INSTRUCTION,
    messages: [ask],
    ...(signal === undefined ? {} : { signal }),
  })) {
    if (evt.type === 'text_delta') text += evt.text;
  }
  return normalizeTitle(text);
}

/**
 * A model's reply → a storable title: the wrapper comes off
 * ({@link stripTitleWrappers}, shared with the listing's read path — the model
 * wraps the label whether or not the instruction forbids it), then the two
 * generation-only rules this module owns: the sentinel a model uses to say it
 * could not comply, and the character budget. Empty means "no usable title" —
 * the caller records nothing and the listing keeps its fallback.
 */
function normalizeTitle(raw: string): string | undefined {
  const line = stripTitleWrappers(raw);
  if (line.length === 0 || line === '（未生成）') return undefined;
  return line.length > SESSION_TITLE_MAX_CHARS ? `${line.slice(0, SESSION_TITLE_MAX_CHARS)}…` : line;
}
