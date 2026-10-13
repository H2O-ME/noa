/**
 * 一条 QQ 回复 → 内核的答案批次：编号选选项，其余按自由文字。
 *
 * 从 `question-reply.ts` 拆出（那边负责「怎么问」）：问与答的生命周期不同——展示
 * 变了（卡片、按钮）不该动解析，解析的失败模式（映射错了内核会拒收，提问留在原地
 * 而用户以为答过了）也只在解析侧。两边共享的是**编号**这一个契约：编号由展示侧
 * 定义（`layoutQuestions`），这里按它取值。
 */
import {
  MAX_CUSTOM_ANSWER_CHARS,
  type AskUserQuestionAnswer,
  type AskUserQuestionAnswerItem,
  type AskUserQuestionItem,
} from '@noa/core';
import { layoutQuestions, type RenderedQuestion } from './question-reply.js';

/** An answer the parser accepted, or why it refused. */
export type AnswerParse =
  | { ok: true; answer: AskUserQuestionAnswer }
  | { ok: false; reason: string };

/**
 * Turn one peer's `/answer` text into the kernel's answer batch.
 *
 * The rules, in the order they are applied:
 *
 *  - a batch of ONE question takes the whole line, so `/answer 2` or `/answer 用
 *    postgres` both mean what they look like;
 *  - a batch of SEVERAL questions takes `id=答案` segments (`ui=1,3 db=postgres`),
 *    because free-form prose cannot be attributed to one of them and guessing
 *    would answer the wrong question;
 *  - a number selects that option by POSITION (1-based), which is what the
 *    rendered menu promised;
 *  - anything else is free text (`custom`), and a question with no options has
 *    nothing else it could be.
 *
 * Every refusal names what to do instead: a bare "invalid" leaves the operator
 * staring at a parked run.
 * @param questions - the batch the peer is answering.
 * @param text - the peer's line, verbatim.
 * @returns the batch, or a reason it cannot be used.
 */
export function parseAnswer(questions: readonly AskUserQuestionItem[], text: string): AnswerParse {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: '回答是空的。' };
  const rendered = layoutQuestions(questions);
  if (rendered.length === 0) return { ok: false, reason: '这个提问已经不在等待了。' };

  const segments = rendered.length === 1
    ? [{ target: rendered[0]!, body: trimmed }]
    : splitSegments(rendered, trimmed);
  if (typeof segments === 'string') return { ok: false, reason: segments };

  const answers: AskUserQuestionAnswerItem[] = [];
  for (const { target, body } of segments) {
    const item = answerOne(target, body);
    if (typeof item === 'string') return { ok: false, reason: item };
    answers.push(item);
  }
  // Unmentioned questions in a batch are SKIPPED rather than invented: the kernel
  // accepts an empty selection, and inventing one would put words in the peer's
  // mouth.
  for (const question of rendered) {
    if (!answers.some((answer) => answer.id === question.question.id)) {
      answers.push({ id: question.question.id, selected: [] });
    }
  }
  return { ok: true, answer: { answers } };
}

/** `id=body id=body`, or a reason the line cannot be read that way. */
function splitSegments(
  rendered: RenderedQuestion[],
  text: string,
): { target: RenderedQuestion; body: string }[] | string {
  const segments: { target: RenderedQuestion; body: string }[] = [];
  // Split on whitespace-introduced `key=` starts, so a free-text answer containing
  // spaces stays whole.
  const parts = text.split(/\s+(?=[A-Za-z0-9_-]+=)/u);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      return `这批有 ${rendered.length} 个问题，请按「编号=回答」逐项回答，例如：`
        + `${rendered.map((_question, index) => `${index + 1}=…`).join(' ')}（也可以直接用问题的 id）。`;
    }
    const key = part.slice(0, eq).trim();
    const body = part.slice(eq + 1).trim();
    const byNumber = /^\d+$/u.test(key) ? rendered[Number(key) - 1] : undefined;
    const found = byNumber ?? rendered.find((q) => q.question.id === key);
    if (found === undefined) {
      return `不认得「${key}」：请用问题编号（1..${rendered.length}）或它的 id。`;
    }
    segments.push({ target: found, body });
  }
  return segments;
}

/** One question's answer: numbers pick options, anything else is free text. */
function answerOne(target: RenderedQuestion, body: string): AskUserQuestionAnswerItem | string {
  const id = target.question.id;
  const trimmed = body.trim();
  if (trimmed.length === 0) return { id, selected: [] };
  if (target.choices.length === 0) {
    // Nothing to pick from: the line IS the answer.
    return { id, selected: [], custom: trimmed.slice(0, MAX_CUSTOM_ANSWER_CHARS) };
  }
  const numbers = /^[\d,，\s]+$/u.test(trimmed)
    ? trimmed.split(/[,，\s]+/u).filter((part) => part.length > 0)
    : undefined;
  if (numbers === undefined) {
    // Prose against a menu: the kernel accepts a free-text answer, and that is
    // what the peer meant.
    return { id, selected: [], custom: trimmed.slice(0, MAX_CUSTOM_ANSWER_CHARS) };
  }
  const selected: string[] = [];
  for (const raw of numbers) {
    const index = Number(raw) - 1;
    const choice = target.choices[index];
    if (choice === undefined) {
      return `「${raw}」不是这道题的选项（可选 1..${target.choices.length}）。`;
    }
    if (!selected.includes(choice.label)) selected.push(choice.label);
  }
  if (selected.length === 0) return { id, selected: [] };
  if (target.question.multiSelect !== true && selected.length > 1) {
    return `这道题只能选一个（回复 ${numbers[0]}）。`;
  }
  return { id, selected };
}

/** One outstanding batch, in the shape the answer needs. */
export interface PendingQuestion {
  id: string;
  questions: readonly AskUserQuestionItem[];
}

/**
 * Settle the outstanding question with one line of the peer's text — the ONE
 * place a reply becomes an answer.
 *
 * Two doors land here: the `/answer` verb, and a plain message that arrived while
 * the question waited. The second is the point — a peer answers a question in
 * their own words, and a mechanism that only accepts a command name is a form the
 * chat window never promised. The kernel serializes asks, so the first outstanding
 * batch is the one being answered.
 * @param pending - outstanding batches, oldest first.
 * @param resolve - hands the mapped answer back to the kernel; false when the wait is gone.
 * @param text - the peer's line, verbatim.
 * @returns the reply to send.
 */
export function answerPendingQuestion(
  pending: readonly PendingQuestion[],
  resolve: (id: string, answer: AskUserQuestionAnswer) => boolean,
  text: string,
): string {
  const first = pending[0];
  if (first === undefined) return '现在没有待回答的问题。';
  const parsed = parseAnswer(first.questions, text);
  if (!parsed.ok) return `回答没有送出：${parsed.reason}`;
  // The kernel validates the batch against the questions it asked, so a mapping
  // this side got wrong is REFUSED there rather than silently answering something
  // else.
  if (!resolve(first.id, parsed.answer)) {
    return '这条提问已经不在等待了（可能已超时或被别的入口答复）。';
  }
  const chosen = parsed.answer.answers
    .map((item) => item.custom ?? item.selected.join('、'))
    .filter((value) => value.length > 0);
  return chosen.length > 0 ? `已答复：${chosen.join('；')}` : '已提交答复。';
}

