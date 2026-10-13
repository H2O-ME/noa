/**
 * Reading a context fragment: the sections it was built from, and the body
 * shape each section's own syntax supports.
 *
 * Reading lives in its own module beside the writer (`context-fragment.ts`)
 * because it is a different job over the same vocabulary: the writer decides
 * what a session starts with, the reader decides what a surface may draw from
 * it. `buildContextFragment` owns the tag syntax; this module is the only place
 * that parses it back out, so no surface re-derives the split — and re-derives
 * it wrong, since a `project_docs` body may contain anything, angle brackets
 * included.
 */
import { isContextFragment } from './context-fragment.js';
import type { AgentMessage } from './types.js';

/** One tagged section of the seeded fragment, as the fragment wrote it. */
export interface ContextSection {
  /** The tag itself (`environment`, `user_instructions`, …; a future tag survives). */
  tag: string;
  /** The section's body, verbatim, with the wrapper's own edge newlines trimmed. */
  text: string;
}

/** One `<tag>…</tag>` run, non-greedy: sections never nest in this vocabulary. */
const SECTION_PATTERN = /<([a-z][a-z0-9_]*)>\n?([\s\S]*?)\n?<\/\1>/g;

/**
 * Split a fragment into the sections that built it.
 *
 * Reading lives beside writing on purpose: `buildContextFragment` owns this
 * tag vocabulary, so whoever renders or projects a fragment gets the same
 * split every surface would otherwise re-derive (and re-derive wrong — a
 * `project_docs` body may contain anything, including angle brackets).
 * @param msg - the suspected fragment.
 * @returns its sections in order; empty for a message that is not a fragment.
 */
export function contextSections(msg: AgentMessage): readonly ContextSection[] {
  if (!isContextFragment(msg)) return [];
  const sections: ContextSection[] = [];
  for (const match of msg.content.matchAll(SECTION_PATTERN)) {
    const tag = match[1];
    const text = match[2];
    if (tag === undefined || text === undefined) continue;
    sections.push({ tag, text: text.trim() });
  }
  return sections;
}

/**
 * The shape a section's bytes support, for a reader that draws it. Three cases,
 * all decided here rather than per surface:
 *
 * - `environment` is written as `key=value` lines → name/value rows.
 * - `available_skills` is written as `- name: description` lines → entries.
 * - everything else (user directives, AGENTS.md prose, a future tag) is text.
 *
 * A section whose lines do not all fit the parse keeps the text form: a partial
 * list would show the reader a confident, incomplete account of what the model
 * read, which is worse than showing the bytes.
 */
export type ContextSectionForm =
  | { form: 'snapshot'; sections: readonly { name: string; text: string }[] }
  | {
      form: 'catalog';
      entries: readonly { name: string; description: string }[];
      /** The section's lines that were not entries (its own closing prose). */
      note?: string;
    }
  | { form: 'text' };

/**
 * Read one section into the body shape its own syntax supports.
 * @param section - a section from contextSections.
 * @returns the form and its rows, or the text form.
 */
export function contextSectionForm(section: ContextSection): ContextSectionForm {
  const lines = section.text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (section.tag === 'environment') {
    const rows = lines.map((line) => {
      const at = line.indexOf('=');
      return at > 0 ? { name: line.slice(0, at), text: line.slice(at + 1) } : undefined;
    });
    if (rows.length > 0 && rows.every((row) => row !== undefined)) {
      return { form: 'snapshot', sections: rows as { name: string; text: string }[] };
    }
  }
  if (section.tag === 'available_skills') {
    const entries: { name: string; description: string }[] = [];
    const rest: string[] = [];
    for (const line of lines) {
      const match = /^-\s*([^:]+):\s*(.*)$/.exec(line);
      const name = match?.[1]?.trim();
      const description = match?.[2]?.trim();
      if (match !== null && name !== undefined && name.length > 0 && description !== undefined) {
        entries.push({ name, description });
      } else {
        rest.push(line);
      }
    }
    // The prose around the entries is model-facing too: the body shows the
    // entries as rows AND keeps the rest, rather than reprinting both.
    if (entries.length > 0) {
      return { form: 'catalog', entries, ...(rest.length > 0 ? { note: rest.join('\n') } : {}) };
    }
  }
  return { form: 'text' };
}
