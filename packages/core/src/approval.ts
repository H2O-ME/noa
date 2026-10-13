/**
 * Approval vocabulary (moved out of the plugins package for the surface
 * rewrite): the answer shapes a human gives a gated tool call live in
 * `plugins/permission.ts`, but the KERNEL event stream carries them too
 * (`approval_request` / `resolveApproval`), and core must not import plugins.
 *
 * The engine (three-tier modes, remembered grants, fail-closed normalization)
 * stays in plugins' `PermissionService`; this file owns the vocabulary and the
 * `ApprovalBroker` — the request/response seam an `AgentSession` uses to ask a
 * remote or local surface and wait for its answer as an event on the stream.
 */
import { newId } from './ids.js';
import { hasControlChars } from './text.js';
import type { ToolCall, ToolPermissionKind } from './types.js';
import type { ToolCallView } from './presentation.js';

export type ApprovalMode = 'read-only' | 'auto-edit' | 'full';
export type AskAnswer = 'allow' | 'deny' | 'always';
/**
 * An "always" answer carrying an explicit grant scope: the answerer may pin
 * the memory to the FIRST N WORDS of the command instead of the default
 * program prefix. Validated against the actual call by the permission engine;
 * an out-of-range N falls back to the default scope.
 */
export interface AlwaysGrant {
  answer: 'always';
  scopeWords: number;
}
/**
 * A denial carrying the reason the user typed — the reason rides into the
 * tool result so the model receives the instruction, not a bare denial.
 */
export interface DenyGrant {
  answer: 'deny';
  reason: string;
}
export type AskResult = AskAnswer | AlwaysGrant | DenyGrant;
export type AskFn = (call: ToolCall, kind: ToolPermissionKind) => Promise<AskResult>;
/** Cap on a scope-pinned "always" grant's word count (untrusted input lands here). */
export const MAX_ALWAYS_SCOPE_WORDS = 32;
/** Cap on a user-typed denial reason — an instruction to the model, not a transcript. */
export const MAX_DENY_REASON_CHARS = 400;

/** Chaining/substitution markers — a command containing them grants whole-command memory only. */
function isCompoundCommand(command: string): boolean {
  return /[&;|\n\r]/.test(command) || command.includes('$(') || command.includes('`');
}

/** A leading `NAME=value` token: an environment assignment, not the program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The PROGRAM a bare command invokes: the first token that is not a leading
 * `NAME=value` environment assignment. `NOVA=1 git status` → `git`.
 *
 * The assignment prefix matters for the "always" grant: remembering
 * `exec:nova=1` (the raw first token) would let a later `NOVA=1 rm -rf ~`
 * match the same key and skip approval, so the memory must key on the program
 * the user actually approved. `undefined` for compound commands (no word-prefix
 * semantics) or a command made only of assignments.
 */
export function commandProgram(command: unknown): string | undefined {
  return alwaysScopeWords(command)[0]?.toLowerCase();
}

/**
 * The word list an execute command can scope an "always" grant over: a bare
 * (non-compound) command's tokens STARTING AT THE PROGRAM; [] for compound
 * commands, where only whole-command memory is safe (no meaningful word
 * prefix).
 *
 * Leading `NAME=value` assignments are dropped: pinning the first N words must
 * mean "this program onward", never "this env assignment". Keying a grant on
 * `NOVA=1` authorizes nothing (the assignment is not a program) while looking
 * like a grant, and it would let a later `NOVA=1 rm -rf ~` share the key.
 *
 * Lives here, beside `MAX_ALWAYS_SCOPE_WORDS`: the rule that produces the
 * options and the cap that validates them must not drift apart, and every
 * surface asks the same question — "what can the user pin?" — when it draws the
 * scope chooser. The permission engine (which owns the memory) reads the same
 * list to key what it remembers.
 */
