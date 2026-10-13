import type { ImageAttachmentRef } from './images.js';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** raw JSON string as emitted by the provider; kept for replay fidelity */
  rawArgs: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface UsageStats {
  turns: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /**
   * Cache-waste audit (pi cache-stats style): tokens paid at full input price
   * because they were not served from the provider prefix cache. Counted per
   * turn above a noise floor, and only once the provider has reported cache
   * activity at least once (a provider that never reports caching must not
   * make every turn look like a total miss).
   */
  missTokens: number;
  /** Turns whose miss exceeded the noise floor. */
  missTurns: number;
}

export interface BaseMessage {
  id: string;
  ts: number;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string;
  /**
   * Images the user attached to THIS message, as durable references.
   *
   * References rather than bytes because the log is append-only and replayed:
   * embedding base64 here would put megabytes into every projection, and the
   * bytes already live under their own digest. Absent (not empty) when the
   * message carries none, so a text-only log stays byte-identical to what it
   * was before images existed.
   *
   * Whether these are actually SENT as image content depends on the model in
   * force at request time, not at capture time — see `acceptsImages`.
   */
  images?: readonly ImageAttachmentRef[];
  /**
   * Request-only resolved copy of `images`, attached by core's request
   * assembly after it has (a) confirmed the model in force accepts images and
   * (b) read the bytes back from the store.
   *
   * Present only on the throwaway array handed to the provider, never on a
   * logged message: the log keeps references, and this field is how the
   * provider gets base64 without either layer reaching into the other's job.
   * A message carrying references but no `resolvedImages` renders as text.
   */
  resolvedImages?: readonly ResolvedImage[];
}

/** One image's bytes, ready to be inlined into a provider request. */
export interface ResolvedImage {
  mediaType: string;
  /** Canonical base64 of the exact stored bytes. */
  data: string;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  finishReason?: string;
}

export interface ToolResultMessage extends BaseMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  /** set when content was truncated and the full output was offloaded to disk */
  truncatedRef?: string;
  /**
   * Structured post-call metadata a tool attaches to its own result so a
   * surface can render a richer view than the string the model sees (a genui
   * spec, a validated form, a typed payload). Optional and tool-owned: absent
   * on every built-in tool today; never sent to the model (it joins only the
   * surface wire), so adding it cannot change the prompt prefix or cache key.
   * The host treats it as opaque JSON-safe data and never inspects its shape.
   */
  meta?: Record<string, unknown>;
}

/**
 * Messages form an append-only log: existing entries are never rewritten.
 * This invariant is what keeps the provider prompt prefix stable across
 * turns and is the foundation of cache-hit-rate management.
 */
export type AgentMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type JsonSchema = Record<string, unknown>;

// Deferred import type to keep jobs.ts colocated with the loop contract.
type JobRegistry = import('./jobs.js').JobRegistry;

/** One nested tool call dispatched from inside another tool (PTC sub-call). */
export interface ToolDispatchCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Outcome of a nested dispatch. `ok: false` covers pipeline-level refusals
 * (permission denied, unknown tool, aborted run) — the sub-call never reached
 * a settled execution. A tool that ran and returned its own "Error: ..." text
 * is `ok: true`: exactly what the native loop would have logged.
 */
export type ToolDispatchResult = { ok: true; result: string } | { ok: false; error: string };

