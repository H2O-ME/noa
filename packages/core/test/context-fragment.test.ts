import { describe, expect, it } from 'vitest';
import {
  buildContextFragment,
  contextSectionForm,
  contextSections,
  isBlankSession,
  isContextFragment,
  type AgentMessage,
} from '../src/index.js';

/**
 * The seeded fragment has one writer (`buildContextFragment`) and one reader
 * (`contextSections` + `contextSectionForm`). These tests pin the reader to the
 * writer's own shape: sections split at their tags, and each section's body
 * shape read off its own syntax — never off a tag name alone, so a section
 * whose lines do not parse keeps its bytes instead of showing a partial list.
 */

const ENV = { platform: 'linux', cwd: '/w', shell: 'bash', today: '2026-09-24' };

/** A fragment-shaped message: the runner's own id prefix is what marks it. */
function fragmentMessage(content: string): AgentMessage {
  return { id: 'msg_ctx_1', ts: 0, role: 'user', content };
}

describe('contextSections', () => {
  it('splits the built fragment into its tagged sections, in order', () => {
    const content = buildContextFragment(ENV, 'be terse', [{ name: 'pdf', description: 'PDF toolkit' }], ['# AGENTS\nrule']);
    const sections = contextSections(fragmentMessage(content));
    expect(sections.map((section) => section.tag)).toEqual([
      'environment',
      'user_instructions',
      'project_docs',
      'available_skills',
    ]);
    expect(sections[0]?.text).toBe('platform=linux\ncwd=/w\nshell=bash\ntoday=2026-09-24');
    expect(sections[2]?.text).toContain('# AGENTS');
  });

  it('omits sections the builder did not write', () => {
    const sections = contextSections(fragmentMessage(buildContextFragment(ENV, undefined, [])));
    expect(sections.map((section) => section.tag)).toEqual(['environment']);
  });

  it('returns nothing for a message that is not a fragment', () => {
    expect(contextSections({ id: 'm1', ts: 0, role: 'user', content: 'hello' })).toEqual([]);
    expect(isContextFragment({ id: 'm1', ts: 0, role: 'assistant', content: '<environment>x</environment>' })).toBe(false);
  });

  it('keeps an unknown tag usable (a future fragment still splits)', () => {
    const sections = contextSections(fragmentMessage('<environment>\ncwd=/w\n</environment>\n<memory>\nnote\n</memory>'));
    expect(sections.map((section) => section.tag)).toEqual(['environment', 'memory']);
    expect(sections[1]?.text).toBe('note');
  });

  it('does not split on angle brackets inside a section body', () => {
    const content = '<project_docs>\nuse <b> and </b> freely\n</project_docs>';
    expect(contextSections(fragmentMessage(content))[0]?.text).toBe('use <b> and </b> freely');
  });
});

describe('isBlankSession', () => {
  it('is true only while every user message is runner-seeded context', () => {
    // A session and its log exist before the first prompt, so "has it started"
    // is a question about content. Only the fragment so far → still blank.
    expect(isBlankSession([fragmentMessage('<environment>\ncwd=/w\n</environment>')])).toBe(true);
    expect(isBlankSession([])).toBe(true);
    // An old log whose fragment got a plain id still counts, via its content.
    expect(isBlankSession([{ id: 'msg_1', ts: 0, role: 'user', content: '<environment>\ncwd=/w\n</environment>' }])).toBe(true);
  });

  it('is false once the user has written anything, fragment or not', () => {
    const fragment = fragmentMessage('<environment>\ncwd=/w\n</environment>');
    expect(isBlankSession([fragment, { id: 'msg_2', ts: 1, role: 'user', content: 'hi' }])).toBe(false);
    // A typed message that happens to start with `<` is still a user prompt —
    // the id prefix is what marks a real fragment.
    expect(isBlankSession([{ id: 'msg_3', ts: 0, role: 'user', content: '<not a fragment>' }])).toBe(false);
    // An assistant reply with no user message cannot happen in a real log, but
    // the predicate asks about user intent only.
    expect(isBlankSession([{ id: 'msg_4', ts: 0, role: 'assistant', content: 'x' }])).toBe(true);
  });
});

describe('contextSectionForm', () => {
  it('reads the environment as name/value rows', () => {
    const section = contextSections(fragmentMessage(buildContextFragment(ENV, undefined, [])))[0];
    expect(section).toBeDefined();
    expect(contextSectionForm(section!)).toEqual({
      form: 'snapshot',
      sections: [
        { name: 'platform', text: 'linux' },
        { name: 'cwd', text: '/w' },
        { name: 'shell', text: 'bash' },
        { name: 'today', text: '2026-09-24' },
      ],
    });
  });

  it('reads the skills index as entries, keeping its closing prose as the note', () => {
    const content = buildContextFragment(ENV, undefined, [{ name: 'pdf', description: 'PDF toolkit' }]);
    const section = contextSections(fragmentMessage(content)).find((candidate) => candidate.tag === 'available_skills');
    const form = contextSectionForm(section!);
    expect(form.form).toBe('catalog');
    expect(form.form === 'catalog' ? form.entries : []).toEqual([{ name: 'pdf', description: 'PDF toolkit' }]);
    expect(form.form === 'catalog' ? form.note : '').toContain('Call the `skill` tool');
  });

  it('keeps prose sections as text', () => {
    const sections = contextSections(fragmentMessage(buildContextFragment(ENV, 'be terse', [], ['# AGENTS'])));
    const user = sections.find((section) => section.tag === 'user_instructions');
    expect(contextSectionForm(user!)).toEqual({ form: 'text' });
    const docs = sections.find((section) => section.tag === 'project_docs');
    expect(contextSectionForm(docs!).form).toBe('text');
  });

  it('falls back to text when a section\'s lines do not fit its own syntax', () => {
    // One line without `=` means the environment is not a readable table, and
    // one skills line without a description means the list cannot be read
    // completely — both keep their bytes rather than showing a partial account.
    const brokenEnv = contextSections(fragmentMessage('<environment>\ncwd=/w\nnot a pair\n</environment>'))[0];
    expect(contextSectionForm(brokenEnv!)).toEqual({ form: 'text' });
    const brokenSkills = contextSections(fragmentMessage('<available_skills>\n- pdf: ok\n- lonely\n</available_skills>'))[0];
    const skillsForm = contextSectionForm(brokenSkills!);
    expect(skillsForm.form).toBe('catalog');
    expect(skillsForm.form === 'catalog' ? skillsForm.note : '').toBe('- lonely');
  });
});