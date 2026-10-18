import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isFailureContent,
  isInsideRealRoot,
  listWorkspaceFiles,
  looksBinary,
  READ_MAX_BYTES,
  resolveAnywhere,
  resolveInRoot,
  resolveReal,
  tools as toolsKey,
  type DiffCallView,
  type DiffResultView,
  type Plugin,
  type ReadResultView,
  type ToolExecuteContext,
  type ToolPermissionKind,
} from '@noa/core';
import { registerTool } from '../toolbox.js';
import { intArg, strArg } from './args.js';

// The path primitives live in core (`file-io.ts`) so the sidebar's own file
// operations and these tools share ONE containment rule; re-exported here
// because this module is where the package's public surface names them.
export { READ_MAX_BYTES, looksBinary, resolveAnywhere, resolveInRoot, resolveReal };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Permission classification against the CANONICAL path (in-root reads are
 * free, out-of-root reads are approval-gated). Any resolution failure fails
 * closed to `read-external` — the approval gate is the conservative default.
 *
 * `trustedReadRoots` are additional auto-readable roots OUTSIDE the
 * workspace — the tool-output spill directory under ~/.noa: its files are
 * truncated tool results the model already saw, so reading them back must
 * not trip the approval gate every turn.
 */
export async function rootPermissionKind(
  rootDir: string,
  raw: unknown,
  trustedReadRoots: readonly string[] = [],
): Promise<ToolPermissionKind> {
  try {
    const file = await resolveReal(rootDir, raw);
    if (await isInsideRealRoot(rootDir, file)) return 'read';
    for (const trusted of trustedReadRoots) {
      if (trusted.length === 0) continue;
      if (await isInsideRealRoot(trusted, file)) return 'read';
    }
    return 'read-external';
  } catch {
    return 'read-external';
  }
}

/**
 * The write-side twin of {@link rootPermissionKind}: in-root writes are free,
 * out-of-root writes are approval-gated.
 *
 * This is what replaced a hard refusal. `resolveInRoot` used to make an
 * out-of-root write an ERROR, and the consequence was reported live on a
 * server-resident deployment: the agent hit `path escapes workspace root`,
 * told the user it would "use a path inside the workspace instead", and could
 * not do the job it was asked to do — on a machine whose entire filesystem is
 * the operator's own. A refusal that only the fs tools honor is not a security
 * boundary anyway: `bash` runs a shell as the same user and was never confined
 * by it (which is why `bash` is `execute`, not `write`).
 *
 * So the boundary becomes a review point instead of a wall: inside the root is
 * the ordinary work an agent does unattended, outside it is a decision the
 * reviewer sees first. The distinction stays load-bearing — it is exactly what
 * makes the plain `write` kind safe to auto-allow.
 *
 * Any resolution failure fails closed to `write-external`, matching the read
 * side: the gate is the conservative default.
 * @param rootDir - the live workspace root.
 * @param raw - the model-supplied path.
 * @returns `write` inside the root, `write-external` outside it.
 */
export async function rootWriteKind(rootDir: string, raw: unknown): Promise<ToolPermissionKind> {
  try {
    const file = await resolveReal(rootDir, raw);
    return (await isInsideRealRoot(rootDir, file)) ? 'write' : 'write-external';
  } catch {
    return 'write-external';
  }
}

/**
 * Newline-tolerant replace: matches `oldString` treating every \n as \r?\n
 * (used after an exact match failed on a CRLF file). The replacement keeps
 * the file's CRLF habit when both sides are multi-line. Returns undefined
 * when the tolerant pattern does not match either.
 *
 * The replacement is handed to RegExp#replace as a **function**, never as a
 * string: a string replacer would expand `$&`/`$1`/`` $` ``/`$'`/`$$` inside
 * newString, silently garbling the file (editing in a price like `$&10`).
 */
