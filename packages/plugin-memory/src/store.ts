/**
 * The curated memory: two markdown files, one entry per physical line.
 *
 * Markdown, not a database, for reasons that are all about the operator: the
 * file is the source of truth, it is readable and editable by hand, and it
 * survives every version of this program. Everything else here (the vector
 * index in `vectors.ts`) is DERIVED and disposable; deleting it costs one
 * re-embedding pass and nothing else.
 *
 * ## One entry = one physical line
 *
 * `- ` starts an entry; blank lines and `#` headings are ignored. That is the
 * whole format, and it is load-bearing: the entry text is the identity (the
 * vector index keys entries by `sha1(text)`, and `patch`/`remove` find entries
 * by a unique substring). A newline inside an entry would be read back as two
 * truncated entries and would silently change that identity — which is why
 * {@link normalizeEntry} collapses the content the model hands us into one
 * line, and why nothing here ever writes a line break into an entry.
 *
 * ## Budgets
 *
 * Each file has a hard character cap, and an `add` that would exceed it is
 * REFUSED with the numbers, not truncated. Truncating would silently drop part
 * of a fact; refusing forces the model to consolidate (`patch`/`remove` first),
 * which is what keeps a store that is injected into every request from growing
 * into one nobody can afford. The cap is the whole discipline.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, memoryDir } from '@noa/core';

/** Which of the two files an operation addresses. */
export type MemoryTarget = 'memory' | 'user';

/** The file each target lives in, under `~/.noa/memory/`. */
export const MEMORY_FILES: Readonly<Record<MemoryTarget, string>> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
};

/** Default character budget for `MEMORY.md` (the agent's working notes). */
export const DEFAULT_MEMORY_MAX_CHARS = 2000;
/** Default character budget for `USER.md` (what the agent knows about the operator). */
export const DEFAULT_USER_MAX_CHARS = 1200;

/**
 * The derived vector index, beside the files it indexes.
 *
 * Derived, and disposable: deleting it costs one re-embedding pass and nothing
 * else, which is why nothing here treats a missing or corrupt one as an error.
 */
export const INDEX_FILE = 'index.json';

const HEADERS: Readonly<Record<MemoryTarget, string>> = {
  memory: '# 工作记忆\n\n（一行一条，由 memory 工具维护；你也可以直接编辑这个文件。）',
  user: '# 关于操作者\n\n（一行一条，由 memory 工具维护；你也可以直接编辑这个文件。）',
};

/** Matches one entry line; the capture is the entry text without its bullet. */
const ENTRY_LINE = /^\s*[-*+]\s+(.*\S)\s*$/;

/**
 * Collapse arbitrary model-supplied text into ONE valid entry.
 *
 * Models routinely pass multi-line content (a list, a snippet, a paragraph). Left
 * as-is it would be written as several physical lines, and the next parse would
 * read it back as several truncated entries — corrupting the store in a way that
 * looks like success. So: drop a bullet the model wrote itself (it would become
 * `- - x`), turn every line break into `; `, collapse whitespace runs, trim.
 *
 * @param raw - the text the model supplied.
 * @returns one single-line entry, possibly empty.
 */
export function normalizeEntry(raw: string): string {
  const single = raw
    .replace(/^\s*[-*+]\s+/, '')
    // A break, plus the bullet that may follow it, becomes one separator.
    .replace(/\s*\r?\n\s*(?:[-*+]\s+)?/g, '; ')
    .replace(/\s+/g, ' ')
    .trim();
  // Whitespace-only input reaches here as a bare separator ("  \n  " → "; "),
  // which is empty content rather than an entry made of punctuation. The
  // separator a LEADING or TRAILING break left behind is trimmed for the same
  // reason: the text around a break is the entry, the break itself is not.
  if (/^[;\s]*$/.test(single)) return '';
  return single.replace(/^;\s+/, '').replace(/\s+;$/, '').trim();
}

/**
 * Parse a memory file into entries.
 *
 * Tolerant by design — the file is hand-editable, so an unparseable line is
 * skipped rather than fatal (a typo in the operator's editor must not make the
 * whole store unreadable). Entries are re-normalized so what is loaded is
 * exactly what the index hashes.
 * @param text - the file's contents.
 * @returns the entries, in file order.
 */
