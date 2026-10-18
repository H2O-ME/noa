/**
 * Surgical persistence for the config fields a running process may change: one
 * plugin ROW (`plugins.entries`) and one skill (`skills.disable`).
 *
 * Ported from nova's `packages/cli/src/config-write.ts`. WHAT to change lives
 * here; HOW a change is made safely (raw-document read-modify-write, atomic
 * replace, abort-on-unparseable) lives in `config-doc.ts`.
 *
 * ## One row, one writer
 *
 * A plugin row is addressed by its ID and patched field-by-field, so this file
 * needs to know nothing about any plugin: the QQ channel says "row X's config is
 * this object", and the shape inside `config` belongs to the plugin whose schema
 * validates it. That is what lets a third-party plugin keep settings without a
 * host change.
 *
 * One invariant is local to this file: strings the operator typed are stored
 * VERBATIM — even an `{env:NAME}`-shaped value — because the LOAD path expands
 * references. Writing such a string wants `clientSecret` to mean "read this
 * variable", not to embed a literal.
 */
import type { ModelDefaultsPort } from '@noa/core';
import { docFile, ensureList, patchConfig, plainMember, readDoc, sortedUnique } from './config-doc.js';

/** One plugin row as the durable document stores it. */
interface StoredEntry {
  id: string;
  enabled?: boolean;
  config?: unknown;
}

/**
 * Upsert one plugin ROW: its `enabled` switch and/or its own `config` object.
 *
 * A field left absent is left AS STORED, so a row's switch and the row's own
 * settings never blank each other's work. A row whose only content would be the
 * default is dropped entirely rather than persisted as noise: "no entry" and "an
 * entry with nothing to say" mean the same thing.
 *
 * `config` is merged ONE KEY AT A TIME. A key whose value is `null` is REMOVED:
 * that is how a writer clears an optional field, since omitting it means "leave
 * it".
 *
 * @param id - the row's id (a built-in's name or a module specifier).
 * @param patch - the fields to write; an absent field is left as stored.
 * @param homedir - Override for tests; defaults to the real home.
 */
export async function setPluginEntry(
  id: string,
  patch: { enabled?: boolean; config?: unknown },
  homedir?: string,
): Promise<void> {
  await patchConfig((doc) => {
    const owner = plainMember(doc, 'plugins') ?? (() => {
      const created: Record<string, unknown> = {};
      doc['plugins'] = created;
      return created;
    })();
    const entries = ensureEntries(owner);
    let row = entries.find((candidate) => candidate.id === id);
    if (row === undefined) {
      row = { id };
      entries.push(row);
    }
    if (patch.enabled !== undefined) row.enabled = patch.enabled;
    if (patch.config !== undefined) row.config = mergeConfig(row.config, patch.config);
    // An entry that only restates the default is not worth keeping: the row's
    // absence already means "as the plugin ships".
    if (row.enabled === undefined && row.config === undefined) {
      const index = entries.indexOf(row);
      entries.splice(index, 1);
    }
    if (entries.length === 0) delete owner['entries'];
    else owner['entries'] = entries;
  }, homedir);
}

/**
 * One row's config, merged key by key.
 *
 * A patch that is not a plain object REPLACES (the plugin is setting a scalar or
 * a list, and there is nothing to merge it into). `null` removes one key;
 * `undefined` means "leave it".
 * @param stored - what the document holds now.
 * @param patch - what the writer submitted.
 * @returns the merged value, or undefined when nothing is left.
 */
