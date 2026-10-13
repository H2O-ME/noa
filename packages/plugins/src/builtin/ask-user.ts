import {
  MAX_OPTION_DESCRIPTION_CHARS,
  MAX_OPTION_LABEL_CHARS,
  MAX_QUESTION_CHARS,
  MAX_QUESTION_DETAIL_CHARS,
  MAX_QUESTION_HEADER_CHARS,
  MAX_QUESTION_ID_CHARS,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTIONS,
  UserQuestionError,
  hasControlChars,
  errMessage,
  tools as toolsKey,
  type AskQuestionsFn,
  type AskUserQuestionItem,
  type AskUserQuestionOption,
  type Plugin,
  type ToolExecuteContext,
} from '@noa/core';
import { registerTool } from '../toolbox.js';

/**
 * `ask_user_question`: the model's door to the person driving the session.
 *
 * The tool itself decides nothing — it normalizes the model's arguments (which
 * are as untrusted as any other tool input), hands them to the kernel's question
 * broker, and renders the answer back as JSON. Whether anyone can answer is the
 * *assembly's* business, not this file's: `options.ask` is absent on a surface
 * with no human attached (headless `exec`, the QQ channel), and the tool then
 * fails with the same typed error the asker would raise — a defined outcome the
 * model can act on rather than a hang.
 *
 * That absence is deliberately not "the tool is not registered": a model that
 * needs a decision should learn that nobody can give one here, and a tool that
 * simply is not in its list teaches it nothing. The error text says which
 * situation it is in.
 */
export interface AskUserPluginOptions {
  /**
   * Resolve the answerer AT CALL TIME, for the session that made the call.
   *
   * A thunk, not the answerer itself, and not a boolean decided at assembly:
   * "can this conversation ask a human?" is a per-session fact (a bot peer inside
   * a browser-hosted kernel has an answerer in the process but nobody watching
   * ITS stream), so the answer is read live from the session named by the call's
   * scope. Returning `undefined` means nobody can answer here, and every call
   * reports `NO_PROVIDER` verbatim.
   * @param sessionId - the session that issued the call, when it has one.
   */
  ask?: (sessionId?: string) => AskQuestionsFn | undefined;
}

const DESCRIPTION =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Args: questions — array of { id, question, header?, options?: [{ label, description? }], multi_select? }. '
  + 'Put a recommended option first and append "(Recommended)" to its label. '
  + 'The result is JSON: {"answers":[{"id","selected":[labels],"custom"?}]}. '
  + 'Use this only when you genuinely cannot proceed; ask everything you need in one call.';

/**
 * The model-facing JSON schema, ported field for field from the reference
 * (`dsh-tool-ask-user`): the property names are the model's vocabulary, so
 * `multi_select` keeps its snake case while the kernel type is camelCase.
 */
const PARAMETERS = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'Questions to ask the user before continuing.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Stable id for this question; echoed in the answer.' },
          question: { type: 'string', description: 'The specific question to ask the user.' },
          header: {
            type: 'string',
            description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
          },
          detail: {
            type: 'string',
            description: 'Optional supporting detail shown with the question, such as a plan to review.',
          },
          options: {
            type: 'array',
            description:
              'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Short user-facing option label.' },
                description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          multi_select: {
            type: 'boolean',
            description: 'Whether the user may select more than one option. Defaults to false.',
          },
        },
        required: ['id', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['questions'],
  additionalProperties: false,
} as const;

/** A short string field the model supplied: trimmed, capped, control bytes rejected. */
function text(raw: unknown, max: number, multiline: boolean): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (hasControlChars(raw, { multiline })) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

function parseOptions(raw: unknown): AskUserQuestionOption[] | string {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_QUESTION_OPTIONS) {
    return `Error: options must be an array of at most ${String(MAX_QUESTION_OPTIONS)} choices`;
  }
  const options: AskUserQuestionOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return 'Error: each option must be an object with a label';
    }
    const record = entry as Record<string, unknown>;
    const label = text(record['label'], MAX_OPTION_LABEL_CHARS, false);
    if (label === undefined) return 'Error: each option needs a non-empty string label';
    const description = record['description'];
    let detail: string | undefined;
    if (description !== undefined) {
      detail = text(description, MAX_OPTION_DESCRIPTION_CHARS, true);
      if (detail === undefined) return 'Error: an option description must be a non-empty string';
    }
    options.push({ label, ...(detail !== undefined ? { description: detail } : {}) });
  }
  return options;
}

/**
 * Validate the model's arguments into the kernel's question items.
 * @param raw - the tool call's `questions` argument, of unknown shape.
 * @returns the normalized batch, or the model-facing error text.
 */
