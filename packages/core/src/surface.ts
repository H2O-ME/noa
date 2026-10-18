/**
 * The surface-plugin contract — the public API a human-facing end implements.
 *
 * The browser UI, the readline REPL, the bot channel and the headless runners
 * are all implementations of `AgentSurface`. A surface package declares one,
 * the cli loads it from `~/.noa/config.json` (`surfaces`) and asks it
 * `claim(request)` to decide who serves this argv; the winner gets
 * `start(runtime)` with a host-assembled kernel and the surface-affordance
 * command port the host lends it. A third-party surface package depends on
 * nothing above `core`/`plugins` — the same "everything is a plugin" posture
 * tools/commands/hooks already have, now extended to the human-facing end.
 *
 * This is the public contract the `surfaces` capability seam (see
 * `plugin/capabilities.ts`) is shaped around; the registry that loads and
 * resolves these lives in the plugins package (`loadSurfacePlugins`).
 *
 * All types here, no runtime — core stays provider- and host-agnostic, the same
 * way `runAgent` takes a `ChatProvider` interface. The concrete `Kernel` the
 * host passes structurally satisfies `AgentSurfaceKernel`.
 */
import type { ToolViewSource } from './presentation.js';

export interface AgentSurface {
  readonly name: string;
  /** Interactive surfaces treat stray positionals as noise, not as a task. */
  readonly interactive?: boolean;
  /**
   * This surface can answer `ask_user_question` (a person is at this end). The
   * host derives the kernel's `userQuestions` flag from this declaration rather
   * than from a hand-copied line per assembly site — so the fail-closed default
   * (unattended runs never get an answerer they cannot release) stays the
   * default, and a surface with a human opts in exactly once, here.
   */
  readonly answersQuestions?: boolean;
  /** Does this invocation belong to this surface? */
  claim(request: AgentSurfaceRequest): boolean;
  /** Workspace switch feedback the host wires the `switch_workspace` tool to. */
  onWorkspaceChanged?(dir: string, skillCount: number): void | Promise<void>;
  /** Run it. The host assembled the kernel and lends the surface its knobs. */
  start(runtime: AgentSurfaceRuntime): Promise<void>;
}

/** What a surface is told about the invocation it may claim. */
export interface AgentSurfaceRequest {
  readonly rootDir: string;
  /** The raw argv after the program name (a surface parses its own flags). */
  readonly argv: readonly string[];
  /** Both stdio ends are a TTY. */
  readonly interactive: boolean;
  /** Host-owned flags, parsed once and offered to every surface. */
  readonly flags: AgentSurfaceFlags;
}

/** Host-owned flags a surface may read (its own opt-in flags come from `argv`). */
export interface AgentSurfaceFlags {
  readonly resumeFile?: string;
  readonly approval?: string;
  readonly theme?: string;
  readonly json: boolean;
  readonly repl: boolean;
  readonly web: boolean;
  readonly positional: readonly string[];
}

/** A non-fatal config problem a surface may want to show. */
export interface AgentSurfaceDiagnostic {
  readonly code: string;
  readonly message: string;
}

/**
 * What a surface that claimed an invocation receives: the assembled kernel, the
 * surface-affordance command port the host lends it, and the host-resolved
 * presentation values it cannot derive itself (model, context window, theme)
 * without reaching across the package boundary the plugin model forbids.
 */
export interface AgentSurfaceRuntime {
  readonly request: AgentSurfaceRequest;
  readonly kernel: AgentSurfaceKernel;
  readonly commands: AgentSurfaceCommands;
  readonly diagnostics: readonly AgentSurfaceDiagnostic[];
  /** Live model id (reads through to the provider, so it survives `/model`). */
  readonly model: () => string;
  readonly listModels: () => Promise<readonly string[]>;
  readonly contextWindow?: number;
  /** Lazily resolve the context window off the critical path (models.dev). */
  readonly resolveContextWindow?: () => Promise<number | undefined>;
  readonly autoCompactTokenLimit?: number;
  readonly theme: string;
  readonly homeDir: string;
}