export interface ToolExecuteContext {
  rootDir: string;
  /**
   * Cooperative cancellation: the loop passes the run's abort signal, merged
   * with a per-call timeout signal when the tool declares `timeoutMs`. Async
   * work should observe or forward it; the loop never hard-kills same-process
   * code that ignores it.
   */
  signal?: AbortSignal;
  /** Background-job registry for tools that spawn long-running work. */
  jobs?: JobRegistry;
  /**
   * The session this call runs in.
   *
   * Required for any tool that registers a background job: the registry is
   * per-process, so a job without an owner is listed by every session and
   * announced into whichever one happens to be open when it settles.
   */
  sessionId?: string;
  /**
   * Persist a log-only session event (e.g. todo/write snapshots) without
   * joining the model surface. Wired by the host to the open session log.
   */
  emit?: (evt: import('./session.js').SessionEvent) => void | Promise<void>;
  /**
   * The directory oversized tool results are offloaded to for this run — the
   * host wires it per session. Tools that delegate nested runs forward it, so
   * a nested loop spills into the same conversation's cache instead of the
   * global fallback.
   */
  cacheDir?: string;
  /**
   * Live progress feed for long-running tools (bash output tail etc.),
   * forwarded from AgentOptions.onToolProgress. Fire-and-forget: consumers
   * render it best-effort and tools must not depend on it existing.
   */
  onProgress?: (text: string) => void;
  /**
   * Dispatch a nested tool call through the loop's FULL pipeline — the same
   * permission gate, beforeToolCall hooks, per-tool timeout and cooperative
   * abort a native call goes through (PTC mode: run_code routes its program
   * bindings here, so a program can never reach a tool the user would not be
   * asked about). Sub-calls never touch the message log; the dispatcher
   * returns their settled text to the calling tool. `signal` overrides the
   * run signal for this sub-call (run_code passes its run-scoped controller
   * so budget expiry or settlement aborts in-flight sub-calls).
   */
  dispatch?: (call: ToolDispatchCall, signal?: AbortSignal) => Promise<ToolDispatchResult>;
}

/** Internal tool IR; provider adapters map this to wire formats. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<string> | string;
  /**
   * Cooperative per-call timeout budget in milliseconds, enforced by the
   * loop through `ctx.signal` (plus a race fallback). NEVER sent to the
   * model — only name/description/parameters join the request.
   */
  timeoutMs?: number;
  /**
   * Pure synchronous classifier for overlap with sibling tool calls. Only
   * `true` opts in; calls whose classifier returns true may execute in a
   * parallel group with adjacent opted-in calls. Opted-in executions must
   * not mutate shared state and must tolerate concurrent dispatch.
   */
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  /**
   * Per-call permission classification: overrides the tool's static kind for
   * one specific invocation. Used by fs reads to escalate out-of-workspace
   * paths to the approval-gated `read-external` kind while in-workspace reads
   * stay auto-allowed. May be async: sandbox-aware classifiers resolve real
   * paths (symlinks) before deciding.
   */
  permissionFor?(args: Record<string, unknown>): ToolPermissionKind | Promise<ToolPermissionKind>;
  /**
   * The tool owns PER-SESSION state (a todo board, a goal): its writes are
   * only meaningful inside the conversation whose state they mutate. A nested
   * ephemeral run (a subagent) EXCLUDES such tools from its toolset instead of
   * letting them write into the parent's state or — worse — silently pretend
   * success because no log sink is wired. Optional; absent means the tool is
   * stateless with respect to the conversation and safe to nest.
   */
  ownsSessionState?: boolean;
  /**
   * Optional human-readable preview of a call's effect, rendered above
   * approval prompts (e.g. the edit diff of edit_file). Must never mutate
   * state — the caller may invoke it before permission is granted.
   */
  preview?(args: Record<string, unknown>, ctx: { rootDir: string }): Promise<string> | string;
  /**
   * Provider-neutral **render intent** for one call, decided before it runs
   * (approval prompts, live tool rows). Optional: a tool without it renders as
   * a generic card from `{name, args}` — never unrenderable, only less
   * specific. Must be *pure and synchronous*: it is called before permission is
   * granted, so it cannot read the filesystem or await anything (a surface that
   * needs post-grant detail uses `preview` instead).
   */
  presentCall?(args: Record<string, unknown>): import('./presentation.js').ToolCallView | undefined;
  /**
   * Render intent for the result, given the string `execute` returned. Also
   * pure. Return `undefined` for anything unrecognized — the surface falls back
   * to a generic card over the raw text, so an evolving tool never breaks a UI.
   */
  presentResult?(
    args: Record<string, unknown>,
    content: string,
  ): import('./presentation.js').ToolResultView | undefined;
  /**
   * Structured metadata to attach to the result message a tool produces, so a
   * surface can render a richer view than the string the model sees (a genui
   * spec, a validated form, a typed payload). Optional and tool-owned: the host
   * persists it onto the `ToolResultMessage.meta` field and forwards it over
   * the surface wire — never onto the model-visible request, so it does not
   * perturb the prefix-stable prompt or the cache key.
   *
   * Pure and synchronous (mirrors `presentResult`): called once per settled
   * call, after `execute` resolves. Returning `undefined` is the same as not
   * declaring the hook — the message ships without `meta`.
   */
  resultMeta?(args: Record<string, unknown>, content: string): Record<string, unknown> | undefined;
}