export function alwaysScopeWords(command: unknown): string[] {
  if (typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (trimmed.length === 0 || isCompoundCommand(trimmed)) return [];
  const words = trimmed.split(/\s+/);
  let start = 0;
  while (start < words.length && ENV_ASSIGNMENT.test(words[start]!)) start++;
  return words.slice(start);
}

/**
 * Parse an UNTRUSTED approval answer — a WebUI frame, a Rust-bridge message, a
 * third-party asker's return value — into the kernel's `AskResult`.
 *
 * One parser, because three copies used to guard this seam with three different
 * notions of valid (`scopeWords ≤ 32` on one wire, any positive integer on the
 * plugin seam, reject-vs-truncate on a long reason). Both wire shapes are
 * accepted: the bare grant (`{scopeWords}` / `{reason}`, what a browser sends)
 * and the tagged one (`{answer:'always'|'deny', …}`, what a plugin asker
 * returns). Fail-closed: malformed input comes back `undefined` and the caller
 * decides — the WebUI rejects the frame with a reason, the permission engine
 * denies the call. Never an executable grant by guess.
 */
export function parseAskResult(value: unknown): AskResult | undefined {
  if (value === 'allow' || value === 'deny' || value === 'always') return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const declared = raw['answer'];
  // An explicit `answer` tag wins over shape-sniffing; an absent one means the
  // input came off a wire that only carries the grant itself.
  if (declared === 'always' || declared === undefined) {
    const scope = raw['scopeWords'];
    if (Number.isInteger(scope) && (scope as number) >= 1 && (scope as number) <= MAX_ALWAYS_SCOPE_WORDS) {
      return { answer: 'always', scopeWords: scope as number };
    }
  }
  if (declared === 'deny' || declared === undefined) {
    const reason = denialReason(raw['reason']);
    if (reason !== undefined) return { answer: 'deny', reason };
    // A tagged denial with no usable reason is still a denial.
    if (declared === 'deny') return 'deny';
  }
  return undefined;
}

/** Trim and clamp a typed denial reason; control bytes (newlines excepted) kill it. */
function denialReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || hasControlChars(raw, { multiline: true })) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, MAX_DENY_REASON_CHARS);
}
/** decideDetailed's verdict: deny may carry the user-typed reason. */
export type DecideResult = 'allow' | { decision: 'deny'; reason?: string };
/**
 * Session-level policy applied BEFORE any interactive answerer runs:
 * 'ask' delegates to the composed asker; 'never' deterministically denies
 * every ask without dispatching any asker (strict headless stance).
 */
export type ApprovalPolicy = 'ask' | 'never';

export interface ApprovalAudit {
  toolName: string;
  kind: ToolPermissionKind;
  outcome: AskAnswer;
}

/**
 * The permission-engine contract an `AgentSession` speaks. plugins'
 * `PermissionService` implements it structurally; a surface that assembles its
 * own engine can hand the session the same shape.
 *
 * `mode` and `policy` are deliberately NOT the same kind of fact, and separating
 * them is what makes a remote peer safe:
 *
 *  - `approvalMode` (read-only / auto-edit / full) and the remembered grants
 *    behind it belong to ONE conversation, so a session owns them. A peer that
 *    raises its tier must not raise anybody else's — which is why the engine is
 *    per session and the decision is routed by `ToolCallScope.sessionId`.
 *  - `approvalPolicy` ('ask' | 'never') is a property of the PROCESS: it says
 *    whether an interactive answerer exists at all. A headless runner pins it
 *    once and every session it creates inherits that, because there is no human
 *    anywhere in that process to consult. It is therefore shared by all sessions
 *    of a kernel.
 *
 * `decideDetailed` is the decision itself. It is optional so an embedder may
 * hand the loop only the readout (mode/policy) while some outer engine keeps the
 * decision — but a session that omits it cannot be the target of the approval
 * gate, and the gate says so rather than guessing.
 */
export interface PermissionPort {
  readonly approvalMode: ApprovalMode;
  readonly approvalPolicy: ApprovalPolicy;
  setMode(mode: ApprovalMode): void;
  setPolicy(policy: ApprovalPolicy): void;
  /**
   * Decide one call end to end: remembered grants, the mode's auto-allow rules,
   * then the asker (which may prompt a human). Omitted means "this port cannot
   * decide", never "allow".
   */
  decideDetailed?(toolName: string, kind: ToolPermissionKind, call: ToolCall): Promise<DecideResult>;
  /** True while an ask is being dispatched for this port (a surface may render it). */
  outstandingAsks?(): readonly ApprovalRequest[];
}

/** One outstanding approval: everything a surface needs to render the ask. */
export interface ApprovalRequest {
  /** Correlation id; the answer comes back via `AgentSession.resolveApproval`. */
  id: string;
  call: ToolCall;
  kind: ToolPermissionKind;
  /** Render intent of the call (presentation vocabulary), when the tool declares one. */
  view?: ToolCallView;
  /** Post-args effect preview lines (e.g. edit_file's diff), best-effort. */
  preview?: string[];
  /**
   * The word list an "always" answer may be pinned to, for an execute call with
   * word-prefix semantics (see `alwaysScopeWords`). Empty/absent means the
   * surface offers only the default grant (the program prefix); the engine
   * validates whatever comes back either way.
   */
  scopeWords?: readonly string[];
}