export function parseQuestions(raw: unknown): AskUserQuestionItem[] | string {
  if (!Array.isArray(raw)) return 'Error: questions must be a non-empty array';
  if (raw.length === 0) return `Error: ${new UserQuestionError('EMPTY_QUESTIONS').message}`;
  if (raw.length > MAX_QUESTIONS) return `Error: at most ${String(MAX_QUESTIONS)} questions per call`;
  const items: AskUserQuestionItem[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return 'Error: each question must be an object with id and question';
    }
    const record = entry as Record<string, unknown>;
    const id = text(record['id'], MAX_QUESTION_ID_CHARS, false);
    if (id === undefined) return 'Error: each question needs a non-empty string id';
    // The answer names questions by id, so a duplicate would make two questions
    // indistinguishable and the answer ambiguous — refused here rather than
    // resolved by position later.
    if (ids.has(id)) return `Error: duplicate question id: ${id}`;
    ids.add(id);
    const question = text(record['question'], MAX_QUESTION_CHARS, true);
    if (question === undefined) return `Error: question ${id} needs a non-empty question string`;
    const header = record['header'] === undefined ? undefined : text(record['header'], MAX_QUESTION_HEADER_CHARS, false);
    if (record['header'] !== undefined && header === undefined) {
      return `Error: question ${id} has an invalid header`;
    }
    const detail = record['detail'] === undefined
      ? undefined
      : text(record['detail'], MAX_QUESTION_DETAIL_CHARS, true);
    if (record['detail'] !== undefined && detail === undefined) {
      return `Error: question ${id} has invalid detail text`;
    }
    const options = parseOptions(record['options']);
    if (typeof options === 'string') return options;
    const multi = record['multi_select'];
    if (multi !== undefined && typeof multi !== 'boolean') {
      return `Error: question ${id} multi_select must be a boolean`;
    }
    items.push({
      id,
      question,
      ...(detail !== undefined ? { detail } : {}),
      ...(header !== undefined ? { header } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(multi === true ? { multiSelect: true } : {}),
    });
  }
  return items;
}

/** The successful result: the reference's JSON, one entry per answered question. */
function renderAnswer(answer: { answers: readonly { id: string; selected: readonly string[]; custom?: string }[] }): string {
  return JSON.stringify({
    answers: answer.answers.map((item) => ({
      id: item.id,
      selected: [...item.selected],
      ...(item.custom !== undefined ? { custom: item.custom } : {}),
    })),
  });
}

/**
 * The ask tool as a plugin. Always registered (see the header): a surface
 * without an answerer gets the typed refusal, never a silent absence.
 */
export function askUserPlugin(options: AskUserPluginOptions = {}): Plugin {
  const ask = options.ask;
  return {
    name: 'ask-user',
    description: 'Ask the user a question and wait for the answer.',
    manifest: { title: '向人提问', description: '向用户提问并等待答复；无人值守的界面直接给出拒绝。', tier: 'core' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(
        ctx,
        {
          name: 'ask_user_question',
          description: DESCRIPTION,
          parameters: PARAMETERS,
          async execute(args, c: ToolExecuteContext) {
            const questions = parseQuestions(args['questions']);
            if (typeof questions === 'string') return questions;
            // Read the live answerer per call, for the session that asked (see
            // `AskUserPluginOptions.ask`): a surface that gains or loses its human
            // mid-process, and a kernel driving several conversations at once,
            // are both reflected without rebuilding the roster.
            const answerer = ask?.(c.sessionId);
            if (answerer === undefined) return `Error: ${new UserQuestionError('NO_PROVIDER').message}`;
            try {
              const answer = await answerer(questions, c.signal);
              return renderAnswer(answer);
            } catch (err) {
              // Every failure this call can have is one of the ask path's typed
              // errors (aborted / cancelled), and its message is the sentence the
              // model is meant to read — so it is reported, not reworded.
              return `Error: ${errMessage(err)}`;
            }
          },
          /**
           * A real presentation: the question card in the composer seat reads the
           * kernel event, not this view — the row is what the transcript shows
           * for the call itself, so it names the question being asked.
           */
          presentCall(args) {
            const questions = parseQuestions(args['questions']);
            return {
              card: 'generic',
              kind: 'question',
              title: typeof questions === 'string' ? 'ask_user_question' : (questions[0]?.question ?? 'ask_user_question'),
            };
          },
          /**
           * Deliberately NOT concurrency-safe: two questions at once would put
           * two cards in the composer seat and make the run's phase ambiguous.
           * The loop's serial path is what keeps "one ask at a time" true, so the
           * broker needs no queue of its own.
           */
          isConcurrencySafe() {
            return false;
          },
        },
        // 'read': asking the human is not itself a side effect — the answer may
        // lead to a side effect, and that call goes through this same gate.
        'read',
      );
    },
  };
}
