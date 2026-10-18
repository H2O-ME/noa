/**
 * Raw-document plumbing for the config file a running process may rewrite.
 *
 * Ported from nova's `packages/cli/src/config-doc.ts`. Every writer depends on
 * the same three guarantees:
 *
 *  - **read-modify-write over the RAW text, never the loaded `Config`.** Loading
 *    runs every string through `expandDeep`, so a `{env:MY_KEY}` reference comes
 *    back as the secret itself; writing the parsed object out again would replace
 *    a reference with plaintext. Patching the document keeps every other byte,
 *    references included, exactly as written.
 *  - **atomic replace** (same-dir tmp + rename): a crash leaves the previous
 *    config in place rather than a truncated one.
 *  - **abort on anything unparseable.** A config the process cannot understand is
 *    one it must not silently overwrite, so every reader throws instead.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { userConfigPath } from '@noa/core';
import { configSchema } from './config.js';
import { migrateConfigDocument } from './config-migrate.js';

/** Rewrite one config file atomically (same-dir tmp + rename). */
async function writeDoc(file: string, doc: unknown): Promise<void> {
  // The DIRECTORY is created first: a first run has neither the file nor
  // `~/.noa/`, and the tmp+rename below would fail with ENOENT on a
  // directory that does not exist.
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

/**
 * The named plain-object member of a plain object, or undefined for anything
 * else. Every nested write goes through this: a config holding `"provider": []`
 * must read as "no provider object" rather than have an array used as a map.
 * @param root - the parsed document.
 * @param key - the member to read.
 * @returns the member when it is a plain object, else undefined.
 */
export function plainMember(root: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return undefined;
  const value = (root as Record<string, unknown>)[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The config file for a home directory (the real one by default). */
export function docFile(homedir?: string): string {
  return homedir === undefined ? userConfigPath() : userConfigPath(homedir);
}

/**
 * Read + parse the config document. Throws on unreadable or invalid text.
 * @param file - absolute path of the config file.
 * @returns the parsed document (any JSON shape; callers narrow it).
 */
export async function readDoc(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`missing config: ${file}`);
    }
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`invalid JSON in ${file}: refusing to rewrite`);
  }
}

/**
 * One write queue per config file.
 *
 * `tmp + rename` makes a SINGLE write atomic, but it cannot protect a
 * read-modify-write: two patches that both read the file before either writes
 * leave whichever wrote last with the other's change erased. The channel's
 * pairing flow can produce exactly that — binding a new owner and minting a code
 * are separate patches to the same file.
 */
const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Apply `patch` to the raw document and write it back. The patcher receives the
 * parsed root and mutates it in place; non-object roots are rejected before it
 * runs.
 *
 * The whole read → patch → write runs INSIDE the file's queue, so a patch always
 * sees the previous patch's result rather than a stale read.
 *
 * **A missing file is an EMPTY document, not an error**: a first run has no
 * `config.json` at all, and the pairing flow is precisely where one is created.
 * A file that EXISTS but holds invalid JSON still throws (`readDoc`).
 * @param patch - in-place mutation of the parsed root.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the file path written.
 */
export function patchConfig(
  patch: (doc: Record<string, unknown>) => void,
  homedir?: string,
): Promise<string> {
  const file = docFile(homedir);
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const run = previous.then(
    () => applyPatch(file, patch),
    () => applyPatch(file, patch),
  );
  // The queue must survive a failed patch, or one unparseable save would wedge
  // every later one; the caller still sees the rejection through `run`.
  writeQueues.set(file, run.then(noop, noop));
  return run;
}

async function applyPatch(file: string, patch: (doc: Record<string, unknown>) => void): Promise<string> {
  const doc: unknown = await readDoc(file).catch((err: unknown) => {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || (err instanceof Error && err.message.startsWith('missing config'))) return {};
    throw err;
  });
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error(`${file}: config root must be a JSON object`);
  }
  // Heal deprecated keys on the way through: the patched result is what gets
  // validated and written, so the first save after an upgrade rewrites the file
  // into the current shape instead of refusing it (the schema is strict).
  migrateConfigDocument(doc);
  patch(doc as Record<string, unknown>);
  // Validate the PATCHED RAW document before the commit: the atomic write
  // protects the file's integrity, not its validity. The raw form is what is
  // validated — `{env:NAME}` references are strings here and pass the schema,
  // exactly as they pass at load before expansion.
  const checked = configSchema.safeParse(doc);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`refusing to write ${file} — the result would not load:\n${issues}`);
  }
  await writeDoc(file, doc);
  return file;
}

function noop(): void {}

/**
 * Heal a legacy config file in place, WITHOUT a patch to hang it on.
 *
 * `patchConfig` heals deprecated keys as a side effect of the write it was asked
 * for. That is enough only while something still writes the file: the pairing
 * flow and the settings page were both removed, so during a normal boot nothing
 * patches it any more — which made a legacy document announce its deprecated keys
 * on every single start, forever, while the module header promised the first save
 * would fix it.
 *
 * Two rules this keeps from `applyPatch`: it writes ONLY when the migration
 * actually changed something (a boot must not rewrite a current file, and must
 * never invent one that is absent), and it validates before committing.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the notes for what it rewrote ([] when there was nothing to do).
 */
export async function healConfigFile(homedir?: string): Promise<readonly string[]> {
  const file = docFile(homedir);
  const doc: unknown = await readDoc(file).catch((err: unknown) => {
    // No file yet: there is nothing to heal, and creating one here would make a
    // read of the config a write.
    if (err instanceof Error && err.message.startsWith('missing config')) return undefined;
    throw err;
  });
  if (doc === undefined) return [];
  const notes = migrateConfigDocument(doc);
  if (notes.length === 0) return [];
  const checked = configSchema.safeParse(doc);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`refusing to rewrite ${file} — the result would not load:\n${issues}`);
  }
  await writeDoc(file, doc);
  return notes;
}

/** Sorted, de-duplicated string list (a disable list's canonical form). */
export function sortedUnique(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * The named string-list member, created (and normalized) in place. A non-array
 * value is replaced by an empty list rather than trusted: this is the only place
 * a `skills.disable` entry is born, so it must not carry a hand-edited non-list
 * forward.
 * @param obj - the object owning the list.
 * @param key - the list's key.
 * @returns the live array to mutate.
 */
export function ensureList(obj: Record<string, unknown>, key: string): string[] {
  const current = obj[key];
  const list = Array.isArray(current) ? current.filter((v): v is string => typeof v === 'string') : [];
  obj[key] = list;
  return list;
}
