/**
 * `ask_user_question` over a chat window: how a question is SHOWN.
 *
 * A chat window is not a form. The browser renders the batch as cards with real
 * controls; a peer gets text plus the options as BUTTONS, so this file is the
 * whole adaptation:
 *
 *  - `renderQuestions` numbers the options, because "the third one" has to be
 *    sayable and a label may be long or ambiguous;
 *  - `questionKeyboard` offers them as one-tap buttons (`/answer <n>` as a
 *    COMMAND button, so a tap and a typed number are the same message);
 *  - `layoutQuestions` is the numbering CONTRACT the answer side reads
 *    (`question-answer.ts`), which is why it lives with the renderer that
 *    promised those numbers to the peer.
 *
 * The other half — a reply becoming an answer — is `question-answer.ts`. They are
 * split because showing and answering change for different reasons: cards and
 * buttons evolve, while the mapping is where the feature goes silently wrong (an
 * answer that does not fit the questions asked is REJECTED by the broker, see
 * core's `validateQuestionAnswer`, leaving the run parked while the peer believes
 * they answered). Both halves are pure, so neither needs the orchestrator.
 */
import type { AskUserQuestionItem } from '@noa/core';
import type { QqButton, QqKeyboard } from './rich-send.js';

/** One question's options, numbered from 1 as the peer sees them. */
interface Choice {
  /** 1-based number the peer types. */
  number: number;
  label: string;
}

/** The rendering of one question, and the choices it offers. */
export interface RenderedQuestion {
  question: AskUserQuestionItem;
  choices: Choice[];
}

/** The whole batch, in the shape both the renderer and the parser need. */
export function layoutQuestions(questions: readonly AskUserQuestionItem[]): RenderedQuestion[] {
  return questions.map((question) => ({
    question,
    choices: (question.options ?? []).map((option, index) => ({ number: index + 1, label: option.label })),
  }));
}

/**
 * The message a peer receives for one outstanding question batch.
 *
 * The closing line names the two ways to answer that actually work: a number (or
 * the buttons riding the same message) and free prose. It used to tell the peer to
 * type `/answer …` — a command syntax in front of someone who was asked a
 * question, and the peer who replied in their own words was ignored until the ask
 * timed out.
 * @param questions - the batch, as the asker normalized it.
 * @returns the text to send.
 */
export function renderQuestions(questions: readonly AskUserQuestionItem[]): string {
  const lines = ['需要你回答：'];
  for (const { question, choices } of layoutQuestions(questions)) {
    const heading = question.header !== undefined && question.header.length > 0 ? `【${question.header}】` : '';
    lines.push(`${heading}${question.question}`);
    if (question.detail !== undefined && question.detail.length > 0) lines.push(`  ${question.detail}`);
    for (const choice of choices) {
      lines.push(`  ${choice.number}. ${choice.label}${optionHint(question, choice.number)}`);
    }
    lines.push(choices.length === 0
      ? '  （直接回复文字即可）'
      : '  回复编号选择，或直接回复你的文字作为自由回答。');
  }
  return lines.join('\n');
}

/** A one-line reminder on the first option of a multi-select question. */
function optionHint(question: AskUserQuestionItem, number: number): string {
  return question.multiSelect === true && number === 1 ? '（可多选，用逗号分隔）' : '';
}

/** Longest button label: a keyboard label is a tap target, not the option's text. */
const BUTTON_LABEL_MAX = 12;
/** Buttons per row. The platform allows five; three keeps each one wide enough. */
const BUTTONS_PER_ROW = 3;

/**
 * The options as one-tap buttons, or undefined when buttons cannot carry the
 * answer.
 *
 * Only a batch of ONE question gets them: a question request is settled in ONE
 * call, and questions the line does not mention come back EMPTY — so the first tap
 * on a two-question form would silently drop the second answer. There the numbered
 * list stays the only way to answer everything.
 *
 * The buttons are COMMAND buttons carrying `/answer <n>`: a tap is exactly the
 * message the peer would have typed, so there is one answer path, and a client
 * that renders no keyboard still works from the numbers.
 * @param questions - the batch being asked.
 * @returns the keyboard, or undefined when there is nothing to tap.
 */
export function questionKeyboard(questions: readonly AskUserQuestionItem[]): QqKeyboard | undefined {
  const rendered = layoutQuestions(questions);
  const only = rendered.length === 1 ? rendered[0] : undefined;
  if (only === undefined || only.choices.length === 0) return undefined;
  const buttons: QqButton[] = only.choices.map((choice) => ({
    label: clipLabel(choice.label),
    kind: 'command',
    data: `/answer ${choice.number}`,
  }));
  const rows: QqButton[][] = [];
  for (let at = 0; at < buttons.length; at += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(at, at + BUTTONS_PER_ROW));
  }
  return { rows };
}

/** The button's own label, cut on code points — the platform refuses an over-long one. */
function clipLabel(label: string): string {
  const chars = Array.from(label.trim());
  return chars.length <= BUTTON_LABEL_MAX
    ? chars.join('')
    : `${chars.slice(0, BUTTON_LABEL_MAX - 1).join('').trimEnd()}…`;
}
