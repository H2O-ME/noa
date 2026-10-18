/**
 * models.dev: the matching rule, and what happens when the network is not there.
 *
 * The rule is the part worth pinning, because it encodes measurements from the
 * live document. The fixture below reproduces the two shapes that matter:
 * `deepseek-v4-flash` (a vendor entry that is an ALIAS to a different model and
 * therefore claims image support, against a lopsided majority saying text-only)
 * and a genuine 50:50, which must stay unknown rather than be guessed.
 */
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildModelsDevIndex,
  capabilitiesFrom,
  loadModelsDev,
  modelsDevKey,
  MODELS_DEV_URL,
  modelsDevCachePath,
} from '../src/models-dev.js';

/** A document shaped like the live one, reduced to the entries that matter. */
const DOC = {
  deepseek: {
    models: {
      // An ALIAS: `canonical_model_id` points at a different id, so this entry
      // speaks for `deepseek-v4.1-flash-1017`, not for `deepseek-v4-flash`.
      'deepseek-v4-flash': {
        modalities: { input: ['text', 'image'] },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
      },
      'deepseek-v4.1-flash-1017': {
        modalities: { input: ['text', 'image'] },
        canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017',
      },
    },
  },
  // Three resellers that say text-only for the id above, against the vendor
  // alias's lone claim of image support — the measured 65:1 shape.
  deepinfra: {
    models: {
      'deepseek-ai/DeepSeek-V4-Flash': {
        modalities: { input: ['text'] },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
    },
  },
  openrouter: {
    models: {
      'deepseek/deepseek-v4-flash': {
        modalities: { input: ['text'] },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
    },
  },
  azure: {
    models: {
      'deepseek-v4-flash': {
        modalities: { input: ['text'] },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
    },
  },
  // A vision model whose entries agree on pictures but differ on the extras —
  // the shape that used to be reported as a conflict for no reason.
  zai: {
    models: {
      'glm-4.6v': { modalities: { input: ['text', 'image'] } },
    },
  },
  poe: {
    models: {
      'novita/glm-4.6v': { modalities: { input: ['text', 'image', 'video'] } },
    },
  },
  siliconflow: {
    models: {
      'zai-org/GLM-4.6V': { modalities: { input: ['text', 'image', 'video', 'pdf'] } },
    },
  },
  // A genuine coin flip: two against two.
  odd: { models: { 'split-model': { modalities: { input: ['text'] } } } },
  even: { models: { 'split-model': { modalities: { input: ['text', 'image'] } } } },
  odd2: { models: { 'split-model': { modalities: { input: ['text'] } } } },
  even2: { models: { 'split-model': { modalities: { input: ['text', 'image'] } } } },
};

let dir: string;
let cacheFile: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'noa-models-dev-'));
  cacheFile = path.join(dir, 'models-dev.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('modelsDevKey', () => {
  it('matches a bare gateway id against a provider-pathed one', () => {
    expect(modelsDevKey('DeepSeek-V4-Flash')).toBe('deepseekv4flash');
    expect(modelsDevKey('deepinfra/deepseek-ai/DeepSeek-V4-Flash')).toBe('deepseekv4flash');
    expect(modelsDevKey('deepseek_v4_flash')).toBe('deepseekv4flash');
  });
});

