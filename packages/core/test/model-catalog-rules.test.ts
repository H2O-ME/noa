/**
 * The catalog SELECTION rules: which ids a menu offers, and how capabilities
 * resolve across the three authorities.
 *
 * These are pure functions, so the tests are exact-value assertions rather than
 * fixtures. The precedence rule is the one worth pinning hardest: the settings
 * page displays what it computes, so a silent change here would make the page
 * and the request disagree about a context window.
 */
import { describe, expect, it } from 'vitest';
import { catalogIds, entryCapabilities, resolveCapabilities } from '../src/model-catalog-rules.js';

describe('resolveCapabilities', () => {
  const discovered = {
    contextWindow: 128_000,
    maxOutput: 8192,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    attachment: true,
    reasoning: true,
  };

  it('returns the discovered values when nothing is overridden', () => {
    expect(resolveCapabilities(undefined, discovered)).toEqual(discovered);
  });

  it('is empty when neither authority knows anything', () => {
    expect(resolveCapabilities(undefined, undefined)).toEqual({});
  });

  it('lets the override win field by field', () => {
    expect(resolveCapabilities({ contextWindow: 64_000 }, discovered)).toEqual({
      ...discovered,
      contextWindow: 64_000,
    });
  });

  it('keeps the automatic value for fields the override does not name', () => {
    // The whole point of a per-field merge: an operator who only knows the
    // window must not have to re-state the modalities, and must not LOSE them.
    const merged = resolveCapabilities({ contextWindow: 32_768 }, discovered);
    expect(merged.inputModalities).toEqual(['text', 'image']);
    expect(merged.reasoning).toBe(true);
  });

  it('honours an explicit false instead of falling through to the automatic true', () => {
    // `??` rather than `||`: "off" and "unset" are different facts, and an
    // operator who disabled attachments means it.
    expect(resolveCapabilities({ attachment: false }, discovered).attachment).toBe(false);
  });

  it('carries an override for a model the automatic source has never heard of', () => {
    expect(resolveCapabilities({ contextWindow: 4096, inputModalities: ['text'] }, undefined)).toEqual({
      contextWindow: 4096,
      inputModalities: ['text'],
    });
  });
});

describe('entryCapabilities', () => {
  it('drops identity fields and keeps only capability overrides', () => {
    // A `models[]` entry mixes identity (`id`, `name`) with capabilities. Only
    // the capability half may reach the merge — feeding an `id` in would make
    // the "which ids are set" question meaningless.
    const entry = { id: 'my-model', name: '我的模型', contextWindow: 32_768, attachment: false };
    const capabilities = entryCapabilities(entry);
    expect(capabilities).toEqual({ contextWindow: 32_768, attachment: false });
    expect('id' in capabilities).toBe(false);
    expect('name' in capabilities).toBe(false);
  });

  it('omits every unset field rather than writing undefined', () => {
    expect(Object.keys(entryCapabilities({ id: 'x' }))).toEqual([]);
  });
});

describe('catalogIds', () => {
  const published = ['DeepSeek-V4-Flash', 'GLM-4.6V-Flash', 'Kimi-K3'];

  it('falls back to the endpoint list when nothing is configured', () => {
    expect(catalogIds([], published, 'Kimi-K3')).toEqual(published);
  });

  it('lets the configured list BE the menu when non-empty', () => {
    // A configured list wins wholesale: an id the endpoint does not publish is
    // still offered (a self-hosted model, a gateway alias), and one the operator
    // removed is not.
    expect(catalogIds(['my-self-hosted'], published, 'my-self-hosted')).toEqual(['my-self-hosted']);
  });

  it('reconciles a configured id against the endpoint spelling', () => {
    // The case that motivated the whole reconciliation: the operator typed
    // lower case, the endpoint serves the capitalised id.
    expect(catalogIds(['glm-4.6v-flash'], published, 'GLM-4.6V-Flash')).toEqual(['GLM-4.6V-Flash']);
  });

  it('always includes the model in force, as the menu\'s check mark', () => {
    // The menu must answer "what am I talking to" even when the operator's list
    // excludes it (they removed it, but this session is still on it) or the
    // endpoint stopped advertising it.
    expect(catalogIds(['other'], published, 'Kimi-K3')).toEqual(['Kimi-K3', 'other']);
    expect(catalogIds([], published, 'retired-model')).toEqual(['retired-model', ...published]);
  });

  it('de-duplicates without reordering the operator\'s list', () => {
    // Two spellings of one model must not become two rows.
    expect(catalogIds(['Kimi-K3', 'kimi-k3'], published, 'Kimi-K3')).toEqual(['Kimi-K3']);
  });

  it('ignores an empty configured id instead of offering a blank row', () => {
    expect(catalogIds(['', 'Kimi-K3'], published, '')).toEqual(['Kimi-K3']);
  });

  it('is empty when there is nothing to offer at all', () => {
    expect(catalogIds([], [], '')).toEqual([]);
  });
});
