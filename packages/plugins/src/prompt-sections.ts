/**
 * Plugin-owned system-prompt sections: the seam a capability exposes to tell
 * the model about itself without breaking the persona prompt's byte-stable
 * prefix. Split from `system-prompt.ts` because the persona prompt and the
 * section registry answer different questions — what the agent IS versus what
 * plugins have attached to it this roster — and assembling each is a separate
 * responsibility. The section type lives here; `buildSystemPrompt` consumes it.
 */

/** One plugin-owned section of the system prompt (see `buildSystemPrompt`). */
export interface SystemPromptSection {
  /** Stable identity for diagnostics and deduplication; latest wins. */
  name: string;
  /** Markdown body — appended after the persona prompt under its own heading. */
  text: string;
}

/**
 * Fold a section list into its deduplicated, ordered form.
 *
 * First occurrence of each name fixes its position; a later section with the
 * SAME name replaces the earlier one's BODY in place (its position kept), so a
 * re-registration reads as an update, not a move. Empty names are dropped.
 */
export function foldPromptSections(
  sections: readonly SystemPromptSection[],
): SystemPromptSection[] {
  const ordered: SystemPromptSection[] = [];
  const indexByName = new Map<string, number>();
  for (const section of sections) {
    if (section.name.length === 0) continue;
    const existing = indexByName.get(section.name);
    if (existing === undefined) {
      indexByName.set(section.name, ordered.length);
      ordered.push({ name: section.name, text: section.text });
    } else {
      ordered[existing]! = { name: section.name, text: section.text };
    }
  }
  return ordered;
}

/**
 * Render the folded sections as the markdown tail of the persona prompt. Empty
 * bodies are dropped; a fully empty list returns the empty string so callers
 * can short-circuit without allocating.
 */
export function renderPromptSections(sections: readonly SystemPromptSection[]): string {
  const body = sections
    .filter((section) => section.text.length > 0)
    .map((section) => `## ${section.name}\n${section.text}`)
    .join('\n\n');
  return body;
}
