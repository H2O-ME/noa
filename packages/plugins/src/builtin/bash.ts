import { errMessage, objectConfig, shell as shellKey, tools as toolsKey } from '@noa/core';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { commandInvocation, modelShell } from './shell-select.js';
import type {
  ConfigSchema,
  Context,
  JobRegistry,
  JobSnapshot,
  Plugin,
  TerminalCallView,
  TerminalResultView,
  ToolExecuteContext,
} from '@noa/core';
import { registerTool } from '../toolbox.js';

export interface BashPluginOptions {
  /** Hard cap per command in ms; the model may request less. Default 60000. */
  timeoutMs?: number;
  /** Explicit shell binary override (e.g. "C:\\Program Files\\Git\\bin\\bash.exe"). */
  shellPath?: string;
  /** Max raw output kept in memory before truncation, bytes. Default 256 KiB. */
  maxOutputBytes?: number;
}

/** Default per-command wall clock when the workspace config sets none. */
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;
/** Default in-memory output cap; the same figure the job registry uses per read. */
export const DEFAULT_BASH_OUTPUT_BYTES = 256 * 1024;
/**
 * Grace after the process is gone before settling anyway: the exit event fires
 * before stdio `close`, so we wait briefly for the last buffered output to
 * flush. Shared by the foreground run and the background job (same reason).
 */
const SETTLE_GRACE_MS = 2_000;
/**
 * Backstop after a kill request: a tree kill can leave the pipes open, so
 * neither `close` nor `exit` ever arrives. Settle deterministically after this
 * budget instead of hanging the turn. Shared by the foreground run and jobs.
 */
const KILL_SETTLE_MS = 3_000;

interface ShellInvocation {
  cmd: string;
  args: string[];
}

interface ShellOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  /** Bytes dropped from the middle of output (head + tail retained). */
  droppedBytes?: number;
}

/**
 * Byte-budgeted stream capture keeping BOTH ends of the output, mirroring the
 * core's tool-result contract (`HEAD_TAIL_RATIO` in core/agent.ts): the head
 * 60% gives the summary, a ring-buffered tail 40% keeps the most recent
 * output — which is where test failures and stack traces live. The old
 * head-only capture silently threw away exactly the part that matters.
 * `dropped` counts the middle bytes that fit neither segment, so callers can
 * report them instead of pretending the output was intact.
 */
export class BudgetedBuffer {
  private head: Buffer[] = [];
  private tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private droppedBytes_ = 0;
  private readonly headBudget: number;
  private readonly tailBudget: number;
  /**
   * Carries an incomplete trailing UTF-8 sequence across drains: jobs reads
   * split output at arbitrary read boundaries, and without decoder state a
   * multi-byte char (CJK, emoji) spanning two reads would surface as two
   * replacement glyphs instead of one char on the second read.
   */
  private readonly decoder = new StringDecoder('utf8');

  constructor(maxBytes: number) {
    this.headBudget = Math.floor(maxBytes * 0.6);
    this.tailBudget = maxBytes - this.headBudget;
  }

  get dropped(): number {
    return this.droppedBytes_;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    let remaining = chunk;
    if (this.headBytes < this.headBudget) {
      const take = remaining.subarray(0, this.headBudget - this.headBytes);
      this.headBytes += take.length;
      this.head.push(take);
      if (take.length >= remaining.length) return;
      remaining = remaining.subarray(take.length);
    }
    // Ring-buffer the tail: evict the oldest tail bytes until the new chunk
    // fits (an eviction IS a middle byte: the head is full, the tail front
    // is no longer "most recent").
    while (remaining.length > this.tailBudget - this.tailBytes && this.tail.length > 0) {
      const front = this.tail.shift()!;
      this.tailBytes -= front.length;
      this.droppedBytes_ += front.length;
    }
    const space = this.tailBudget - this.tailBytes;
    if (remaining.length > space) {
      // A single chunk larger than the whole tail budget (a big pipe burst):
      // keep the chunk's END — the newest bytes are the ones that matter.
      const keep = Math.min(remaining.length, space);
      const start = remaining.length - keep;
      this.tail.push(remaining.subarray(start));
      this.tailBytes += keep;
      this.droppedBytes_ += remaining.length - keep;
    } else {
      this.tail.push(remaining);
      this.tailBytes += remaining.length;
    }
  }

