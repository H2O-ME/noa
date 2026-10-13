import { describe, expect, it } from 'vitest';
import {
  IMAGE_TOKEN_ESTIMATE,
  estimateMessageTokens,
  estimateNextPromptTokens,
  type AssistantMessage,
  type UserMessage,
} from '../src/index.js';

function userMsg(content: string): UserMessage {
  return { id: 'm', ts: 0, role: 'user', content };
}

function assistantMsg(content: string): AssistantMessage {
  return { id: 'a', ts: 0, role: 'assistant', content };
}

describe('estimateMessageTokens', () => {
  it('prices CJK characters at roughly one token each', () => {
    const text = '你好世界'; // 4 CJK chars
    const estimate = estimateMessageTokens(userMsg(text));
    expect(estimate).toBeGreaterThanOrEqual(4);
    expect(estimate).toBeLessThan(12);
  });

  it('prices ASCII text at roughly four characters per token', () => {
    const estimate = estimateMessageTokens(userMsg('abcdefgh')); // 8 ascii chars
    expect(estimate).toBeGreaterThanOrEqual(2);
    expect(estimate).toBeLessThan(8);
  });

  it('adds role framing on top of content', () => {
    expect(estimateMessageTokens(assistantMsg(''))).toBeGreaterThan(0);
  });

  it('prices assistant tool-call arguments, not just content', () => {
    const bigArgs = JSON.stringify({ code: 'p'.repeat(160_000) });
    const withCalls: AssistantMessage = {
      id: 'a',
      ts: 0,
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c', name: 'run_code', args: {}, rawArgs: bigArgs }],
    };
    // The 160KB program (~40K tokens) must be visible to the compaction gate;
    // an empty-content assistant turn is otherwise priced as a bare frame.
    expect(estimateMessageTokens(withCalls)).toBeGreaterThan(30_000);
    expect(estimateMessageTokens(withCalls)).toBeLessThan(50_000);
  });
  it('prices attached images, which reach the wire as bytes', () => {
    // Killing test: images were priced as free, so an image-heavy session's
    // auto-compact gate under-counted the prompt and the next request could
    // still overflow the provider window.
    const withImage: UserMessage = {
      ...userMsg('look'),
      images: [{ id: 'sha256:abc', mediaType: 'image/png', bytes: 1024 }],
    };
    const withoutImage = estimateMessageTokens(userMsg('look'));
    const withOne = estimateMessageTokens(withImage);
    expect(withOne - withoutImage).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  it('prices resolved images once, not on top of their references', () => {
    const both: UserMessage = {
      ...userMsg('look'),
      images: [{ id: 'sha256:abc', mediaType: 'image/png', bytes: 1024 }],
      resolvedImages: [{ mediaType: 'image/png', data: 'AAAA' }],
    };
    const withoutImage = estimateMessageTokens(userMsg('look'));
    expect(estimateMessageTokens(both) - withoutImage).toBe(IMAGE_TOKEN_ESTIMATE);
  });
});

describe('estimateNextPromptTokens', () => {
  it('anchors on the last usage and prices only the added messages', () => {
    const anchor = { promptTokens: 1000, completionTokens: 0, cachedTokens: 0 };
    const added = [userMsg('hello'), assistantMsg('hi')];
    const estimate = estimateNextPromptTokens(anchor, added);
    const perMessage = added.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimate).toBe(1000 + perMessage);
  });

  it('returns the anchor unchanged for an empty delta', () => {
    const anchor = { promptTokens: 500, completionTokens: 10, cachedTokens: 400 };
    expect(estimateNextPromptTokens(anchor, [])).toBe(500);
  });
});

describe('estimateMessageTokens Hangul', () => {
  it('prices Hangul syllables as CJK (one token each), not as 4-chars-per-token', () => {
    const text = '안녕하세요'; // 5 Hangul syllables
    const estimate = estimateMessageTokens(userMsg(text));
    expect(estimate).toBeGreaterThanOrEqual(5);
    expect(estimate).toBeLessThan(10);
  });
});
