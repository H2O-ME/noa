import { errMessage, isFailureContent, objectConfig, SKIP_DIRS, tools as toolsKey } from '@noa/core';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  ConfigSchema,
  Context,
  FileLocation,
  Plugin,
  SearchCallView,
  SearchResultView,
  ToolExecuteContext,
} from '@noa/core';
import { typeStrippingAvailable } from '@noa/core';
import { registerTool } from '../toolbox.js';
import { looksBinary, resolveAnywhere, rootPermissionKind } from './fs.js';
import { intArg, strArg } from './args.js';

/**
 * Workspace search tool — the coding-agent staple codex/pi ship as
 * first-class tools and this project previously routed through bash (which
 * does not exist or means different things under the PowerShell fallback).
 * Two modes: name globbing (find files) and line-wise content regex
 * (find code). Reads only; safe to dispatch concurrently.
 *
 * content_regex runs MODEL-PROVIDED patterns, so its line loop lives in a
 * dedicated worker thread with a wall-clock budget: a catastrophic
 * backtracking regex cannot freeze the host event loop (Ctrl+C would never
 * reach it otherwise), and expiry hard-terminates the worker with an error
 * the model can self-correct from. name_glob stays in-process — its glob is
 * compiled by globToRegExp and cannot backtrack.
 */

/** Content search never reads more than this per file (bounds regex cost). */
const SCAN_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const MAX_RESULTS_CAP = 1000;
/** Search scans never enter symlinked directories (loop/escape safety). */

/** Regex pre-flight budget: patterns over these are refused before any run. */
const REGEX_MAX_LENGTH = 512;
const REGEX_MAX_QUANTIFIERS = 32;

/**
 * The `search` row's OWN settings, validated by the row's own schema.
 *
 * Distinct from `SearchRuntimeOptions` below: these are what an operator writes
 * in the row's `config`, so the host never reads them by name — a new setting is
 * a change to THIS file alone.
 */
export interface SearchPluginSettings {
  /** Wall-clock ceiling for one content_regex worker run. Default 30s. */
  wallMs?: number;
  /**
   * Run content_regex in an isolated worker thread (default true). The
   * in-process fallback exists for runtimes without worker type stripping
   * (source world on Node < 22.19); the pre-flight pattern screen applies on
   * both paths.
   */
  worker?: boolean;
}

/**
 * The kernel facts `search` is built with — NOT operator settings.
 *
 * `rootDir` and `trustedReadRoots` are live readers of kernel state (the
 * workspace in force; the spill directory, which is a SERVICE another row
 * provides), so they cannot come from the row's `config`: they are thunks the
 * assembly binds, and `trustedReadRoots` in particular must stay lazy because
 * the providing row activates AFTER the built-ins are constructed.
 */
export interface SearchRuntimeOptions {
  trustedReadRoots?: () => readonly string[];
  /**
   * The LIVE workspace root. A thunk, not a string: the approval classifier
   * grades every call against the root in force, and `switch_workspace`
   * re-points it mid-session.
   */
  rootDir: () => string;
}

/**
 * Pre-flight screen for model-provided regexes: cheap static checks refuse
 * the classic catastrophic-backtracking shapes up front (instant feedback,
 * one spawn saved) — the worker's wall clock is the real backstop for
 * everything the screen cannot see.
 */
export function screenContentRegex(pattern: string): string | undefined {
  if (pattern.length > REGEX_MAX_LENGTH) {
    return `content_regex is ${pattern.length} chars (over the ${REGEX_MAX_LENGTH} cap) — narrow the pattern`;
  }
  const quantifiers = (pattern.match(/[+*?{]/g) ?? []).length;
  if (quantifiers > REGEX_MAX_QUANTIFIERS) {
    return `content_regex has ${quantifiers} quantifiers (over the ${REGEX_MAX_QUANTIFIERS} cap) — split it into simpler alternatives`;
  }
  // A quantified group containing another quantifier — `(a+)+`, `(\w+\s*)+`
  // — is the textbook exponential-backtracking shape.
  if (/\([^)]*[+*?][^)]*\)[+*?{]/.test(pattern)) {
    return 'content_regex looks prone to catastrophic backtracking (a quantified group containing another quantifier) — rewrite it without nested quantifiers, e.g. replace (a+)+ with a+';
  }
  return undefined;
}

