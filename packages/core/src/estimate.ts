import type { AgentMessage, Usage } from './types.js';

/**
 * Heuristic token pricing used between provider calls: CJK characters are
 * roughly one token each, other text roughly four characters per token, plus
 * a small per-message role-framing allowance. This mirrors dsh's fixed
 * heuristic anchor; it never replaces real `usage` numbers, only bridges the
 * gaps between them (compaction pre-checks before the next request).
 */

// CJK coverage (all BMP, so codePointAt + range compare matches the old
// regex's BMP char class exactly — astral code points fall through to
// `other` in both, since none of these ranges reaches the surrogate ceiling):
//   U+2E80–U+9FFF  CJK Radicals + Han
//   U+AC00–U+D7AF  Hangul Syllables + Jamo
//   U+F900–U+FAFF  CJK Compatibility Ideographs
//   U+FF00–U+FFEF  Fullwidth + Halfwidth/Fullwidth Forms
const CJK_RANGES: readonly (readonly [number, number])[] = [
  [0x2e80, 0x9fff],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
];

function isCJKCodePoint(cp: number): boolean {
  for (let i = 0; i < CJK_RANGES.length; i++) {
    const [lo, hi] = CJK_RANGES[i]!;
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const FRAMING_TOKENS = 4;

/**
 * Conservative per-image prompt cost, in tokens.
 *
 * An image reaches the wire as a base64 `data:` URI, so its token cost is real
 * but NOT derivable from the text: providers price by decoded pixels/tiles, and
 * this layer never decodes the bytes (dimensions live inside the format's own
 * header). Pricing images as free — what happened before — let a
 * "fits under the limit" request blow the provider's context window and 400.
 * A fixed, deliberately generous constant is the honest middle: it over-prices
 * a small icon and under-prices a huge photo, but it never prices an attachment
 * at zero.
 */
export const IMAGE_TOKEN_ESTIMATE = 1200;

/** Price a raw text blob (system prompts, tool schemas) with the same heuristic. */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCJKCodePoint(ch.codePointAt(0)!)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * Per-message memo: messages are append-only and never mutated after logging,
 * so a price computed once stays valid for the session. This matters most for
 * exec's per-request full re-estimate over a long transcript.
 */
const messageTokenCache = new WeakMap<AgentMessage, number>();

export function estimateMessageTokens(msg: AgentMessage): number {
  const cached = messageTokenCache.get(msg);
  if (cached !== undefined) return cached;
  let total = FRAMING_TOKENS + estimateTextTokens(msg.content);
  // Assistant tool-call arguments join the next request verbatim (replayed in
  // the assistant turn), but live in `toolCalls`, not `content`. A run_code
  // program or a heredoc bash command can be tens of KB — pricing them as
  // free made the auto-compact gate lag the real prompt by an order of
  // magnitude, so the request that "fit under the limit" could still blow
  // the provider context window (and exec dies on the resulting 400).
  if (msg.role === 'assistant' && msg.toolCalls !== undefined) {
    for (const call of msg.toolCalls) {
      total += estimateTextTokens(`${call.name}${call.rawArgs}`);
    }
  }
  // Attached images are bytes on the wire, not text: count each one at the
  // conservative constant above. The log form carries `images` (references);
  // the request-time projection carries `resolvedImages` — price whichever is
  // present, once.
  if (msg.role === 'user') {
    const images = msg.resolvedImages?.length ?? msg.images?.length ?? 0;
    total += images * IMAGE_TOKEN_ESTIMATE;
  }
  messageTokenCache.set(msg, total);
  return total;
}

/**
 * Project the next request's prompt tokens: the last successful provider
 * usage anchors the whole request image, and only messages appended after
 * that call need re-pricing (dsh token-meter's anchor + delta repricing,
 * simplified to whole-message granularity).
 */
export function estimateNextPromptTokens(anchor: Usage, added: AgentMessage[]): number {
  let total = anchor.promptTokens;
  for (const msg of added) total += estimateMessageTokens(msg);
  return total;
}