  concat(): string {
    return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
  }

  /**
   * Return the accumulated output AND drain it: subsequent reads see only new
   * output (the `jobs` tool contract — action=output reads since last read).
   * Decoded through the held StringDecoder state; an eviction seam (genuinely
   * dropped middle bytes) can still show a replacement glyph — those bytes no
   * longer exist.
   */
  drain(): { text: string; dropped: number } {
    const text = this.decoder.write(Buffer.concat([...this.head, ...this.tail]));
    const dropped = this.droppedBytes_;
    this.head = [];
    this.tail = [];
    this.headBytes = 0;
    this.tailBytes = 0;
    this.droppedBytes_ = 0;
    return { text, dropped };
  }
}

/**
 * The command form for this session's shell, resolved UP FRONT.
 *
 * There used to be a second answer at spawn time: try `bash.exe`, and on an
 * ENOENT retry as PowerShell — while the context fragment had already declared
 * one of the two to the model. `modelShell` probes the PATH once, so the shell
 * that runs the command is the shell the model was told about, and a spawn
 * failure is a failure rather than a silent family switch.
 */
function invocation(command: string, shellPath?: string): ShellInvocation {
  const shell = modelShell(shellPath);
  return commandInvocation(shell.family, command, shellPath);
}

/**
 * Kill a spawned shell AND its whole child process tree. A bare
 * `child.kill()` only terminates the shell itself — on Windows the spawned
 * grandchildren (vitest under pnpm, node under npm) keep running. POSIX spawns
 * are `detached` (the child leads its own process group), so a negative-pid
 * SIGKILL takes down the whole group in one shot; Windows keeps the taskkill
 * tree kill.
 */
function killShell(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // /T = tree, /F = force. Fire-and-forget: the close event settles the outcome.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // negative pid = the whole group
  } catch {
    // Group already gone (or the child never became a leader) — fall back.
    child.kill('SIGKILL');
  }
}

/**
 * Child env: force Python's UTF-8 mode so heredoc scripts emit UTF-8 on the
 * GBK-default Windows console — without this every python one-liner needs
 * the `sys.stdout = io.TextIOWrapper(sys.stdout.buffer, …)` boilerplate to
 * avoid UnicodeEncodeError (observed 40+ times in one session). Inherited
 * otherwise; harmless on POSIX.
 */
function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
}

