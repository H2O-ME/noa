/**
 * Reconciling a configured model name against what the endpoint publishes.
 *
 * The failure this guards is not exotic: a gateway compares model ids literally,
 * so a config that differs only in case is answered with 503/404 — which reads
 * exactly like a dead provider. The reconciliation is a pure function so the
 * case is pinned here rather than discovered against a live endpoint.
 */
import { describe, expect, it } from 'vitest';
import { resolveModelId, sameModelId } from '../src/model-id.js';

/** The spelling this gateway actually serves (see the case-sensitivity note below). */
const PUBLISHED = ['DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'GLM-4.6V-Flash', 'gpt-4o', 'a-model', 'z-model'];

describe('resolveModelId', () => {
  it('keeps an id the endpoint already publishes, byte for byte', () => {
    expect(resolveModelId('DeepSeek-V4-Flash', PUBLISHED)).toBe('DeepSeek-V4-Flash');
  });

  it('adopts the endpoint spelling when only the case differs', () => {
    // The observed real case: `deepseek-v4-flash` is answered with 503 by the
    // gateway, `DeepSeek-V4-Flash` with 200.
    expect(resolveModelId('deepseek-v4-flash', PUBLISHED)).toBe('DeepSeek-V4-Flash');
    expect(resolveModelId('GLM-4.6v-flash', PUBLISHED)).toBe('GLM-4.6V-Flash');
  });

  it('falls back to the loosest pass when punctuation differs too', () => {
    expect(resolveModelId('gpt4o', PUBLISHED)).toBe('gpt-4o');
    expect(resolveModelId('GPT_4O', PUBLISHED)).toBe('gpt-4o');
  });

  it('prefers case over punctuation when both could match', () => {
    // `gpt-4o` only matches on punctuation; a case-only match is the stronger
    // signal and must win rather than being decided by list order.
    expect(resolveModelId('GPT-4O', PUBLISHED)).toBe('gpt-4o');
  });

  it('returns the configured name unchanged when the endpoint knows nothing like it', () => {
    // Refusing to guess is the point: the endpoint's own error then names the
    // model the operator actually asked for.
    expect(resolveModelId('no-such-model', PUBLISHED)).toBe('no-such-model');
  });

  it('leaves an ambiguous case match alone rather than picking arbitrarily', () => {
    // Two published ids differing only in case cannot be told apart: choosing
    // either would be coin-flip routing.
    expect(resolveModelId('dup-model', ['DUP-MODEL', 'dup-MODEL'])).toBe('dup-model');
  });

  it('does not resolve through an empty list (the endpoint told us nothing)', () => {
    // A failed or unauthorised `GET /models` yields no ids; the config stands.
    expect(resolveModelId('deepseek-v4-flash', [])).toBe('deepseek-v4-flash');
  });

  it('does not turn an empty configured name into a real model', () => {
    expect(resolveModelId('', PUBLISHED)).toBe('');
  });

  it('is case-insensitive about the id it is given, not about the endpoint list', () => {
    // `toLowerCase` must be used, never `toLocaleLowerCase`: under a Turkish
    // locale `I` folds to `ı` and this exact match would break.
    expect(resolveModelId('KIMI-K3', ['Kimi-K3'])).toBe('Kimi-K3');
  });
});

describe('sameModelId', () => {
  it('treats a casing difference as the same model', () => {
    expect(sameModelId('deepseek-v4-flash', 'DeepSeek-V4-Flash')).toBe(true);
  });

  it('treats different models as different', () => {
    expect(sameModelId('DeepSeek-V4-Flash', 'DeepSeek-V4-Pro')).toBe(false);
  });

  it('does not match on punctuation alone', () => {
    // A gateway may serve both as distinct models, so this must not collapse
    // them — it would make the configured context-window override apply to the
    // wrong model.
    expect(sameModelId('gpt-4o', 'gpt4o')).toBe(false);
  });

  it('never reports two empty names as a match', () => {
    expect(sameModelId('', '')).toBe(false);
    expect(sameModelId('', 'a-model')).toBe(false);
  });
});