/** Where a pending approval's wait ended. */
export type ApprovalResolution =
  | { source: 'user'; answer: AskResult }
  | { source: 'aborted' }
  | { source: 'closed' };

/**
 * Request/response bridge between the permission engine's `ask` seam and the
 * kernel's event stream: the asker publishes an `ApprovalRequest`, the surface
 * answers by id, and every outstanding waiter resolves — including fail-closed
 * denials when the run aborts or the session closes with asks outstanding.
 *
 * Serialization of concurrent asks (the modal collision guard) lives in
 * `PermissionService.enqueueAsk`, not here: by the time the broker sees an
 * ask, the engine has already dequeued it one at a time.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, (r: AskResult) => void>();
  private readonly requests = new Map<string, ApprovalRequest>();
  /** Installed by the owning AgentSession; called for live surfaces only. */
  private publish: ((request: ApprovalRequest) => void) | undefined;
  private resolved: ((id: string, resolution: ApprovalResolution) => void) | undefined;
  private closed = false;

  constructor(
    private readonly viewFor: (call: ToolCall) => ToolCallView | undefined,
    private readonly previewFor?: (call: ToolCall, kind: ToolPermissionKind) => Promise<string[]>,
  ) {}

  attach(
    publish: (request: ApprovalRequest) => void,
    onResolved: (id: string, resolution: ApprovalResolution) => void,
  ): void {
    this.publish = publish;
    this.resolved = onResolved;
  }

  /** Outstanding requests in ask order (a reconnecting surface re-renders these). */
  outstanding(): ApprovalRequest[] {
    return [...this.requests.values()];
  }

  /** The `AskFn` to hand a `PermissionService`. */
  readonly asker: AskFn = async (call, kind) => {
    if (this.closed) return 'deny';
    const view = this.viewFor(call);
    const words = alwaysScopeWords(call.args['command']);
    const request: ApprovalRequest = {
      id: newId('apr'),
      call,
      kind,
      ...(view !== undefined ? { view } : {}),
      // Only an execute call with more than a program name has anything to
      // choose: with one word the default grant IS the whole command.
      ...(kind === 'execute' && words.length > 1 ? { scopeWords: words } : {}),
    };
    // Effect preview is best-effort and rides BEFORE the prompt surfaces, so
    // an approval modal can show what the call WILL do, not just its args.
    if (this.previewFor !== undefined) {
      try {
        const lines = await this.previewFor(call, kind);
        if (lines.length > 0) request.preview = lines;
      } catch {
        // preview failure never blocks the ask
      }
    }
    if (this.closed) return 'deny';
    // Register the waiter BEFORE publishing. A surface may answer inside the
    // publish call — a scripted client, a bot channel replying in the same
    // tick, any listener that already knows the verdict — and an answer landing
    // before the resolver existed used to be swallowed by a placeholder
    // (`pending.set(id, () => undefined)`), which also removed the request from
    // `outstanding()`. The ask then never settled: the run hung on it with
    // nothing left to answer.
    return new Promise<AskResult>((resolve) => {
      this.pending.set(request.id, resolve);
      this.requests.set(request.id, request);
      try {
        this.publish?.(request);
      } catch (err) {
        // A throwing publisher must not strand the ask either (fail closed).
        this.pending.delete(request.id);
        this.requests.delete(request.id);
        resolve('deny');
        throw err;
      }
    });
  };

  /** Answer one outstanding request. Unknown/closed ids return false. */
  resolve(id: string, answer: AskResult): boolean {
    const settle = this.pending.get(id);
    if (settle === undefined) return false;
    this.pending.delete(id);
    this.requests.delete(id);
    settle(answer);
    this.resolved?.(id, { source: 'user', answer });
    return true;
  }

  /**
   * Fail-closed sweep: every outstanding ask resolves as deny. 'aborted' is
   * per-run (the session can keep asking next turn); 'closed' is terminal.
   */
  failAll(reason: 'aborted' | 'closed'): void {
    if (reason === 'closed') this.closed = true;
    for (const settle of this.pending.values()) {
      settle('deny');
    }
    this.pending.clear();
    const ids = [...this.requests.keys()];
    this.requests.clear();
    for (const id of ids) {
      this.resolved?.(id, { source: reason });
    }
  }
}