/**
 * Approval kinds a tool call can require. `read-external` is a read that
 * reaches outside the workspace root: auto-allowed only in `full` mode,
 * otherwise it goes through the interactive approval gate.
 */
export type ToolPermissionKind = 'read' | 'read-external' | 'write' | 'execute' | 'network';

/** Events emitted by a ChatProvider during a single completion stream. */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; finishReason?: string }
  /**
   * The provider discarded its in-flight response (mid-stream failure) and is
   * re-requesting within its retry budget. Consumers must drop every
   * accumulator fed by this attempt (partial text, tool-call deltas, usage,
   * finish reason) — the retry replays from scratch. Never emitted before the
   * first event of an attempt (those retries are transparent).
   */
  | { type: 'reset'; attempt: number; maxRetries: number; error: string };

export interface ChatRequest {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

/**
 * Provider contract implemented by packages/ai.
 *
 * The three model-end members are OPTIONAL capabilities, not part of the loop:
 * the loop only ever calls `stream`, and a surface's model picker is the sole
 * reader of the rest. Making them optional is what keeps a scripted test
 * provider (or a third-party gateway shim) a valid `ChatProvider` while still
 * letting the kernel offer a real picker whenever the client can answer.
 */
export interface ChatProvider {
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /** Model id in force, when the client owns one (display + metadata lookups). */
  readonly model?: string;
  /**
   * Retarget THIS client at another model. In-place on purpose: the kernel,
   * the session handles and the roster all hold the same instance, so a
   * rebuilt client would strand the cache-affinity binding.
   */
  setModel?(model: string): void;
  /**
   * The endpoint's own catalog (`GET /models`), for the picker.
   * @param timeoutMs - override for this call's deadline. The boot-time id
   *   reconciliation passes a SHORT one: it runs before any surface exists, and
   *   a slow gateway must not delay startup by the full request timeout.
   */
  listModels?(timeoutMs?: number): Promise<string[]>;
}

/** JSON-safe shape check for rewritten tool args (see validateToolCallVerdict). */
function isJsonSafeValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return true;
  if (kind !== 'object') return false;
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(value)) return value.every((item) => isJsonSafeValue(item, seen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.values(value as Record<string, unknown>).every((item) => isJsonSafeValue(item, seen));
}

/**
 * Verdict a beforeToolCall hook returns for one tool call. A DISCRIMINATED
 * union, not a flat bag of optionals: each action carries exactly the fields
 * it needs, so a hook cannot smuggle rewrite args inside a deny (or vice
 * versa) and the composer can validate the verdict structurally instead of
 * trusting the hook's goodwill. Unknown extra fields are ignored; a verdict
 * whose action is not one of the three is rejected fail-closed (see
 * validateToolCallVerdict).
 */
export type ToolCallVerdict =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'rewrite'; args: Record<string, unknown> };