function tolerantReplace(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { next: string; count: number } | undefined {
  if (!oldString.includes('\n') || !text.includes('\r\n')) return undefined;
  const pattern = oldString
    .split('\n')
    .map((segment) => escapeRegExp(segment))
    .join('\r?\n');
  const global = new RegExp(pattern, 'g');
  const found = text.match(global);
  if (found === null || found.length === 0) return undefined;
  const count = found.length;
  const first = found[0]!;
  const replacement =
    first.includes('\r\n') && newString.includes('\n') ? newString.replaceAll('\n', '\r\n') : newString;
  const replacer = (): string => replacement;
  const next = replaceAll ? text.replace(global, replacer) : text.replace(new RegExp(pattern), replacer);
  return { next, count };
}

/**
 * The shared edit core: exact-match first, newline-tolerant CRLF fallback
 * second. Used by both edit_file's execution and its approval preview, so
 * the preview always reflects what the edit really does. Both replacements
 * use function replacers (see tolerantReplace), so `$`-sequences in
 * newString are inserted verbatim.
 */
function applyEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { next: string; count: number } | undefined {
  const occurrences = text.split(oldString).length - 1;
  if (occurrences > 0) {
    // Function replacer (never a string) keeps `$&` etc. literal.
    const replaced = replaceAll
      ? text.replaceAll(oldString, () => newString)
      : text.replace(oldString, () => newString);
    return {
      next: replaced,
      count: occurrences,
    };
  }
  return tolerantReplace(text, oldString, newString, replaceAll);
}

/**
 * The workspace path that most likely meant `raw`, for a not-found answer.
 *
 * Matching is by SUFFIX: the observed miss is a path one segment short of the
 * real one (`docs/x.md` for `repo/docs/x.md`), so the requested path must end
 * an existing entry, and the shortest such entry wins (the nearest ancestor
 * spelling). The walk is the `@` menu's own listing — same skip-trees, same
 * bound, same no-symlink rule — so a hint never names something the listing
 * would refuse to offer.
 * @param rootDir - the workspace root.
 * @param raw - the path that was not found, as the caller wrote it.
 * @returns the closest existing workspace-relative path, or undefined.
 */
async function closestWorkspacePath(rootDir: string, raw: string): Promise<string | undefined> {
  const needle = raw.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  const base = needle.split('/').filter((segment) => segment !== '').at(-1);
  if (base === undefined || base === '') return undefined;
  const { items } = await listWorkspaceFiles(rootDir, base);
  const wanted = needle.toLowerCase();
  const matches = items
    .filter((item) => item.path.toLowerCase().endsWith(wanted))
    .sort((left, right) => left.path.length - right.path.length);
  return matches[0]?.path;
}

/** Execute read_file: in-root reads are free, out-of-root cross the boundary. */
async function executeReadFile(
  args: Record<string, unknown>,
  c: ToolExecuteContext,
): Promise<string> {
  const requested = args['path'];
  const file = resolveAnywhere(c.rootDir, requested);
  const info = await stat(file).catch(() => undefined);
  if (!info) {
    // A path can be one segment off — a mention of `@repo/docs/x.md` read as
    // `docs/x.md` when the workspace root holds the repo FOLDER (observed: the
    // model dropped the first segment and then combed the tree for four more
    // calls). Naming the closest existing path in the same answer turns that
    // recovery into one step. The search is the listing tool's own policy
    // (bounded, skip-trees, no symlink follow), so the hint can never offer
    // something the listing would not show.
    const closest = await closestWorkspacePath(c.rootDir, String(requested ?? ''));
    return closest === undefined
      ? `Error: file not found: ${String(requested)}`
      : `Error: file not found: ${String(requested)}\nClosest path in the workspace: ${closest}`;
  }
  if (info.isDirectory()) return `Error: path is a directory, use list_dir: ${args['path'] as string}`;
  if (info.size > READ_MAX_BYTES) {
    return `Error: file is ${info.size} bytes (over the ${READ_MAX_BYTES}-byte read cap); use bash (head/tail/sed) or a script to read it in chunks`;
  }
  const text = await readFile(file, 'utf8');
  // Binary probe: control characters in the first 8 KiB mean reading
  // as UTF-8 would garble the output.
  if (looksBinary(text)) {
    return `Error: file looks binary or non-UTF8 — reading it as text would garble the output (${args['path'] as string})`;
  }
  // Staleness baseline for edit_file: after this read, an edit of a
  // file that changed on disk is an error instead of a silent clobber.
  recordVersion(await resolveReal(c.rootDir, args['path']), info);
  const lines = text.split('\n');
  const total = lines.length;
  const offset = Math.max(1, intArg(args, 'offset') ?? 1);
  const limit = Math.max(1, intArg(args, 'limit') ?? 400);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const header =
    total > slice.length || offset > 1
      ? `[lines ${offset}-${offset - 1 + slice.length} of ${total}]\n`
      : '';
  return `${header}${slice.join('\n')}`;
}

/** Execute list_dir: directories first, files with their byte size. */
async function executeListDir(
  args: Record<string, unknown>,
  c: ToolExecuteContext,
): Promise<string> {
  const dir = resolveAnywhere(c.rootDir, strArg(args, 'path') ?? '.');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return `Error: cannot read directory: ${strArg(args, 'path') ?? '.'}`;
  const sorted = [...entries].sort((a, b) => {
    const dirDelta = Number(b.isDirectory()) - Number(a.isDirectory());
    return dirDelta !== 0 ? dirDelta : a.name.localeCompare(b.name);
  });
  if (sorted.length === 0) return '(empty directory)';
  // File sizes ride along (best-effort): `ls -la` otherwise beats this
  // tool informationally and the model rationally falls back to shell
  // ls whenever size matters (binary triage, build artifacts).
  const visible = sorted.slice(0, 500);
  const sizes = await Promise.all(
    visible.map(async (entry) => {
      if (!entry.isFile()) return undefined;
      try {
        return (await stat(path.join(dir, entry.name))).size;
      } catch {
        return undefined;
      }
    }),
  );
  const lines = visible.map((entry, i) =>
    entry.isDirectory() || sizes[i] === undefined
      ? `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`
      : `f ${sizes[i]} ${entry.name}`,
  );
  const suffix = sorted.length > 500 ? `\n(... ${sorted.length - 500} more)` : '';
  return lines.join('\n') + suffix;
}

/** Execute write_file: same-dir tmp + atomic rename, then refresh staleness. */
async function executeWriteFile(
  args: Record<string, unknown>,
  c: ToolExecuteContext,
): Promise<string> {
  if (typeof args['content'] !== 'string') {
    return 'Error: content must be a string (write_file takes path + content)';
  }
  // `resolveReal`, not `resolveInRoot`: the gate has already decided whether this
  // path was acceptable (see `rootWriteKind`), so the tool's job is to write it.
  const file = await resolveReal(c.rootDir, args['path']);
  const content = args['content'];
  await atomicWrite(file, content);
  await recordVersionNow(file);
  return `wrote ${content.length} chars to ${path.relative(c.rootDir, file) || file}`;
}

/** Execute edit_file: exact-match first, newline-tolerant CRLF fallback. */
async function executeEditFile(
  args: Record<string, unknown>,
  c: ToolExecuteContext,
): Promise<string> {
  const file = await resolveReal(c.rootDir, args['path']);
  const oldString = strArg(args, 'old_string');
  const newString = strArg(args, 'new_string') ?? '';
  if (oldString === undefined || oldString.length === 0) return 'Error: old_string must be a non-empty string';
  let text: string;
  try {
    const info = await stat(file).catch(() => undefined);
    if (info !== undefined && info.size > READ_MAX_BYTES) {
      return `Error: file is ${info.size} bytes (over the ${READ_MAX_BYTES}-byte edit cap); use bash (sed) or a script for bulk edits`;
    }
    text = await readFile(file, 'utf8');
  } catch {
    return `Error: cannot read file: ${args['path'] as string}`;
  }
  if (looksBinary(text)) {
    return 'Error: file looks binary — edit_file only handles text; use bash or a script';
  }
  const pendingStale = await staleError(file);
  if (pendingStale !== undefined) return `Error: ${pendingStale}`;
  const played = applyEdit(text, oldString, newString, args['replace_all'] === true);
  if (played === undefined) return 'Error: old_string not found in file';
  if (played.count > 1 && args['replace_all'] !== true) {
    return `Error: old_string appears ${played.count} times; pass replace_all=true or provide a longer unique snippet`;
  }
  await atomicWrite(file, played.next);
  await recordVersionNow(file);
  return `edited ${played.count} occurrence(s) in ${path.relative(c.rootDir, file) || file}`;
}

/**
 * Render intent for the write tools. Paths are reported **as the model asked
 * for them** — pre-resolution: unlike `preview` (which runs once permission is
 * being asked for and may read the disk), `presentCall` is pure and synchronous
 * and must touch no filesystem, so an approval prompt can build the diff card
 * for a path that does not exist yet.
 */
function writeCallView(args: Record<string, unknown>): DiffCallView | undefined {
  const target = strArg(args, 'path');
  const content = strArg(args, 'content');
  if (target === undefined || content === undefined) return undefined;
  // oldText: null = "no prior text to match", i.e. create/overwrite.
  return { card: 'diff', kind: 'write', diffs: [{ path: target, oldText: null, newText: content }] };
}

function editCallView(args: Record<string, unknown>): DiffCallView | undefined {
  const target = strArg(args, 'path');
  const oldText = strArg(args, 'old_string');
  const newText = strArg(args, 'new_string');
  if (target === undefined || oldText === undefined || newText === undefined) return undefined;
  return { card: 'diff', kind: 'edit', diffs: [{ path: target, oldText, newText }] };
}

/** Same intended mutations, now tagged with whether the tool reported success. */
function diffResultView(call: DiffCallView | undefined, content: string): DiffResultView | undefined {
  if (call === undefined) return undefined;
  return { card: 'diff', ok: !isFailureContent(content), diffs: call.diffs };
}

/** Lines shown; a trailing newline terminates rather than starting one. */
const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/**
 * read_file result: the `[lines A-B of N]` header `executeReadFile` emits is the
 * only window marker, so partiality reads off it (a `limit` that never bound
 * anything still returned the whole file, and must not claim truncation).
 */
function readResultView(args: Record<string, unknown>, content: string): ReadResultView | undefined {
  const target = strArg(args, 'path');
  if (target === undefined || isFailureContent(content)) return undefined;
  const header = /^\[lines (\d+)-(\d+) of (\d+)\]/.exec(content);
  if (header === null) {
    return { card: 'read', path: target, lineCount: countLines(content), truncated: false };
  }
  const from = Number(header[1]);
  const to = Number(header[2]);
  return { card: 'read', path: target, lineCount: to - from + 1, truncated: to < Number(header[3]) };
}

/** list_dir result: entry count plus this tool's `(... N more)` overflow marker. */
function listViewResultView(args: Record<string, unknown>, content: string): ReadResultView | undefined {
  if (isFailureContent(content)) return undefined;
  const more = /\n\(\.\.\. \d+ more\)/.exec(content);
  const body = more === null ? content : content.slice(0, more.index);
  return {
    card: 'read',
    path: strArg(args, 'path') ?? '.',
    lineCount: body === '(empty directory)' ? 0 : countLines(body),
    truncated: more !== null,
  };
}

export interface FsReadPluginOptions {
  /**
   * Roots outside the workspace that are read without an approval prompt.
   *
   * A thunk for the same reason `rootDir` is one, and with one more: these roots
   * come from SERVICES (the spill directory is a service the tree provides), and a
   * plugin may not read a service at assembly time — the row that provides it
   * activates later, so an eager read throws `ServiceUnavailable` before the tree
   * has loaded. Reading it inside the classifier is also what keeps it correct
   * when a provider is replaced underneath.
   */
  trustedReadRoots?: () => readonly string[];
  /**
   * The LIVE workspace root. A thunk, not a string: the approval classifier runs
   * before every call and `switch_workspace` re-points the root underneath it,
   * so a value captured at load time would keep grading paths against the
   * workspace the session has already left.
   */
  rootDir: () => string;
}

export function fsReadPlugin(options: FsReadPluginOptions): Plugin {
  const trustedReadRoots = options.trustedReadRoots ?? (() => []);
  const rootDir = options.rootDir;
  return {
    name: 'fs-read',
    description: 'Read files and list directories inside the workspace.',
    manifest: { title: '读取文件', description: '读取工作区内文件与列目录；越界需审批。', tier: 'core' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(ctx, {
        name: 'read_file',
        description:
          'Reads a text file — use this instead of shell cat/head/tail. Paths inside the workspace are read freely; paths outside it require user approval. Args: path (required, absolute or workspace-relative), offset (1-based start line, optional), limit (max lines, default 400).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, workspace-relative or absolute.' },
            offset: { type: 'number', description: '1-based line number to start from.' },
            limit: { type: 'number', description: 'Maximum number of lines to return (default 400).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        /** In-root reads are free; out-of-root reads cross the sandbox boundary. */
        permissionFor(args) {
          return rootPermissionKind(rootDir(), args['path'], trustedReadRoots());
        },
        async execute(args, c: ToolExecuteContext) {
          return executeReadFile(args, c);
        },
        presentResult(args, content) {
          return readResultView(args, content);
        },
        // Read-only: safe to dispatch concurrently with sibling reads.
        isConcurrencySafe() {
          return true;
        },
      }, 'read');

      registerTool(ctx, {
        name: 'list_dir',
        description:
          "Lists a directory's entries (directories first, files with their size in bytes) — use this instead of shell ls. Paths inside the workspace are read freely; paths outside it require user approval. Args: path (optional, defaults to the workspace root).",
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path, workspace-relative or absolute.' },
          },
          additionalProperties: false,
        },
        permissionFor(args) {
          return rootPermissionKind(rootDir(), strArg(args, 'path') ?? '.', trustedReadRoots());
        },
        async execute(args, c: ToolExecuteContext) {
          return executeListDir(args, c);
        },
        presentResult(args, content) {
          return listViewResultView(args, content);
        },
        // Read-only: safe to dispatch concurrently with sibling reads.
        isConcurrencySafe() {
          return true;
        },
      }, 'read');
    },
  };
}