/** Minimal glob → RegExp over '/'-joined relative paths: `**`, `*`, `?`. */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

interface WalkHalt {
  halted: boolean;
  /** Why the walk stopped: result-cap truncation vs an abort signal. */
  truncated: boolean;
  aborted: boolean;
}

/**
 * Recursive directory walk. Skips dot-directories and the heavy standard
 * roots (node_modules / dist / .git), and never follows symlinks — both as a
 * speed measure and so a symlink loop or a link out of the workspace
 * cannot make the search scan foreign paths. The halt flag is checked at
 * every entry and re-checked before each file callback so an abort signal
 * stops the in-process walk promptly.
 */
async function walk(dir: string, onFile: (file: string, dirent: { size: number }) => Promise<void>, halt: WalkHalt): Promise<void> {
  if (halt.halted) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined || halt.halted) return;
  for (const entry of entries) {
    if (halt.halted) return;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), onFile, halt);
    } else if (entry.isFile()) {
      if (halt.halted) return;
      const info = await stat(path.join(dir, entry.name)).catch(() => undefined);
      if (info !== undefined && info.isFile()) await onFile(path.join(dir, entry.name), info);
    }
  }
}

/** Truncation note template shared with the worker via workerData. */
const TRUNCATED_NOTE_TEMPLATE = '\n（已达结果上限 %d，缩小范围或改用 bash 检索其余部分）';

/**
 * The worker entry path, mirroring ptc/code-runtime's WORKER_PATH resolution:
 * the source world (vitest/tsx) loads the .ts file through Node's native
 * type stripping; the built package ships the sibling .mjs bundle.
 */
const WORKER_PATH = new URL(
  new URL(import.meta.url).pathname.endsWith('.ts') ? './search-worker.ts' : './search-worker.mjs',
  import.meta.url,
);

/**
 * One content_regex run in a fresh worker: the pattern (model-provided,
 * potentially catastrophic-backtracking) executes off the host event loop,
 * bounded by a wall-clock ceiling. Timeout/abort hard-terminates the worker
 * — the only deterministic way to stop a regex mid-backtrack — and returns
 * an error the model can self-correct from.
 */