function runOnce(
  inv: ShellInvocation,
  rootDir: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
  onOutput?: (text: string) => void,
): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.cmd, inv.args, {
        cwd: rootDir,
        env: childEnv(),
        windowsHide: true,
        // POSIX: the child leads its own process group, so killShell's negative-pid
        // SIGKILL reaches the whole tree; Windows keeps taskkill /T /F.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', spawnError: errMessage(err) });
      return;
    }

    const stdoutBuf = new BudgetedBuffer(maxOutputBytes);
    const stderrBuf = new BudgetedBuffer(maxOutputBytes);
    // Streaming decoders: a UTF-8 char split across pipe chunks must not
    // reach the progress feed as replacement glyphs.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const feed = (text: string): void => {
      if (text.length > 0) onOutput?.(text);
    };

    let settled = false;
    let exitCode: number | null = null;
    let killed = false;
    let closeGrace: NodeJS.Timeout | undefined;
    let killSettle: NodeJS.Timeout | undefined;
    let timer: NodeJS.Timeout | undefined;

    /**
     * The single settle point. On Windows a tree-kill can leave the stdio
     * pipes open (MSYS grandchildren escape the taskkill snapshot), and the
     * `close` event may then never fire — waiting on it alone hangs the tool
     * forever (observed: a killed command reported as running for 13+ min).
     * We destroy the pipes ourselves and settle with whatever output was
     * collected; `exit` alone is enough to decide the outcome.
     */
    const finish = (spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (closeGrace !== undefined) clearTimeout(closeGrace);
      if (killSettle !== undefined) clearTimeout(killSettle);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const droppedBytes = stdoutBuf.dropped + stderrBuf.dropped;
      resolve({
        code: exitCode,
        stdout: stdoutBuf.concat(),
        stderr: stderrBuf.concat(),
        ...(droppedBytes > 0 ? { droppedBytes } : {}),
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    };

    const kill = (): void => {
      killed = true;
      killShell(child);
      // If the tree kill leaves the pipes open, neither `close` nor even
      // `exit` may arrive in time — settle deterministically right after.
      killSettle ??= setTimeout(() => finish(), KILL_SETTLE_MS);
    };

    timer = setTimeout(() => kill(), timeoutMs);
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      // Decode BEFORE the storage cap: progress display stays live even for
      // commands whose output already exceeded maxOutputBytes.
      feed(outDecoder.write(chunk));
      stdoutBuf.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      feed(errDecoder.write(chunk));
      stderrBuf.push(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(`${err.code ?? 'ERROR'}: ${err.message}`);
    });
    child.on('exit', (code) => {
      // Process is dead — the outcome is decided. Give `close` a short grace
      // to flush the last buffered output, then finish regardless. A killed
      // process reports exit code 1 on Windows — report null instead so the
      // result reads as "did not exit", not as a command that failed.
      exitCode = killed ? null : code;
      closeGrace = setTimeout(() => finish(), SETTLE_GRACE_MS);
    });
    child.on('close', (code) => {
      exitCode = killed ? null : (code ?? exitCode);
      finish();
    });
  });
}

interface BackgroundHandle {
  /** Resolves with the process exit outcome after resources are released. */
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>;
  cancel: (reason?: string) => void;
  readOutput: () => string;
}

/**
 * Prefix for the "middle bytes hidden" notice bash reports on truncation.
 * Kept short so it never hides the head it annotates.
 */
const TRUNCATE_HINT = '[nova: output truncated] ';

/**
 * Spawn a detached background job: stdout/stderr stream into a byte-capped
 * buffer, cancel is a synchronous idempotent kill, and `done` settles only
 * after the process exits and its resources are released (dsh jobs contract).
 * Returns an error string when the shell binary cannot be spawned.
 */
