/**
 * `{env:NAME}` reference expansion for the loaded config document.
 *
 * Ported from nova's `packages/cli/src/config-expand.ts` (the ownership rule is
 * the same): whether an unresolved reference is a fatal load error or a
 * diagnostic depends on WHO owns the value.
 *
 *  - a reference in a top-level section (the endpoint, the persona) fails the
 *    load and names the variable — the process would otherwise behave as if the
 *    value were simply missing;
 *  - a reference inside `plugins.entries[].config` belongs to that row's plugin,
 *    which is only started by the invocations that ask for it, so it degrades to
 *    a diagnostic and every other row still loads.
 *
 * Leaving the literal in place is deliberate over substituting an empty string:
 * an empty credential reaches the network and comes back as a bare 401 with no
 * clue why, while the literal is self-describing and the owning plugin refuses
 * it before any request goes out.
 */

/** A `{env:NAME}` reference that did not resolve, and who owns it. */
export interface ConfigDiagnostic {
  /** The top-level config section the reference sits in, or the plugin row's id. */
  readonly section: string;
  /** The variable name the reference asks for. */
  readonly variable: string;
  /**
   * The plugin row's id when the reference sits in `plugins.entries[].config`.
   * Absent for a core section, where an unresolved reference never reaches a
   * diagnostic (it throws).
   */
  readonly pluginId?: string;
}

const REF_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expands `{env:NAME}` references. Throws when a referenced variable is unset.
 * @param value - the string to expand.
 * @returns the string with every reference replaced by its value.
 */
export function expandRefs(value: string): string {
  return value.replace(REF_RE, (_match, name: string) => {
    const v = process.env[name];
    if (v === undefined || v.length === 0) {
      throw new Error(
        `config references environment variable {env:${name}} but it is not set (or empty); set it in your shell or use a literal value`,
      );
    }
    return v;
  });
}

/**
 * Expand every string in a value, THROWING on an unresolved reference.
 * @param value - the parsed subtree.
 * @returns the subtree with every reference expanded.
 */
function expandStrict(value: unknown): unknown {
  if (typeof value === 'string') return expandRefs(value);
  if (Array.isArray(value)) return value.map(expandStrict);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = expandStrict(val);
    return out;
  }
  return value;
}

/**
 * Expand every string in a value, KEEPING unresolved references as written and
 * collecting one diagnostic per (owner, variable) pair.
 * @param value - the parsed subtree.
 * @param owner - the plugin row's id, for the diagnostics.
 * @param found - collects the unresolved references.
 * @returns the subtree with resolvable references expanded.
 */
function expandLenient(value: unknown, owner: string, found: ConfigDiagnostic[]): unknown {
  if (typeof value === 'string') {
    return value.replace(REF_RE, (match: string, name: string) => {
      const v = process.env[name];
      if (v === undefined || v.length === 0) {
        // Once per variable: a row repeating one reference is one problem, and
        // repeating the sentence would read as several.
        if (!found.some((entry) => entry.pluginId === owner && entry.variable === name)) {
          found.push({ section: owner, variable: name, pluginId: owner });
        }
        return match;
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((item) => expandLenient(item, owner, found));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) out[key] = expandLenient(val, owner, found);
    return out;
  }
  return value;
}

/**
 * Expand a whole parsed config document.
 *
 * `plugins.entries` is walked ROW BY ROW so an unresolved reference in one
 * plugin's settings is recorded against that plugin and every other row (and
 * every core section) still loads.
 * @param parsed - the parsed JSON document.
 * @returns the expanded document, plus one diagnostic per unresolved plugin reference.
 */
export function expandConfigDocument(parsed: unknown): {
  value: unknown;
  diagnostics: ConfigDiagnostic[];
} {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { value: parsed, diagnostics: [] };
  }
  const diagnostics: ConfigDiagnostic[] = [];
  const out: Record<string, unknown> = {};
  for (const [section, subtree] of Object.entries(parsed)) {
    out[section] = section === 'plugins' ? expandPlugins(subtree, diagnostics) : expandStrict(subtree);
  }
  return { value: out, diagnostics };
}

/**
 * Expand the `plugins` section, treating each row's `config` as its own.
 * @param plugins - the parsed `plugins` subtree (any shape).
 * @param diagnostics - collects the unresolved references.
 * @returns the subtree with every resolvable reference expanded.
 */
function expandPlugins(plugins: unknown, diagnostics: ConfigDiagnostic[]): unknown {
  if (typeof plugins !== 'object' || plugins === null || Array.isArray(plugins)) {
    return expandStrict(plugins);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plugins)) {
    if (key !== 'entries' || !Array.isArray(value)) {
      out[key] = expandStrict(value);
      continue;
    }
    out[key] = value.map((row) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return expandStrict(row);
      const entry = row as Record<string, unknown>;
      const id = typeof entry['id'] === 'string' ? entry['id'] : '(unnamed row)';
      const expanded: Record<string, unknown> = {};
      for (const [field, fieldValue] of Object.entries(entry)) {
        expanded[field] = field === 'config' ? expandLenient(fieldValue, id, diagnostics) : expandStrict(fieldValue);
      }
      return expanded;
    });
  }
  return out;
}

/**
 * Whether a value still holds an unresolved reference — the check a plugin runs
 * before it uses its own settings, so the failure names the variable AND the file
 * to edit.
 * @param value - the string a consumer is about to use.
 * @returns the unresolved variable name, or undefined when the value is usable.
 */
export function unresolvedRef(value: string): string | undefined {
  REF_RE.lastIndex = 0;
  const match = REF_RE.exec(value);
  return match?.[1];
}

/**
 * The sentence one diagnostic reads as, for the console to print.
 * @param diagnostic - the unresolved reference.
 * @returns the sentence.
 */
export function diagnosticText(diagnostic: ConfigDiagnostic): string {
  const owner = diagnostic.pluginId === undefined ? diagnostic.section : `插件「${diagnostic.pluginId}」`;
  return `${owner} 引用了环境变量 {env:${diagnostic.variable}}，但它未设置；该插件的功能暂不可用，其余功能不受影响`;
}