/**
 * Structural check for a beforeToolCall verdict at the composition boundary
 * (learn-agent ch4 `validateFor`, single-event edition). Accepts unknown so
 * hand-rolled hooks casting through `never`/`any` get a real runtime check,
 * not a type-level pass: returns an actionable reason when the verdict is
 * malformed, undefined when it is well-formed. Malformed verdicts MUST be
 * treated as deny (fail-closed):
 * a hook that returns garbage has proven itself untrustworthy, and the
 * alternative — guessing which action it meant — risks executing what it
 * meant to block.
 *
 * Well-formed means:
 * - action is exactly 'allow' | 'deny' | 'rewrite';
 * - 'rewrite' carries `args` as a plain (non-array) object — the composer
 *   re-serializes it, so anything else would execute as fabricated `{}`;
 * - 'deny' carries no `args` (a deny-with-args is contradictory: which half
 *   should win? reject and let the hook author disambiguate);
 * - 'allow' carries neither `args` nor `reason` (an allow-with-args is a
 *   rewrite in disguise and must go through the rewrite path to stay
 *   visible in the trust-seam audit).
 */
export function validateToolCallVerdict(verdict: unknown): string | undefined {
  if (verdict === null || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return 'verdict must be an object';
  }
  switch ((verdict as { action?: unknown }).action) {
    case 'allow':
      if ('args' in verdict) return 'allow verdict must not carry args (use rewrite to change arguments)';
      if ('reason' in verdict) return 'allow verdict must not carry reason';
      return undefined;
    case 'deny': {
      if ('args' in verdict) return 'deny verdict must not carry args';
      const reason = (verdict as { reason?: unknown }).reason;
      if (reason !== undefined && typeof reason !== 'string') {
        return 'deny reason must be a string';
      }
      return undefined;
    }
    case 'rewrite': {
      const args = (verdict as { args?: unknown }).args;
      if (args === undefined || typeof args !== 'object' || args === null || Array.isArray(args)) {
        return 'rewrite verdict must carry args as a plain object';
      }
      // JSON-safe only: the composer re-serializes these args into `rawArgs`
      // and hands the object straight to the tool, so a function/symbol/BigInt/
      // circular value would either desync the log from what executed or throw
      // while canonicalizing. Rejecting it fail-closed keeps the audit trail
      // and the execution in agreement.
      if (!isJsonSafeValue(args)) {
        return 'rewrite verdict args must be JSON-safe (no functions, symbols, BigInt or cycles)';
      }
      return undefined;
    }
    default:
      return `unknown verdict action ${(verdict as { action?: unknown }).action ?? '(missing)'}`;
  }
}

/**
 * Which run a tool call belongs to.
 *
 * ONE kernel can hold several sessions at once (a bot channel keeps one per
 * peer, the browser keeps one per open tab), and they run CONCURRENTLY — a
 * switch leaves the previous session's run going. So "which session is this
 * call from" cannot be read from a process-global "current session" slot: that
 * slot is a UI selection, not an execution fact, and reading it here is how a
 * peer's permission tier, remembered grants and approval prompt used to be
 * decided by whichever session happened to be current.
 *
 * It is therefore threaded EXPLICITLY from the run that issues the call through
 * the hook chain. `sessionId` is optional because embedding code (kernel tests,
 * an SDK caller) may drive the loop with no session of its own.
 */
export interface ToolCallScope extends ExecutionScope {}

/**
 * WHO and WHICH RUN an execution belongs to — the minimal facts a permission
 * decision, an audit record, or a job stamp needs about its origin.
 *
 * Threading is the security property: a nested run (a subagent, a background
 * job) INHERITS the scope of the run that spawned it, so its tool calls are
 * decided by the same conversation's permission engine instead of silently
 * falling back to a process-wide one. `signal` deliberately is not part of the
 * scope: cancellation already rides `AgentOptions.signal` and merging the two
 * would make "which signal wins" a second question with no second answer.
 */
export interface ExecutionScope {
  /** The session whose run issued this execution; undefined when the loop is bare. */
  sessionId?: string;
  /** The run inside the session; minted per `runAgent` invocation, stable across its calls. */
  runId?: string;
  /**
   * The permission subject in force — the principal whose tier decides. A
   * channel that constrains its sessions (a QQ caller cap) stamps it here so a
   * nested run cannot inherit a broader engine than its caller had.
   */
  principal?: string;
}

/**
 * Interception points of the agent loop. The plugin host composes all
 * plugin-registered hooks into one AgentHooks implementation.
 */