function startBackground(
  inv: ShellInvocation,
  rootDir: string,
  outputLimitBytes: number,
): BackgroundHandle | string {
  let child;
  try {
    child = spawn(inv.cmd, inv.args, {
      cwd: rootDir,
      env: childEnv(),
      windowsHide: true,
      // POSIX: the child leads its own process group, so killShell's negative-pid
      // SIGKILL reaches the whole tree; Windows keeps taskkill /T /F.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return errMessage(err);
  }

  const buf = new BudgetedBuffer(outputLimitBytes);
  let killed = false;

  const collect = (chunk: Buffer): void => {
    buf.push(chunk);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let resolvedDone = false;
  let exitCode: number | null = null;
  let killSettle: NodeJS.Timeout | undefined;
  /**
   * The single settle point, mirroring runOnce's Windows defense: a tree kill
   * can leave the stdio pipes held by MSYS grandchildren that escaped the
   * taskkill snapshot, and the `close` event then never fires — waiting on it
   * alone hangs `done` forever, which hangs `jobs.dispose()` at session
   * teardown. Settle on `exit` after a short flush grace, or right after the
   * kill; destroy the pipes ourselves.
   */
  const settle = (outcome: { status: 'completed' | 'killed' | 'failed'; detail?: string }): void => {
    if (resolvedDone) return;
    resolvedDone = true;
    if (killSettle !== undefined) clearTimeout(killSettle);
    child.stdout?.destroy();
    child.stderr?.destroy();
    resolveDone(outcome);
  };
  const describeExit = (): { status: 'completed' | 'killed' | 'failed'; detail?: string } =>
    killed
      // No detail for a killed job: the exit code is deliberately nulled above
      // (Windows reports 1), so "exit code: null" would be the only possible
      // string — a fact with no content where the status word already speaks.
      ? { status: 'killed' }
      : exitCode === 0
        ? { status: 'completed', detail: 'exit code: 0' }
        : exitCode === null
          ? { status: 'failed', detail: 'command did not exit cleanly' }
          : { status: 'failed', detail: `exit code: ${exitCode}` };

  let resolveDone: (outcome: { status: 'completed' | 'killed' | 'failed'; detail?: string }) => void = () => {};
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string }>((resolve) => {
    resolveDone = resolve;
  });
  child.on('error', (err: NodeJS.ErrnoException) => {
    settle({ status: 'failed', detail: `${err.code ?? 'ERROR'}: ${err.message}` });
  });
  child.on('exit', (code) => {
    // Process is dead — the outcome is decided; `close` gets a short grace to
    // flush the last buffered output, then we settle regardless.
    exitCode = killed ? null : code;
    killSettle ??= setTimeout(() => settle(describeExit()), SETTLE_GRACE_MS);
  });
  child.on('close', (code) => {
    exitCode = killed ? null : (code ?? exitCode);
    settle(describeExit());
  });

  return {
    done,
    cancel: () => {
      if (killed) return;
      killed = true;
      killShell(child);
      // If the tree kill leaves the pipes open, even `exit` may not arrive
      // in time — settle deterministically right after.
      killSettle ??= setTimeout(() => settle(describeExit()), KILL_SETTLE_MS);
    },
    readOutput: () => {
      const { text, dropped } = buf.drain();
      // A truncated tail is the norm for chatty builds; say so once instead of
      // silently returning the head+tail splice as if it were complete.
      return dropped > 0 ? `${TRUNCATE_HINT}${dropped} bytes kept out of view.\n${text}` : text;
    },
  };
}

/** One command to run as a background job: the shell, the cwd and the owner. */
export interface BashJobRequest {
  /** The command line, verbatim (the shell it lands in decides what it means). */
  command: string;
  /** Working directory the command runs in (the bash tool's root rule). */
  rootDir: string;
  /** The registry that owns the job; the job outlives the turn that asked. */
  jobs: JobRegistry;
  /**
   * The session that owns the job. REQUIRED at this boundary (the registry's
   * `JobStart` normalizes a missing owner to `''`): an unowned job is listed and
   * announced everywhere, and this is the surface most likely to spawn one.
   */
  sessionId: string;
  /** Retention cap for the live output ring; defaults to the bash tool's. */
  outputLimitBytes?: number;
  /** The configured shell binary; absent = `bash` with the PowerShell fallback. */
  shellPath?: string;
}

/**
 * Spawn one shell command as a background job, resolving the shell exactly as
 * the bash tool does.
 *
 * Exported because a caller that is NOT the model's tool call still wants a
 * shell command with the same shell resolution, the same process-tree kill and
 * the same byte-capped output ring — the web surface's terminal panel is that
 * caller. A second spawn implementation would drift from the tool's Windows
 * fallback and its tree-kill, which are the two things that took the longest to
 * get right here; this is the same code path, one entry point further out.
 *
 * @param req - the command, its working directory, its owning registry/session.
 * @returns the started job's snapshot, or a `Error: …` string the caller shows
 *   verbatim (the bash tool's own result convention).
 */
export function startBashJob(req: BashJobRequest): JobSnapshot | string {
  const command = req.command;
  if (command.trim().length === 0) return 'Error: command is required';
  const outputLimitBytes = req.outputLimitBytes ?? DEFAULT_BASH_OUTPUT_BYTES;
  // The SAME up-front resolution the foreground path uses: a missing
  // executable would surface as an async ENOENT event, too late to reconsider.
  const inv = invocation(command, req.shellPath);
  const handle = startBackground(inv, req.rootDir, outputLimitBytes);
  if (typeof handle === 'string') return `Error: cannot spawn shell (${inv.cmd}): ${handle}`;
  return req.jobs.start({
    kind: 'bash',
    label: command,
    sessionId: req.sessionId,
    outputLimitBytes,
    cancel: handle.cancel,
    done: handle.done,
    readOutput: handle.readOutput,
  });
}

/**
 * Run a foreground bash command or start a detached job (run_in_background).
 * Shared by every caller that drives the bash tool — extracted so the plugin
 * factory body is only schema + wiring.
 */
async function executeBash(
  args: Record<string, unknown>,
  c: ToolExecuteContext,
  defaultTimeoutMs: number,
  maxOutputBytes: number,
  shellPath: string | undefined,
): Promise<string> {
  const command = typeof args['command'] === 'string' ? args['command'] : '';
  if (command.trim().length === 0) return 'Error: command is required';
  const requested = typeof args['timeout_ms'] === 'number' ? Math.trunc(args['timeout_ms']) : undefined;
  const timeoutMs = Math.min(Math.max(1000, requested ?? defaultTimeoutMs), Math.max(1000, defaultTimeoutMs));

  if (args['run_in_background'] === true) {
    if (c.jobs === undefined) return 'Error: background jobs are not available in this context';
    // One spawn path with the web terminal: both go through `startBashJob`, so
    // the Windows PowerShell fallback and the tree kill cannot differ between
    // the model's command and the operator's.
    const started = startBashJob({
      command,
      rootDir: c.rootDir,
      jobs: c.jobs,
      sessionId: c.sessionId ?? '',
      outputLimitBytes: maxOutputBytes,
      ...(shellPath !== undefined ? { shellPath } : {}),
    });
    if (typeof started === 'string') return started;
    return `Started background job ${started.id}: ${command}\nYou will be notified automatically when it finishes — do not poll. When notified, read its output once with the jobs tool (action=output, id=${started.id}); use action=stop to terminate it early.`;
  }

  // Long-running commands stream their raw output to the UI as it
  // arrives, so the tool line can show a live tail instead of looking
  // frozen until the process exits.
  const onOutput = c.onProgress !== undefined ? (text: string): void => c.onProgress?.(text) : undefined;
  const inv = invocation(command, shellPath);
  const outcome = await runOnce(inv, c.rootDir, timeoutMs, maxOutputBytes, c.signal, onOutput);
  if (outcome.spawnError !== undefined) {
    return `Error: cannot spawn shell (${inv.cmd}): ${outcome.spawnError}`;
  }

  const parts: string[] = [];
  // The directory the command actually ran in, first and always. It is the
  // one fact a result cannot imply: when this ever disagrees with the
  // session's `<environment> cwd`, every relative command in the turn was
  // answered about the wrong tree, and a log that omits it cannot tell the
  // difference (see the empty-`find` session of 2026-10-01).
  parts.push(`cwd: ${c.rootDir}`);
  if (outcome.code === null) parts.push('[command did not exit: killed after timeout or aborted]');
  parts.push(`exit: ${outcome.code ?? 'null'}`);
  if (outcome.droppedBytes !== undefined) {
    parts.push(`[stdout/stderr truncated: ${outcome.droppedBytes} bytes in the middle kept out of view]`);
  }
  parts.push(`stdout:\n${outcome.stdout.length > 0 ? outcome.stdout : '(empty)'}`);
  if (outcome.stderr.length > 0) parts.push(`stderr:\n${outcome.stderr}`);
  return parts.join('\n');
}

/**
 * Parse the `exit: N` / `stdout:` / `stderr:` shape that `executeBash` above
 * produces back into a structured terminal card. Lives beside the formatter on
 * purpose: the text layout is this file's private contract with its own
 * `presentResult`, so a format change can never silently strand a UI — and no
 * other module may parse bash output. Unrecognized text (spawn errors, a
 * background-job handle) returns undefined and renders as a generic card.
 */
export function bashResultView(content: string): TerminalResultView | undefined {
  const head = /(?:^|\n)exit: (\d+|null)(?:\n|$)/.exec(content);
  if (head === null) return undefined;
  const marker = 'stdout:\n';
  const at = content.indexOf(marker);
  const dropped = /truncated: (\d+) bytes in the middle/.exec(content);
  const raw = head[1] ?? 'null';
  return {
    card: 'terminal',
    output: at === -1 ? '' : content.slice(at + marker.length),
    exitCode: raw === 'null' ? null : Number(raw),
    ...(dropped !== null ? { droppedBytes: Number(dropped[1] ?? '0') } : {}),
  };
}

/** The command a bash call wants to run, or undefined when there is none. */
function bashCommand(args: Record<string, unknown>): string | undefined {
  const command = args['command'];
  return typeof command === 'string' && command.trim().length > 0 ? command : undefined;
}

/**
 * The `bash` row's own settings, validated by the row's own schema.
 *
 * These live on the PLUGIN, not in a host-side options bag: the loader hands
 * every row its `config` from `plugins.entries` and the fiber validates it
 * against `Config` below, so the host never reads bash's config by name — and a
 * new configurable setting is a change to THIS file alone.
 */
export const Config: ConfigSchema<BashPluginOptions> = objectConfig<BashPluginOptions>({
  timeoutMs: { type: 'number' },
  shellPath: { type: 'string' },
  maxOutputBytes: { type: 'number' },
});

export function bashPlugin(): Plugin<BashPluginOptions> {
  return {
    name: 'bash',
    description: 'Run shell commands in the workspace root (POSIX shell on Windows via Git Bash, PowerShell fallback).',
    manifest: { title: '终端命令', description: '在工作区根目录执行 shell 命令，支持后台任务。', tier: 'standard' },
    Config,
    inject: [toolsKey],
    apply: (ctx: Context, config: BashPluginOptions): void => {
      // Read HERE rather than at construction: a config edit reaches the row
      // through the loader's own diff (`apply` runs again), so nothing needs to
      // fingerprint the settings to know when to rebuild the plugin object.
      const settings = config ?? {};
      const defaultTimeoutMs = settings.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
      const maxOutputBytes = settings.maxOutputBytes ?? DEFAULT_BASH_OUTPUT_BYTES;
      // Publish WHICH shell commands run in, because this row is what owns that
      // answer: the context fragment tells the model the shell it is working in,
      // and reading bash's config from the host would put this row's name in host
      // code — and would go stale the moment the operator set `shellPath` or
      // swapped this plugin for another. `ctx.provide` ties the value to this
      // fiber, so switching the row off withdraws it and the consumer falls back
      // to probing the environment.
      const resolved = modelShell(settings.shellPath);
      ctx.provide(shellKey, { name: resolved.name, path: resolved.path });
      registerTool(ctx, {
        name: 'bash',
        description:
          'Runs a shell command in the workspace root. Args: command (required), timeout_ms (optional, capped by configuration), run_in_background (optional boolean; returns a job handle instead of waiting). Returns exit code plus captured stdout/stderr. Use for git, pnpm, tests, etc.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run.' },
            timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds.' },
            run_in_background: {
              type: 'boolean',
              description: 'Start detached and return a job id immediately; read progress with the jobs tool.',
            },
          },
          required: ['command'],
          additionalProperties: false,
        },
        execute: (args, c) => executeBash(args, c, defaultTimeoutMs, maxOutputBytes, settings.shellPath),
        // The command IS the approval: a surface that shows only the tool name
        // (a chat channel, say) would be asking its human to authorize blind.
        preview(args) {
          return bashCommand(args) ?? '';
        },
        presentCall(args): TerminalCallView | undefined {
          const command = bashCommand(args);
          return command === undefined ? undefined : { card: 'terminal', kind: 'execute', command };
        },
        presentResult(_args, content) {
          return bashResultView(content);
        },
      }, 'execute');
    },
  };
}