/**
 * Last-known (mtimeMs, size) per canonical path, maintained by read_file and
 * the write tools. edit_file uses it as a staleness guard: the model edits a
 * snapshot it read earlier — if the file moved under it (user edits, another
 * tool), applying old_string against the old bytes silently clobbers or
 * corrupts. Process-scoped state is fine: one CLI process runs one session.
 */
const fileVersions = new Map<string, { mtimeMs: number; size: number }>();
/** LRU bound: a long session touching thousands of files must not grow this unbounded. */
const FILE_VERSIONS_MAX = 512;

function recordVersion(file: string, info: { mtimeMs: number; size: number }): void {
  // Delete-then-set keeps the entry freshest (Map iterates insertion order),
  // so the eviction below always drops the LEAST recently recorded version.
  fileVersions.delete(file);
  fileVersions.set(file, { mtimeMs: info.mtimeMs, size: info.size });
  if (fileVersions.size > FILE_VERSIONS_MAX) {
    const oldest = fileVersions.keys().next().value;
    if (oldest !== undefined) fileVersions.delete(oldest);
  }
}

async function recordVersionNow(file: string): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (info === undefined) fileVersions.delete(file);
  else recordVersion(file, info);
}

/** Error message when the file changed on disk since the last read/write. */
async function staleError(file: string): Promise<string | undefined> {
  const known = fileVersions.get(file);
  if (known === undefined) return undefined; // never seen this session — no baseline
  // Touch: a file under active editing must not be the one evicted.
  fileVersions.delete(file);
  fileVersions.set(file, known);
  const current = await stat(file).catch(() => undefined);
  if (current === undefined) return 'file was deleted or moved since it was last seen; re-read it before editing';
  if (current.mtimeMs !== known.mtimeMs || current.size !== known.size) {
    return `file changed on disk since it was last read (mtime/size differ) — the old snapshot is stale; re-read it with read_file before editing`;
  }
  return undefined;
}

