import type { AgentHooks, AgentMessage, ChatRequest, ToolDefinition, Usage } from './types.js';
import { estimateMessageTokens } from './estimate.js';

/**
 * Unified auto-compaction gate shared by every runner (repl / exec / bot).
 *
 * Two interceptions, one contract:
 * - **Pre-flight** (`shouldCompactBefore`): decide whether to compact BEFORE
 *   the next request, so an overflow never fires. With a usage anchor we price
 *   only the delta since it (cheap and exact); without one — a resumed large
 *   session before its first turn, or a fresh /session switch — we fall back
 *   to a FULL estimate of the whole request image so resume cannot blow the
 *   context window on its first request.
 * - **Per-turn** (`wrapAutoCompact`): exec has no user-message boundary to
 *   pre-flight at, so it gates inside `beforeLLMCall`. It prices the full
 *   request (system + tool schemas + messages) and compacts in place with a
 *   FUSE: a compaction that still leaves the retained floor over the limit
 *   disarms auto-compact for the rest of the run instead of re-summarizing
 *   every turn.
 */

/**
 * Tool schemas are registered once and immutable thereafter, so their token
 * price never changes. Cache per tool object (WeakMap — a rebuilt host's new
 * tool objects reprice, old ones are collectable): without this, exec's
 * per-request gate re-stringifies and re-tokenizes every schema on every
 * request, twice per turn on compact checks — quadratic over a long run.
 */
const toolTokenCache = new WeakMap<ToolDefinition, number>();

function toolImageTokens(tool: ToolDefinition): number {
  let tokens = toolTokenCache.get(tool);
  if (tokens === undefined) {
    tokens = estimateMessageTokens({
      role: 'system',
      id: '',
      ts: 0,
      content: `${tool.name} ${tool.description} ${JSON.stringify(tool.parameters)}`,
    });
    toolTokenCache.set(tool, tokens);
  }
  return tokens;
}

/** Price the whole outgoing request image with the heuristic token meter. */
export function requestImageTokens(req: ChatRequest): number {
  let image = estimateMessageTokens({ role: 'system', id: '', ts: 0, content: req.systemPrompt ?? '' });
  for (const tool of req.tools ?? []) {
    image += toolImageTokens(tool);
  }
  for (const msg of req.messages) image += estimateMessageTokens(msg);
  return image;
}

export interface PreflightInput {
  limit: number;
  /** Last provider usage; undefined before the first request ever ran. */
  usageAnchor?: Usage;
  /** How many of `messages` were already priced into `usageAnchor`. */
  anchorMsgCount: number;
  messages: AgentMessage[];
  /**
   * The full request image to price when there is no anchor (resume of a big
   * session, fresh /session). Callers build it with the live system prompt
   * and tool list; it is never sent, only priced.
   */
  request: ChatRequest;
}

/**
 * Decide whether to compact before a request. Anchor present → price the delta
 * since the anchor (the interactive steady-state). Anchor absent → price the
 * whole image (correct on resume of a big session, where the first turn would
 * otherwise start already over the window).
 */
export function shouldCompactBefore(input: PreflightInput): boolean {
  if (input.usageAnchor !== undefined) {
    const added = input.messages.slice(input.anchorMsgCount);
    const estimate = input.usageAnchor.promptTokens + added.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    return estimate > input.limit;
  }
  return requestImageTokens(input.request) > input.limit;
}

export interface WrapAutoCompactOptions {
  enabled: boolean;
  limit: number;
  /** Compact the live surface; the callback splices `messages` in place. */
  compact: (messages: AgentMessage[]) => Promise<void>;
  onError: (err: unknown) => void;
  /**
   * One-shot user-facing line with a machine code: `compact_alias_broken`
   * (a plugin hook replaced the messages array, in-place compaction disarmed)
   * or `compact_fused` (post-compact floor still over the limit). Structured
   * so event-stream surfaces (web/exec JSONL) translate by code and terminal
   * fallbacks can print `text` as-is.
   */
  onWarn: (code: 'compact_fused' | 'compact_alias_broken', text: string) => void;
}

/**
 * Token-gate every outgoing LLM request inside runAgent. The interactive
 * runners compact at user-message boundaries (before/after a run); exec has
 * exactly one run for the whole task, so this per-request hook is its only
 * interception point. Compacted IN PLACE (three compaction events to the log,
 * `messages` splices to the projected surface) and FUSED after a compaction
 * that still leaves the image over the limit (the retained floor is then above
 * the threshold, so repeating the summarizer every turn buys nothing while
 * doubling per-turn cost and flooding the session log).
 */
/**
 * Hooks objects already wrapped by this module. The composed `AgentHooks` is
 * cached per container root (`composeHooks`), so its identity survives a
 * re-roster — and a re-roster re-calls `wrapAutoCompact` (headless auto-compact
 * is wired in `reroster`). Without this guard each re-roster stacks one more
 * layer around the same chain: mostly harmless, but once the gate FUSES the
 * layers no longer agree on that state, and one over-limit request runs one
 * summarizer compaction per layer. The gate is per-kernel state (the limit
 * comes from the kernel's own config and never changes for its lifetime), so
 * the first wrap for a hooks object is the only one it needs.
 */
const wrappedHooks = new WeakSet<object>();

export function wrapAutoCompact(hooks: AgentHooks, opts: WrapAutoCompactOptions): void {
  if (!opts.enabled) return;
  if (wrappedHooks.has(hooks)) return;
  wrappedHooks.add(hooks);
  const inner = hooks.beforeLLMCall;
  let compacting = false;
  let fused = false;
  hooks.beforeLLMCall = async (req) => {
    const next = inner === undefined ? req : await inner(req);
    if (compacting || fused) return next;
    // In-place compaction contract: the hook chain must hand back the SAME
    // messages array object runAgent passed in, so the splice below reaches
    // the live log. A plugin hook that clones `req.messages` would compact a
    // throwaway copy: the log never shrinks, every turn re-compacts, and the
    // model surface diverges from the projection ("model-visible means
    // logged" broken). Such plugins are a planned extension point, so check
    // explicitly and disarm rather than corrupt.
    if (next.messages !== req.messages) {
      fused = true;
      opts.onWarn(
        'compact_alias_broken',
        '插件钩子替换了消息数组：本次任务的自动压缩已停用（原位压缩会失效）',
      );
      return next;
    }
    if (requestImageTokens(next) <= opts.limit) return next;
    compacting = true;
    try {
      await opts.compact(next.messages);
      const after = requestImageTokens(next);
      if (after > opts.limit) {
        fused = true;
        opts.onWarn(
          'compact_fused',
          `压缩后仍约 ${after} tok 超阈值 ${opts.limit} tok（保留片段+工具 schema 构成下限）：本次任务停用自动压缩，后续请求可能超窗，可考虑调大 autoCompactTokenLimit`,
        );
      }
    } catch (err) {
      opts.onError(err);
    } finally {
      compacting = false;
    }
    return next;
  };
}