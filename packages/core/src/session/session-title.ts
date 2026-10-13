/**
 * The log-only session `title` marker: what a conversation is called.
 *
 * Split from `session-workspace.ts` for the same reason that file split from
 * `session-index.ts`: the marker format moves on its own. A title answers
 * "what is this conversation about" and is WRITTEN by the title model
 * (`kernel/title.ts`) — a listing (`session-peek.ts`, the QQ relay) reads it;
 * nothing in the model surface ever does.
 *
 * The marker never joins the model surface — it exists so a session list can
 * show a real label instead of the raw first prompt. The label's own TEXT rule
 * ({@link stripTitleWrappers}) lives here for the same reason: the writer and
 * every reader have to agree on what a label looks like.
 */
import { oneLineText } from '../text.js';
import type { Session } from '../session.js';

/**
 * The wrapper a chatty title model puts AROUND the label: markdown emphasis, a
 * heading or bullet mark, quotes (straight and CJK), backticks, a `标题：` prefix,
 * trailing sentence punctuation. A label never legitimately begins or ends with
 * one, and the model does not reliably obey the prompt that forbids it — it
 * answered `**正在搜索图片文件**` to a request for plain text, and the listing
 * drew the asterisks.
 */
const WRAPPER = /^(?:[#>*_~`-]+\s*|[「『“‘"']+|(?:标题|title)[：:]\s*)+|(?:[#*_~`]+|["'”」』]+|[.。!！?？]+)+$/giu;

/**
 * Strip that wrapper — repeatedly, so `**「标题」**` unwraps in two passes.
 *
 * Applied on READ as well as at generation: a marker recorded before this rule
 * existed is dirty on disk, and a listing shows what the log holds. One rule, one
 * definition — the same reason `oneLineText` lives in core rather than per surface.
 * @param raw - a model's reply, or a title already on record.
 * @returns the label with its wrapper removed; empty when nothing is left.
 */
export function stripTitleWrappers(raw: string): string {
  let text = oneLineText(raw).replace(/\s+/gu, ' ').trim();
  for (;;) {
    const next = text.replace(WRAPPER, '').trim();
    if (next === text) return text;
    text = next;
  }
}

/**
 * Append the log-only title marker. Fire-and-forget by contract: the caller
 * (`AgentSession`) already swallowed generation errors, and a failure to record
 * one must never fail the turn that produced it — the listing falls back to the
 * first prompt.
 */
export async function recordSessionTitle(session: Session, title: string): Promise<void> {
  await session.appendEvent({ type: 'title', title, at: Date.now() });
}

/**
 * The conversation's title: the NEWEST `title` marker in the log; a session
 * whose title model never ran (or failed) has none, and its listing falls back
 * to the first prompt.
 *
 * Newest-wins mirrors `sessionWorkspace` — a regenerated title appends a second
 * marker rather than editing the first. The marker goes through
 * {@link stripTitleWrappers} on the way out, so a label recorded while the model
 * still wrapped it in markdown reads as the label it was meant to be.
 */
export function sessionTitleOf(session: Session): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const evt = session.events[i];
    if (evt === undefined || evt.type !== 'title') continue;
    const label = stripTitleWrappers(evt.title);
    return label.length > 0 ? label : undefined;
  }
  return undefined;
}
