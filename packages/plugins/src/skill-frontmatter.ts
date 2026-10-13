/**
 * SKILL.md frontmatter: the shared `.agents` convention's header parser.
 *
 * Split from `skills.ts` because this answers "what does the header SAY" while
 * that file answers "which files exist and in what order" — two different
 * questions, and the header grammar is the one that keeps growing as real-world
 * skills appear.
 *
 * Not a YAML parser, and deliberately so: a full YAML dependency for two keys
 * would be a large surface for a small need. But it must handle the small,
 * WELL-DEFINED YAML subset that real skill files actually use — the shared
 * `.agents` ecosystem writes descriptions as **block scalars** (`>-`, `|`),
 * because a one-line quoted string is awkward for prose that wraps. Reading
 * `description: >-` as the literal string `>-` (which is what a naive
 * `key: value` scan does) means every such skill advertises its description as
 * `>-` in the index — observed on 8 of 12 skills in a real `~/.agents/skills`.
 */

/**
 * Strip a UTF-8 BOM before parsing: an editor-saved BOM makes the file start
 * with U+FEFF, which silently defeats the `^---` frontmatter match.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The frontmatter block: `---` on its own line, to the next `---` line. */
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---(?:\n|$)/;

/** A block-scalar header: `>-`, `|`, `|-2`, `>+`, … (indentation indicator optional). */
const BLOCK_SCALAR_RE = /^([|>])([+-]?)(\d*)$/;

/** What a frontmatter block says. Absent keys stay absent — never `''`. */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** The file content after the block (or the whole file when there is none). */
  body: string;
}

/**
 * Unquote a scalar: surrounding single or double quotes come off.
 *
 * Single quotes are YAML's escape-free form (with `''` as the literal quote), so
 * only the outer pair is removed. Double quotes keep their inner escapes — we do
 * not resolve them, because resolving them would mean inventing a `\n` grammar
 * for a field that is only ever displayed.
 */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === last && (first === '"' || first === "'")) return value.slice(1, -1);
  }
  return value;
}

/**
 * Read a block scalar's body: the following lines that are MORE indented than the
 * key, joined per the header's style.
 *
 * `|` is literal (newlines preserved); `>` is folded (single newlines become
 * spaces, blank lines become newlines) — the two YAML styles, which is the whole
 * reason this exists. A blank line inside the block ends a folded run but not the
 * block, so paragraphs survive.
 * @param lines - all frontmatter lines.
 * @param start - index of the first line AFTER the key's own line.
 * @returns the joined value and the index the block ended at.
 */
function readBlockScalar(lines: readonly string[], start: number, folded: boolean): { value: string; next: number } {
  const block: string[] = [];
  let index = start;
  let indent: number | undefined;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      // A blank line belongs to the block only if the block already started; a
      // blank line before any content is just spacing between keys.
      if (indent !== undefined) block.push('');
      continue;
    }
    const leading = line.length - line.trimStart().length;
    // The block ends at the first line indented no deeper than the KEY that
    // introduced it — i.e. the next sibling key or the end of the header.
    if (leading === 0) break;
    if (indent === undefined) indent = leading;
    // Deeper-than-block lines (nested YAML under a block scalar) are kept whole
    // rather than re-indented: they are prose, not structure.
    block.push(leading >= indent ? line.slice(indent) : line.trim());
  }
  while (block.length > 0 && (block[block.length - 1] ?? '').trim().length === 0) block.pop();
  if (!folded) return { value: block.join('\n'), next: index };

  // Folded: a blank line is a paragraph break (one newline), a single newline is
  // a space. Consecutive blank lines collapse, matching YAML's "more indented is
  // literal, blank is newline" rule closely enough for a description.
  let out = '';
  let blanks = 0;
  for (const line of block) {
    if (line.trim().length === 0) {
      blanks += 1;
      continue;
    }
    if (out.length > 0) out += blanks > 0 ? '\n'.repeat(blanks) : ' ';
    out += line;
    blanks = 0;
  }
  return { value: out, next: index };
}

/**
 * Parse `name`/`description` frontmatter; the body is the rest of the file.
 *
 * Handles the subset real skill files use: `key: value`, quoted values, and the
 * `|` / `>` block scalars (with optional chomping/indent indicators). Anything
 * else in the header (nested maps like `metadata:` and their children) is
 * skipped — it is not ours to interpret, and the keys we want are top-level.
 * @param raw - the file's full text.
 * @returns the parsed header and the body after the frontmatter block.
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatter {
  const normalized = stripBom(raw).replace(/\r\n/g, '\n');
  const match = FRONTMATTER_RE.exec(normalized);
  if (!match) return { body: normalized.trim() };

  const lines = (match[1] ?? '').split('\n');
  let name: string | undefined;
  let description: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    // A top-level key starts at column 0. Anything indented is a nested value of
    // a key we do not read (e.g. `metadata:`'s children), so it is skipped.
    if (line.length === 0 || line[0] === ' ' || line[0] === '\t') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    if (key !== 'name' && key !== 'description') continue;
    const inline = line.slice(colon + 1).trim();

    let value: string;
    const scalar = BLOCK_SCALAR_RE.exec(inline);
    if (scalar !== null) {
      const read = readBlockScalar(lines, index + 1, scalar[1] === '>');
      index = read.next - 1;
      // `-` (strip) is the default we want anyway: no trailing newline in a
      // label. `+` (keep) would append them, which no description wants, so both
      // are read the same way rather than inflating every such description.
      value = read.value;
    } else {
      value = unquote(inline);
    }

    if (value.length === 0) continue;
    if (key === 'name') name ??= value;
    else description ??= value;
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    body: normalized.slice(match[0].length).trim(),
  };
}