export function parseEntries(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = ENTRY_LINE.exec(line);
    if (match === null) continue;
    const entry = normalizeEntry(match[1] ?? '');
    if (entry.length > 0) out.push(entry);
  }
  return out;
}

/** Render entries back to file text (deterministic: header + one line per entry). */
export function renderEntries(target: MemoryTarget, entries: readonly string[]): string {
  const body = entries.map((entry) => `- ${entry}`).join('\n');
  return `${HEADERS[target]}\n\n${body}${body.length > 0 ? '\n' : ''}`;
}

/** Total characters of a set of entries — the number the budget is spent from. */
export function entriesChars(entries: readonly string[]): number {
  let total = 0;
  for (const entry of entries) total += entry.length;
  return total;
}

/** What one operation did, as the sentence the model will read. */
export type MemoryOpResult = { readonly ok: boolean; readonly message: string };

/**
 * The two-file store for ONE memory directory.
 *
 * A class rather than free functions because the directory and the budgets are
 * configuration that every operation needs, and because the plugin holds exactly
 * one instance for the kernel's lifetime.
 */
export class MemoryStore {
  /**
   * @param dir - the memory directory (defaults to `~/.noa/memory`, resolved at
   *   construction so a test can point it at a temp dir).
   * @param budgets - per-target character caps.
   */
  constructor(
    private readonly dir: string = memoryDir(),
    private readonly budgets: Readonly<Record<MemoryTarget, number>> = {
      memory: DEFAULT_MEMORY_MAX_CHARS,
      user: DEFAULT_USER_MAX_CHARS,
    },
  ) {}

  /** The absolute path of one target's file. */
  fileFor(target: MemoryTarget): string {
    return path.join(this.dir, MEMORY_FILES[target]);
  }

  /**
   * The absolute path of the derived vector index.
   *
   * It lives beside the files it indexes so the whole memory system is one
   * directory the operator can copy, back up or delete.
   */
  indexFile(): string {
    return path.join(this.dir, INDEX_FILE);
  }

  /** The character budget of one target. */
  budgetFor(target: MemoryTarget): number {
    return this.budgets[target];
  }