/**
 * What a surface receives: the assembled kernel (session handle plus the
 * product-agnostic knobs a surface drives). Deliberately structural — the
 * concrete bundle is the plugins package' `Kernel`, widened here so any
 * surface package can type against core only (the host passes a real `Kernel`,
 * which structurally satisfies this).
 *
 * What is NOT here is as deliberate: no execution mode, no model seat, no
 * workspace-provider vocabulary. Which code modes exist is one plugin's business
 * and its settings live in its own config row, so a surface never needs a kernel
 * member named after that plugin. A member here would be core holding one
 * plugin's vocabulary in the contract every surface must implement.
 */
/**
 * One plugin row as `AgentSurfaceKernel.roster()` reports it — the structural
 * slice of the kernel's own roster entry that a surface may read.
 *
 * Mirrored structurally for the same reason the rest of this file is: a surface
 * package types against `core` only, and core learns no plugin's name from it.
 * What matters to a surface is the four facts the reader needs — which ROW, what
 * state, is it switched on, and (when it is not up) why.
 */
export interface AgentSurfacePluginRow {
  /** The row id as the operator's `plugins.entries` writes it. */
  readonly name: string;
  /** Container state: `active` / `disabled` / `failed` / `pending` / `loading`. */
  readonly state: string;
  /**
   * Whether the row is loaded. A FAILED row reads `false` here too — it has no
   * fiber — which is exactly why `error` has to be consulted first.
   */
  readonly enabled: boolean;
  /** Why the row has no fiber although it should have one. Absent when healthy. */
  readonly error?: string;
}

export interface AgentSurfaceKernel {
  readonly agent: import('./kernel/session.js').AgentSession;
  readonly skills: readonly { readonly name: string }[];
  readonly host: {
    readonly toolEntries: readonly { readonly plugin: string; readonly tool: ToolViewSource }[];
  };
  readonly jobs: { dispose(): Promise<void> };
  /**
   * Every plugin row as the roster reports it — failed and switched-off rows
   * included.
   *
   * A surface must be able to be honest about the rows it depends on: `nova
   * qqbot` has to tell the operator whether its row is missing, off, or
   * unloadable (three different next actions), and a terminal surface has to name
   * the row that did not come up instead of silently dropping it from its banner.
   * Both answers are the same read, and it names no plugin: the surface asks for
   * the row IT cares about by id.
   */
  roster(): readonly AgentSurfacePluginRow[];
  rootDir(): string;
  setWorkspace(dir: string): Promise<readonly { readonly name: string }[]>;
  dispose(): Promise<void>;
}

/**
 * The slash-command affordances the host lends a surface: the live catalog
 * (so the surface renders one menu, not its own copy) and the one runner (so a
 * command does the same thing to the kernel regardless of which surface ran it).
 * The surface supplies the presentation half via `AgentSurfaceUi`.
 */
export interface AgentSurfaceCommands {
  catalog(): readonly { readonly name: string; readonly usage: string; readonly description: string }[];
  run(input: string, ui: AgentSurfaceUi): Promise<AgentSurfaceCommandResult>;
}

/** `'handled'` = consumed; `'exit'` = shut the surface down; `{prompt}` = send it. */
export type AgentSurfaceCommandResult = 'handled' | 'exit' | { readonly prompt: string };

/** The presentation half of a command port — what the surface, not the host, owns. */
export interface AgentSurfaceUi {
  note(text: string, tone?: 'info' | 'warn'): void;
  clear(): void;
  /** Follow a NEW session handle (`/new`, session switch). */
  bindSession(agent: import('./kernel/session.js').AgentSession): void;
  /** The live theme name (`/theme` with no argument reports it). */
  theme(): string;
  setTheme(theme: string): void;
  /** The surface's own model picker: the chosen id, or undefined when cancelled. */
  pickModel(models: readonly string[]): Promise<string | undefined>;
  exit(): void | Promise<void>;
}