export interface AgentHooks {
  /** Chain: each hook may rewrite the request before it reaches the provider. */
  beforeLLMCall?(req: ChatRequest): Promise<ChatRequest>;
  /**
   * Permission gate / arg rewrite before a tool executes.
   *
   * `scope` is optional so a hand-written hook (and a direct call in a test) may
   * ignore it, but the loop always passes it: a hook that decides anything
   * session-specific must read the scope rather than a global.
   */
  beforeToolCall?(call: ToolCall, scope?: ToolCallScope): Promise<ToolCallVerdict>;
  /** Transform a tool result before it enters the message log. */
  afterToolResult?(call: ToolCall, result: string): Promise<string>;
  /**
   * Fired once at the moment the model would end the run naturally — an
   * assistant turn with NO tool calls, just before the loop yields `done`.
   * NOT fired on `max_turns`, on user abort, or after the host has decided to
   * end the run programmatically: it is the natural-end boundary only.
   *
   * A plugin returns `{ action: 'steer', message }` to inject a synthetic
   * agent-visible message and force the loop to take another turn instead of
   * terminating (a genui plugin repairing a malformed spec the model just
   * emitted steers the model back with "the spec was malformed: <reason>");
   * returning `undefined`, `null`, or `{ action: 'stop' }` lets the run end.
   * The first plugin in the chain that steers wins; the rest do not run.
   */
  beforeTurnEnd?(ctx: BeforeTurnEndContext): Promise<BeforeTurnEndVerdict | void>;
}

/** Argument the loop passes to `beforeTurnEnd` hooks. */
export interface BeforeTurnEndContext {
  /** The turn that just completed (1-based). */
  turn: number;
  /** The append-only message log so far — read-only view; mutations are
   * reserved for the loop. */
  messages: readonly AgentMessage[];
}

/** Verdict a `beforeTurnEnd` hook returns. */
export type BeforeTurnEndVerdict =
  | { action: 'stop' }
  // The steer message MUST be user- or assistant-visible (system and tool
  // messages are not part of the surface's chat bubbles), so the verdict's
  // shape narrows here rather than at every consumer.
  | { action: 'steer'; message: AssistantMessage | UserMessage };

/** Events yielded by the agent loop for consumers (REPL, browser UI, CI runner). */
export type AgentEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; messageId: string; text: string }
  /**
   * Streamed chain-of-thought / reasoning content (e.g. DeepSeek
   * `reasoning_content`). Never persisted into the message log — it is
   * observability only, so the provider prefix cache stays stable.
   */
  | { type: 'reasoning_delta'; text: string }
  | { type: 'message'; message: AssistantMessage | UserMessage }
  | { type: 'tool_call_start'; turn: number; call: ToolCall }
  | { type: 'tool_call_result'; turn: number; call: ToolCall; result: ToolResultMessage }
  | { type: 'usage'; usage: Usage; stats: UsageStats }
  /**
   * Emitted once when a run ends via user abort, after the marker message has
   * been appended to the log. Consumers should persist `message` (codex-style
   * <turn_aborted> marker) so the model learns the turn was cut short.
   */
  | { type: 'turn_aborted'; message: UserMessage }
  /**
   * The provider's in-flight response failed mid-stream and is being
   * re-requested (attempt N of maxRetries). The loop has already rolled back
   * its accumulators and usage stats (`stats` carries the corrected
   * cumulative numbers); UIs discard partial output rendered for the failed
   * attempt.
   */
  | { type: 'llm_retry'; attempt: number; maxRetries: number; error: string; stats: UsageStats }
  /**
   * A completion with NO text, NO tool calls and a finish reason — a provider
   * pathology (reasoning-only answer: everything streamed into
   * reasoning_content, content stayed empty). The loop re-issues the
   * IDENTICAL request (stable prefix → cache-friendly); this event announces
   * each re-issue for UI visibility. Exhausted retries throw instead.
   */
  | { type: 'empty_completion'; attempt: number; maxRetries: number; finishReason: string }
  | { type: 'done'; stopReason: 'complete' | 'max_turns' | 'aborted' };
