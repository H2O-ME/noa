/**
 * The catalog's precedence: operator override → models.dev → unknown.
 *
 * Worth pinning because the whole image pipeline hangs off it. `capabilities()`
 * feeds `inputModalities`, and `inputModalities` decides whether a picture is
 * sent, sent-with-a-note, or withheld. Getting the order wrong in the "unknown"
 * direction is the failure this port was extended to prevent: an operator who
 * declares `["text"]` and still gets images sent has declared nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { modelCatalogPort } from '../src/model-catalog.js';
import { buildModelsDevIndex, type ModelsDevIndex } from '../src/models-dev.js';

/** An index built from the same shape as the live document. */
function indexOf(document: unknown): ModelsDevIndex {
  const built = buildModelsDevIndex(document);
  return {
    answer: (model) => built.get(model.toLowerCase().replace(/[^a-z0-9]/gu, '')) ?? { kind: 'absent' },
    refreshIfStale: async () => false,
  };
}

const DOC = {
  zai: { models: { 'glm-4.6v': { modalities: { input: ['text', 'image'] } } } },
};

describe('modelCatalogPort', () => {
  it('labels the group with the endpoint host', () => {
    expect(modelCatalogPort('https://api.example.com/v1').label).toBe('api.example.com');
  });

  it('answers from models.dev when the operator said nothing', async () => {
    const port = modelCatalogPort('https://api.example.com/v1', { modelsDev: indexOf(DOC) });
    expect(await port.capabilities('GLM-4.6V')).toEqual({ inputModalities: ['text', 'image'] });
  });

  it('lets the operator beat models.dev', async () => {
    // The measured case: the automatic source cannot resolve this gateway's
    // alias, and the operator knows the gateway drops images.
    const port = modelCatalogPort('https://api.example.com/v1', {
      modelsDev: indexOf(DOC),
      inputModalities: ['text'],
    });
    expect(await port.capabilities('GLM-4.6V')).toEqual({ inputModalities: ['text'] });
  });

  it('keeps the automatic answer un-overridden for the settings view', async () => {
    // `automatic()` exists so a field can show what it would inherit. If it
    // applied the override there would be nothing to compare against.
    const port = modelCatalogPort('https://api.example.com/v1', {
      modelsDev: indexOf(DOC),
      inputModalities: ['text'],
    });
    expect(await port.automatic('GLM-4.6V')).toEqual({ inputModalities: ['text', 'image'] });
  });

  it('still answers when models.dev knows nothing and the operator declared', async () => {
    const port = modelCatalogPort('https://api.example.com/v1', { inputModalities: ['text'] });
    expect(await port.capabilities('DeepSeek-V4-Flash')).toEqual({ inputModalities: ['text'] });
  });

  it('answers unknown when neither source has anything, and says so', async () => {
    // Unknown is what makes the projection send the bytes WITH a note. Returning
    // `{}` here would read as "declared text-only" and withhold them.
    const log = vi.fn();
    const port = modelCatalogPort('https://api.example.com/v1', { modelsDev: indexOf(DOC), log });
    expect(await port.capabilities('Nobody-Knows-This')).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Nobody-Knows-This'));
  });

  it('names a conflict as a conflict, not as absence', async () => {
    const conflicting = indexOf({
      a: { models: { 'x-model': { modalities: { input: ['text'] } } } },
      b: { models: { 'x-model': { modalities: { input: ['text', 'image'] } } } },
    });
    const log = vi.fn();
    const port = modelCatalogPort('https://api.example.com/v1', { modelsDev: conflicting, log });
    expect(await port.capabilities('x-model')).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('不一致'));
  });
});