/**
 * Same-directory tmp + rename: readers never observe a half-written file and
 * a crash leaves the previous content in place.
 */
async function atomicWrite(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.noa-tmp-${process.pid}-${(Math.random() * 2 ** 32).toString(36)}`);
  await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
  try {
    // Carry the replaced file's mode over (exec bit survives edits; a fresh
    // file keeps the umask default). No-op semantics on Windows — harmless.
    const prior = await stat(file).catch(() => undefined);
    if (prior !== undefined) await chmod(tmp, prior.mode);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export function fsWritePlugin(options: { rootDir: () => string }): Plugin {
  const rootDir = options.rootDir;
  return {
    name: 'fs-write',
    description: 'Create, overwrite and edit files inside the workspace.',
    manifest: { title: '写入文件', description: '在工作区内创建、覆盖与编辑文件。', tier: 'core' },
    inject: [toolsKey],
    apply: (ctx) => {
      registerTool(ctx, {
        name: 'write_file',
        description:
          'Creates or overwrites a text file (parent directories are created). Args: path (required), content (required).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, workspace-relative or absolute.' },
            content: { type: 'string', description: 'Full file content to write.' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        /**
         * Graded per call, not statically: the same tool is free inside the
         * workspace and reviewed outside it (see `rootWriteKind`). A throwing
         * classifier would fail closed to `execute` in the registry, so this one
         * never throws.
         */
        async permissionFor(args) {
          return await rootWriteKind(rootDir(), args['path']);
        },
        /** Show what an approval would actually write (read-only). */
        async preview(args) {
          try {
            const file = await resolveReal(rootDir(), args['path']);
            const content = typeof args['content'] === 'string' ? args['content'] : '';
            const rel = path.relative(rootDir(), file) || file;
            const firstLine = (content.split('\n', 1)[0] ?? '').slice(0, 80);
            return `写入 ${rel}（${content.length} 字符）${content.length > 0 ? `\n首行: ${firstLine}` : '（空文件）'}`;
          } catch {
            return '';
          }
        },
        async execute(args, c: ToolExecuteContext) {
          return executeWriteFile(args, c);
        },
        presentCall(args) {
          return writeCallView(args);
        },
        presentResult(args, content) {
          return diffResultView(writeCallView(args), content);
        },
      }, 'write');

      registerTool(ctx, {
        name: 'edit_file',
        description:
          'Replaces an exact substring in a text file. Args: path (required), old_string (required), new_string (required), replace_all (optional boolean). Fails if old_string is not found or appears multiple times without replace_all.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path, workspace-relative or absolute.' },
            old_string: { type: 'string', description: 'Exact text to replace.' },
            new_string: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence instead of failing on multiples.' },
          },
          required: ['path', 'old_string', 'new_string'],
          additionalProperties: false,
        },
        /** Same per-call grading as `write_file` (see `rootWriteKind`). */
        async permissionFor(args) {
          return await rootWriteKind(rootDir(), args['path']);
        },
        /** Unified-ish diff shown above the approval prompt (read-only). */
        async preview(args) {
          let file: string;
          let oldString: string;
          let newString: string;
          try {
            file = await resolveReal(rootDir(), args['path']);
            oldString = strArg(args, 'old_string') ?? '';
            newString = strArg(args, 'new_string') ?? '';
            if (oldString.length === 0) return '';
          } catch {
            return '';
          }
          let text: string;
          try {
            text = await readFile(file, 'utf8');
          } catch {
            return '';
          }
          const played = applyEdit(text, oldString, newString, args['replace_all'] === true);
          const rel = path.relative(rootDir(), file) || file;
          if (played === undefined) return `编辑 ${rel}：old_string 未命中（预览不可用）`;
          // execute() rejects count>1 WITHOUT replace_all (it only replaces
          // the first), so the honest preview names the error up front instead
          // of promising "N 处替换".
          const head =
            played.count > 1 && args['replace_all'] !== true
              ? `编辑 ${rel}（命中 ${played.count} 处，执行将报错——需 replace_all 或更长唯一片段）：`
              : `编辑 ${rel}（${played.count} 处替换）：`;
          const out: string[] = [head];
          const add = (prefix: string, side: string): void => {
            for (const line of side.split('\n')) {
              if (out.length >= PREVIEW_MAX_LINES) {
                out.push('  …');
                return;
              }
              out.push(`${prefix}${line}`);
            }
          };
          add('- ', oldString);
          add('+ ', newString);
          return out.join('\n');
        },
        async execute(args, c: ToolExecuteContext) {
          return executeEditFile(args, c);
        },
        presentCall(args) {
          return editCallView(args);
        },
        presentResult(args, content) {
          return diffResultView(editCallView(args), content);
        },
      }, 'write');
    },
  };
}

/** Preview diff side length cap (approval popup rows are precious). */
const PREVIEW_MAX_LINES = 17;