function mergeConfig(stored: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const base =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...(stored as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

/**
 * One row's config AS WRITTEN in the document.
 *
 * The load path expands `{env:NAME}` references, so a plugin applied with its
 * resolved config cannot tell a literal secret from a reference to one. A writer
 * that must not destroy the reference needs this raw form.
 * @param id - the row's id.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the stored config, or undefined when the row (or its config) is absent.
 */
export async function readPluginEntryConfig(id: string, homedir?: string): Promise<unknown> {
  const doc = await readDoc(docFile(homedir)).catch(() => undefined);
  const entries = plainMember(doc, 'plugins')?.['entries'];
  if (!Array.isArray(entries)) return undefined;
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const candidate = raw as Record<string, unknown>;
    if (candidate['id'] === id) return candidate['config'];
  }
  return undefined;
}

/**
 * Set the enabled state of one skill (`skills.disable`, by name, both levels).
 * A missing `skills` object is created.
 * @param name - the skill's name.
 * @param enabled - whether it should be injected and callable.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the disable list now in force.
 */
export async function setSkillEnabled(name: string, enabled: boolean, homedir?: string): Promise<readonly string[]> {
  let result: readonly string[] = [];
  await patchConfig((doc) => {
    const owner = plainMember(doc, 'skills') ?? (() => {
      const created: Record<string, unknown> = {};
      doc['skills'] = created;
      return created;
    })();
    const disable = ensureList(owner, 'disable');
    const next = enabled ? sortedUnique(disable.filter((entry) => entry !== name)) : sortedUnique([...disable, name]);
    owner['disable'] = next;
    result = next;
  }, homedir);
  return result;
}

/**
 * Persist one model id as this deployment's default (`provider.model`).
 *
 * 逐键写：只碰 `provider.model`，其余字节原样保留 —— 包括 `{env:NAME}` 引用和其它
 * provider 字段。Hermes 用 round-trip YAML 保住注释与兄弟键（`utils.py:461`
 * `atomic_roundtrip_yaml_update`，且明确拒绝整块重写 `model:`）；这里的目标一样，手段
 * 是 raw JSON 文档改写（`config-doc.ts` 的三条保证：读原文、原子替换、解析不了就中止）。
 *
 * 配置里没有 `provider` 段时**抛错而不是新建**：那是配置本身不完整，凭空造一个段只会
 * 把「没有端点」写成一个看起来正常的默认模型。
 * @param model - the id to record.
 * @param homedir - Override for tests; defaults to the real home.
 */
export async function setDefaultModel(model: string, homedir?: string): Promise<void> {
  await patchConfig((doc) => {
    const provider = plainMember(doc, 'provider');
    if (provider === undefined) throw new Error('配置里没有 provider 段，写不了默认模型');
    provider['model'] = model;
  }, homedir);
}

/** The model the config FILE names, without expanding `{env:…}` references. */
export async function readDefaultModel(homedir?: string): Promise<string | undefined> {
  const doc = await readDoc(docFile(homedir)).catch(() => undefined);
  const model = plainMember(doc, 'provider')?.['model'];
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

/**
 * The kernel's model-defaults seat, over this deployment's config file.
 *
 * `setDefault` deliberately lets a failure through as `{ok: false, reason}` rather
 * than throwing: the caller is a chat command that must answer with a sentence,
 * and the interesting failures (unparseable config, no `provider` section) are
 * exactly the ones the operator needs named.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the port.
 */
export function modelDefaultsPort(homedir?: string): ModelDefaultsPort {
  return {
    configured: () => readDefaultModel(homedir),
    setDefault: async (model) => {
      try {
        await setDefaultModel(model, homedir);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * The `plugins.entries` array, normalized in place.
 *
 * A hand-edited non-array is replaced rather than trusted, and rows that are not
 * objects or carry no string id are dropped: this is the only place a row is
 * born, so it must not carry a malformed one forward.
 * @param owner - the `plugins` object.
 * @returns the live array to mutate.
 */
function ensureEntries(owner: Record<string, unknown>): StoredEntry[] {
  const current = owner['entries'];
  const rows: StoredEntry[] = [];
  if (Array.isArray(current)) {
    for (const raw of current) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
      const candidate = raw as Record<string, unknown>;
      if (typeof candidate['id'] !== 'string' || candidate['id'].length === 0) continue;
      const row: StoredEntry = { id: candidate['id'] };
      if (typeof candidate['enabled'] === 'boolean') row.enabled = candidate['enabled'];
      if (candidate['config'] !== undefined) row.config = candidate['config'];
      rows.push(row);
    }
  }
  owner['entries'] = rows;
  return rows;
}