function runInWorker(
  root: string,
  contentRegex: string,
  caseInsensitive: boolean,
  maxResults: number,
  wallMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let worker: Worker;
    try {
      worker = new Worker(WORKER_PATH, {
        workerData: { root, contentRegex, caseInsensitive, maxResults, skipDirs: [...SKIP_DIRS], scanMaxBytes: SCAN_MAX_BYTES, truncatedNoteTemplate: TRUNCATED_NOTE_TEMPLATE },
      });
    } catch (err) {
      resolve(`Error: cannot spawn search worker: ${errMessage(err)}`);
      return;
    }
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      void worker.terminate().finally(() => resolve(value));
    };
    const onAbort = (): void => {
      finish('Error: search aborted before completion — narrow the scope (path/max_results) and retry');
    };
    worker.on('message', (msg: { type?: string; text?: string; error?: string }) => {
      if (settled || msg?.type !== 'done') return;
      if (msg.error !== undefined) finish(`Error: search failed: ${msg.error}`);
      else finish(msg.text ?? '');
    });
    worker.on('error', (err: Error) => {
      finish(`Error: search worker crashed: ${err.message}`);
    });
    // A crashed/exited worker without a message settles through 'exit' only
    // if nothing arrived first; the normal done-message path beats it.
    worker.on('exit', () => {
      if (!settled) finish('Error: search worker exited before completing');
    });
    timer = setTimeout(() => {
      finish(
        `Error: content_regex search exceeded its ${wallMs}ms wall-clock budget — the pattern or scan scope is too expensive. Rewrite the regex (avoid nested quantifiers like (a+)+) or narrow the search path.`,
      );
    }, wallMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One search_files call: choose name_glob vs content_regex, gate the regex,
 * and either delegate to the worker (model-provided pattern runs off the host
 * event loop) or scan in-process. Extracted from the plugin factory so the
 * factory body is only schema + wiring.
 */
async function executeSearch(
  args: Record<string, unknown>,
  c: ToolExecuteContext,
  wallMs: number,
  wantWorker: boolean,
): Promise<string> {
  const nameGlob = strArg(args, 'name_glob');
  const contentRegex = strArg(args, 'content_regex');
  if (nameGlob === undefined && contentRegex === undefined) {
    return 'Error: provide name_glob or content_regex';
  }
  if (contentRegex !== undefined) {
    // Pre-flight screen on BOTH paths: instant refusal beats a spawn
    // (worker) or a frozen event loop (fallback) for the classic
    // catastrophic-backtracking shapes.
    const screen = screenContentRegex(contentRegex);
    if (screen !== undefined) return `Error: ${screen}`;
  }
  let re: RegExp | undefined;
  if (contentRegex !== undefined) {
    try {
      re = new RegExp(contentRegex, args['case_insensitive'] === true ? 'i' : '');
    } catch (err) {
      return `Error: invalid content_regex: ${errMessage(err)}`;
    }
  }
  const nameRe = nameGlob === undefined ? undefined : globToRegExp(nameGlob);
  const root = resolveAnywhere(c.rootDir, strArg(args, 'path') ?? '.');
  const rootInfo = await stat(root).catch(() => undefined);
  if (rootInfo === undefined || !rootInfo.isDirectory()) {
    return `Error: cannot search directory: ${strArg(args, 'path') ?? '.'}`;
  }
  const maxResults = Math.min(MAX_RESULTS_CAP, Math.max(1, intArg(args, 'max_results') ?? DEFAULT_MAX_RESULTS));

  const results: string[] = [];
  const halt: WalkHalt = { halted: false, truncated: false, aborted: false };
  // The in-process walk checks halt at every entry; wire the abort
  // signal so Ctrl+C stops it promptly (the worker path gets the
  // signal directly via terminate()).
  const onAbort = (): void => {
    halt.halted = true;
    halt.aborted = true;
  };
  if (c.signal?.aborted) onAbort();
  else c.signal?.addEventListener('abort', onAbort, { once: true });
  const relOf = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  const truncateAtLimit = (): void => {
    halt.halted = true;
    halt.truncated = true;
  };
  const haltNote = (): string => {
    if (halt.truncated) return TRUNCATED_NOTE_TEMPLATE.replace('%d', String(maxResults));
    if (halt.aborted) return '\n（搜索已中止）';
    return '';
  };

  // content_regex: the model-provided pattern runs isolated in a
  // worker bounded by the wall clock — a catastrophic-backtracking
  // regex cannot freeze the host event loop (Ctrl+C included).
  if (re !== undefined) {
    if (wantWorker) {
      return runInWorker(root, contentRegex!, args['case_insensitive'] === true, maxResults, wallMs, c.signal);
    }
    // In-process fallback (runtime without worker type stripping).
    await walk(
      root,
      async (file, info) => {
        const rel = relOf(file);
        if (info.size > SCAN_MAX_BYTES) return;
        const text = await readFile(file, 'utf8').catch(() => undefined);
        if (text === undefined) return;
        if (looksBinary(text)) return;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && !halt.halted; i++) {
          if (re.test(lines[i]!)) {
            results.push(`${rel}:${i + 1}: ${lines[i]!.trimEnd()}`);
            if (results.length >= maxResults) truncateAtLimit();
          }
        }
      },
      halt,
    );
    c.signal?.removeEventListener('abort', onAbort);
    if (results.length === 0) return '(no matches)';
    return results.join('\n') + haltNote();
  }

  // name_glob: the glob compiles to a backtrack-free RegExp; stays
  // in-process (no spawn latency for a directory listing).
  await walk(
    root,
    async (file) => {
      const rel = relOf(file);
      if (nameRe !== undefined && nameRe.test(rel) && results.length < maxResults) {
        results.push(rel);
        if (results.length >= maxResults) truncateAtLimit();
      }
    },
    halt,
  );
  c.signal?.removeEventListener('abort', onAbort);
  if (results.length === 0) return '(no matches)';
  return results.join('\n') + haltNote();
}

/** Trailing operator notes this tool appends to a result body (not hits). */
const SEARCH_NOTE_RE = /^（(?:已达结果上限|搜索已中止)/;

/** Render intent for a search call: which pattern, and matched against what. */
function searchCallView(args: Record<string, unknown>): SearchCallView | undefined {
  const content = strArg(args, 'content_regex');
  if (content !== undefined) return { card: 'search', kind: 'search', query: content, mode: 'content' };
  const glob = strArg(args, 'name_glob');
  if (glob !== undefined) return { card: 'search', kind: 'search', query: glob, mode: 'name' };
  return undefined;
}