describe('buildModelsDevIndex', () => {
  it('drops entries that are aliases for another id', () => {
    // Without this rule the vendor's own alias entry would vote "images are
    // fine" for an id its resellers all describe as text-only — and it is the
    // vendor's entry a reader would trust most.
    const index = buildModelsDevIndex(DOC);
    expect(index.get('deepseekv4flash')).toEqual({ kind: 'declared', inputModalities: ['text'] });
    // The id the alias points AT is unaffected.
    expect(index.get('deepseekv41flash1017')).toEqual({
      kind: 'declared',
      inputModalities: ['text', 'image'],
    });
  });

  it('votes on the image bit, so differing extras are not a disagreement', () => {
    // `["text","image"]`, `["text","image","video"]` and
    // `["text","image","video","pdf"]` are three spellings of "it takes
    // pictures". Comparing whole lists turned every one of these into a conflict
    // and left the feature doing nothing on a real gateway.
    const index = buildModelsDevIndex(DOC);
    expect(index.get('glm46v')).toEqual({ kind: 'declared', inputModalities: ['text', 'image'] });
  });

  it('reports a close call as a conflict rather than guessing', () => {
    // Two against two is a coin flip. Picking wrong in the "vision" direction is
    // the expensive mistake — the gateway drops the bytes and the model invents
    // an explanation — so the answer stays unknown and the operator declares it.
    const answer = buildModelsDevIndex(DOC).get('splitmodel');
    expect(answer).toEqual({ kind: 'conflict' });
  });

  it('accepts a lone entry, because one source agreeing is unanimity', () => {
    // No floor on the vote count: "every source that mentions this id agrees" is
    // the strongest evidence available for a model only one provider lists.
    expect(buildModelsDevIndex({ only: { models: { 'solo-model': { modalities: { input: ['text'] } } } } })
      .get('solomodel')).toEqual({ kind: 'declared', inputModalities: ['text'] });
  });

  it('reports only the bit it counted', () => {
    // The vote was on images. Claiming `video`/`pdf` from it would assert
    // something nobody counted.
    const answer = buildModelsDevIndex(DOC).get('glm46v');
    expect(answer?.kind === 'declared' && answer.inputModalities).toEqual(['text', 'image']);
  });

  it('survives junk in the document', () => {
    const index = buildModelsDevIndex({
      broken: null,
      alsa: { models: null },
      shape: { models: { a: 'not an object', b: { modalities: { input: 'text' } }, c: {} } },
    });
    expect(index.size).toBe(0);
  });
});

describe('capabilitiesFrom', () => {
  it('turns only a declared answer into capabilities', () => {
    expect(capabilitiesFrom({ kind: 'declared', inputModalities: ['text'] })).toEqual({ inputModalities: ['text'] });
    // Unknown must stay unknown: an empty object would read as "declared
    // nothing", and `imagePolicy` treats "declared nothing" as text-only.
    expect(capabilitiesFrom({ kind: 'conflict' })).toBeUndefined();
    expect(capabilitiesFrom({ kind: 'absent' })).toBeUndefined();
  });
});

describe('loadModelsDev', () => {
  it('answers from a fresh cache without dialing', async () => {
    await writeFile(cacheFile, JSON.stringify(DOC), 'utf8');
    const fetchImpl = vi.fn();
    const index = await loadModelsDev({ cacheFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(index.answer('DeepSeek-V4-Flash')).toEqual({ kind: 'declared', inputModalities: ['text'] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('downloads when there is no cache, and writes one', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(DOC), { status: 200 }));
    const index = await loadModelsDev({ cacheFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledWith(MODELS_DEV_URL, expect.anything());
    expect(index.answer('GLM-4.6V')).toEqual({ kind: 'declared', inputModalities: ['text', 'image'] });
    expect(JSON.parse(await readFile(cacheFile, 'utf8'))).toHaveProperty('zai');
  });

  it('keeps serving the cached index when the download fails', async () => {
    await writeFile(cacheFile, JSON.stringify(DOC), 'utf8');
    await stale(cacheFile);
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const log = vi.fn();
    const index = await loadModelsDev({ cacheFile, fetchImpl: fetchImpl as unknown as typeof fetch, log });
    expect(index.answer('GLM-4.6V').kind).toBe('declared');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  it('does not replace a good index with a document that says nothing', async () => {
    // A 200 carrying an empty object is a failed refresh. Adopting it would turn
    // every model unknown at once, and the failure would look like a data problem.
    await writeFile(cacheFile, JSON.stringify(DOC), 'utf8');
    await stale(cacheFile);
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const index = await loadModelsDev({ cacheFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(index.answer('GLM-4.6V').kind).toBe('declared');
  });

  it('answers "absent" for an id nobody knows, and never throws', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));
    const index = await loadModelsDev({ cacheFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(index.answer('GLM-4V-Flash')).toEqual({ kind: 'absent' });
    expect(index.answer('')).toEqual({ kind: 'absent' });
  });

  it('refreshes on demand only once the cache is stale', async () => {
    await writeFile(cacheFile, JSON.stringify(DOC), 'utf8');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(DOC), { status: 200 }));
    const index = await loadModelsDev({ cacheFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await index.refreshIfStale()).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lives under the cache directory by default', () => {
    expect(modelsDevCachePath('/home/x')).toBe(path.join('/home/x', '.noa', 'cache', 'models-dev.json'));
  });
});

/** Backdate a file so the loader treats it as stale. */
async function stale(file: string): Promise<void> {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  await utimes(file, old, old);
}