  /**
   * Load one target's entries.
   *
   * A missing file is an EMPTY store, not an error: a fresh install has no
   * memory files, and that is the supported starting state. A file that exists
   * but cannot be read (permissions, a directory in its place) throws — that is
   * a real problem, and reporting it as "no memories" would hide it.
   * @param target - which file.
   * @returns the entries.
   */
  async load(target: MemoryTarget): Promise<string[]> {
    try {
      return parseEntries(await readFile(this.fileFor(target), 'utf8'));
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
  }

  /** Both files' entries, `user` first (the order the injected block reads in). */
  async loadAll(): Promise<{ target: MemoryTarget; entries: string[] }[]> {
    return [
      { target: 'user', entries: await this.load('user') },
      { target: 'memory', entries: await this.load('memory') },
    ];
  }

  /**
   * Append one entry, refusing when it does not fit.
   *
   * An entry already present (exact match) is a no-op that says so rather than a
   * duplicate: the model repeating a fact it already recorded must not spend
   * budget on a second copy of it.
   * @param target - which file.
   * @param content - the entry text, as the model supplied it.
   * @returns the sentence the model reads.
   */
  async add(target: MemoryTarget, content: string): Promise<MemoryOpResult> {
    const entry = normalizeEntry(content);
    if (entry.length === 0) return { ok: false, message: 'Error: 记忆内容为空。' };
    const entries = await this.load(target);
    const budget = this.budgetFor(target);
    if (entries.includes(entry)) {
      return { ok: true, message: `这条已经在 ${MEMORY_FILES[target]} 里了（${entriesChars(entries)}/${budget} 字符）。` };
    }
    const next = entriesChars(entries) + entry.length;
    if (next > budget) {
      return {
        ok: false,
        message:
          `Error: ${MEMORY_FILES[target]} 放不下（${entriesChars(entries)}/${budget} 字符，`
          + `加上这条会到 ${next}）。先用 operation="patch" 或 "remove" 精简掉不再需要的条目。`,
      };
    }
    await this.write(target, [...entries, entry]);
    return { ok: true, message: `已记入 ${MEMORY_FILES[target]}（${next}/${budget} 字符）。` };
  }

  /**
   * Replace the one entry containing `oldText`.
   *
   * Matching is by UNIQUE substring (the `edit_file` rule): zero matches is an
   * error the model can act on, and two matches is refused rather than guessed —
   * silently editing the first would change a fact the model did not name.
   * @param target - which file.
   * @param oldText - a substring unique to the entry being replaced.
   * @param newText - the replacement entry text.
   * @returns the sentence the model reads.
   */
  async patch(target: MemoryTarget, oldText: string, newText: string): Promise<MemoryOpResult> {
    const needle = normalizeEntry(oldText);
    if (needle.length === 0) return { ok: false, message: 'Error: old_text 不能为空。' };
    const replacement = normalizeEntry(newText);
    if (replacement.length === 0) return { ok: false, message: 'Error: new_text 不能为空。' };
    const entries = await this.load(target);
    const hits = entries.filter((entry) => entry.includes(needle));
    if (hits.length === 0) {
      return { ok: false, message: `Error: ${MEMORY_FILES[target]} 里没有包含「${needle}」的条目。` };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        message: `Error: 「${needle}」匹配到 ${hits.length} 条，请给一段更唯一的 old_text。`,
      };
    }
    const next = entries.map((entry) => (entry.includes(needle) ? replacement : entry));
    const chars = entriesChars(next);
    const budget = this.budgetFor(target);
    if (chars > budget) {
      return { ok: false, message: `Error: 改完会到 ${chars} 字符，超过上限 ${budget}。` };
    }
    await this.write(target, next);
    return { ok: true, message: `已更新 ${MEMORY_FILES[target]}（${chars}/${budget} 字符）。` };
  }

  /**
   * Delete the one entry containing `oldText`. Same unique-substring rule as
   * {@link patch}.
   * @param target - which file.
   * @param oldText - a substring unique to the entry being deleted.
   * @returns the sentence the model reads.
   */
  async remove(target: MemoryTarget, oldText: string): Promise<MemoryOpResult> {
    const needle = normalizeEntry(oldText);
    if (needle.length === 0) return { ok: false, message: 'Error: old_text 不能为空。' };
    const entries = await this.load(target);
    const hits = entries.filter((entry) => entry.includes(needle));
    if (hits.length === 0) {
      return { ok: false, message: `Error: ${MEMORY_FILES[target]} 里没有包含「${needle}」的条目。` };
    }
    if (hits.length > 1) {
      return {
        ok: false,
        message: `Error: 「${needle}」匹配到 ${hits.length} 条，请给一段更唯一的 old_text。`,
      };
    }
    const next = entries.filter((entry) => !entry.includes(needle));
    await this.write(target, next);
    return { ok: true, message: `已从 ${MEMORY_FILES[target]} 删掉一条（${entriesChars(next)}/${this.budgetFor(target)} 字符）。` };
  }

  /**
   * The change stamp of both files — what the injected block is cached against.
   *
   * `mtime:size` per file, because mtime alone is not enough (NTFS stamps land
   * on a ~15ms grid, so an edit right after the previous read can carry an
   * identical mtime) and size alone is not enough (an edit that swaps text for
   * text of equal length moves neither). The pair changes whenever the file does.
   * @returns one stamp string covering both files.
   */
  async stamp(): Promise<string> {
    const parts: string[] = [];
    for (const target of ['user', 'memory'] as const) {
      const info = await stat(this.fileFor(target)).catch(() => undefined);
      parts.push(info === undefined ? '-' : `${info.mtimeMs}:${info.size}`);
    }
    return parts.join('|');
  }

  /** Write one target's entries atomically (creates the directory if needed). */
  private async write(target: MemoryTarget, entries: readonly string[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await atomicWrite(this.fileFor(target), renderEntries(target, entries));
  }
}

/** Whether an error is a missing file (the one failure that is not a failure). */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