/** `path:line: text` → a jump target; anything unparsable is not a hit. */
function parseHitLine(line: string): FileLocation | undefined {
  const hit = /^(.+?):(\d+): /.exec(line);
  if (hit === null) return undefined;
  const num = Number(hit[2]);
  return { path: hit[1] ?? '', line: num };
}

/**
 * search_files result view. The `path:line: text` / bare-path line format is
 * this file's contract with its own `presentResult` (same discipline as bash):
 * the worker and the in-process fallback both emit it, and a format change
 * cannot strand a UI because an unrecognized body yields no locations.
 */
function searchResultView(args: Record<string, unknown>, content: string): SearchResultView | undefined {
  const call = searchCallView(args);
  if (call === undefined || isFailureContent(content)) return undefined;
  const lines = content.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 1 && lines[0] === '(no matches)') {
    return { card: 'search', matches: [], truncated: false };
  }
  const hits = lines.filter((line) => !SEARCH_NOTE_RE.test(line));
  return {
    card: 'search',
    matches: call.mode === 'content'
      ? hits.map(parseHitLine).filter((hit): hit is FileLocation => hit !== undefined)
      : hits.map((path) => ({ path })),
    truncated: hits.length !== lines.length,
  };
}

/**
 * The `search` row's settings schema — the operator's half of the split above.
 */
export const Config: ConfigSchema<SearchPluginSettings> = objectConfig<SearchPluginSettings>({
  wallMs: { type: 'number' },
  worker: { type: 'boolean' },
});

export function searchPlugin(options: SearchRuntimeOptions): Plugin<SearchPluginSettings> {
  const trustedReadRoots = options.trustedReadRoots ?? (() => []);
  const rootDir = options.rootDir;
  return {
    name: 'search',
    description: 'Recursive file/content search inside the workspace.',
    manifest: { title: '搜索', description: '按文件名或内容递归检索工作区。', tier: 'core' },
    Config,
    inject: [toolsKey],
    apply: (ctx: Context, config: SearchPluginSettings): void => {
      const settings = config ?? {};
      const wallMs = settings.wallMs ?? 30_000;
      // The source world runs this file through native type stripping, so the
      // .ts worker entry only loads on runtimes that support it; without it the
      // in-process path stays available (pre-flight screen still applies).
      const wantWorker = settings.worker !== false && typeStrippingAvailable();
      registerTool(ctx, {
        name: 'search_files',
        description:
          'Searches the workspace tree — use this instead of shell grep/rg/find. Provide name_glob (find files whose workspace-relative path matches a glob like "**/*.test.ts" or "*.ts") OR content_regex (find files whose text matches a regex, returning matching lines as path:line: text). path: starting directory (default workspace root). Skips .git, node_modules, dist and dot-directories; symlinks are never followed. Returns at most max_results hits (default 200).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory to search, workspace-relative or absolute (default workspace root).' },
            name_glob: { type: 'string', description: 'Glob matched against workspace-relative paths ("**", "*" and "?" allowed).' },
            content_regex: { type: 'string', description: 'Regular expression matched line-by-line against file contents.' },
            case_insensitive: { type: 'boolean', description: 'Case-insensitive matching (default false).' },
            max_results: { type: 'number', description: `Maximum result lines (default ${DEFAULT_MAX_RESULTS}, cap ${MAX_RESULTS_CAP}).` },
          },
          additionalProperties: false,
        },
        /** Same sandbox classification as the read tools. */
        permissionFor(args) {
          return rootPermissionKind(rootDir(), strArg(args, 'path') ?? '.', trustedReadRoots());
        },
        execute: (args, c) => executeSearch(args, c, wallMs, wantWorker),
        presentCall(args) {
          return searchCallView(args);
        },
        presentResult(args, content) {
          return searchResultView(args, content);
        },
        // Read-only: safe to dispatch concurrently with sibling reads.
        isConcurrencySafe() {
          return true;
        },
        // Cooperates with the loop's per-tool timeout as a second ceiling on
        // the worker route (the wall clock terminates the worker first).
        timeoutMs: wallMs + 5_000,
      }, 'read');
    },
  };
}