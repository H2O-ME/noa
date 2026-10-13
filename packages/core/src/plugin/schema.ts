/**
 * The config validator for a plugin that ships without a schema library.
 *
 * `ConfigSchema` is declared STRUCTURALLY (see `types.ts`) so a plugin may bring
 * zod. NovaAgent's own packages are dependency-free, so without this each of them
 * would hand-roll the same walk — "is this field the type my row promised?" —
 * and the two copies would drift on the part that matters: the issue text is
 * what the operator reads when a hand-edited config is refused, and it has to
 * name the field.
 *
 * Every field is OPTIONAL by design. A row's `config` is a partial statement —
 * `{}` is a valid row — and "absent" means the plugin's own default, never a
 * validation failure: a plugin that cannot run without a value (missing
 * credentials, say) still activates and reports the gap on its own page, which
 * is what lets an operator fill the gap from that page.
 *
 * Unknown keys are REFUSED rather than dropped. The config layer's discipline is
 * that a typo is reported by name, and a silently ignored key is the same defect
 * one level down: the operator's setting looks saved and does nothing.
 */
import type { ConfigSchema, StandardResult } from './types.js';

/** The JS types a config field may hold. */
export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'string[]';

/** What one field of a plugin's config accepts. */
export interface ConfigFieldSpec {
  readonly type: ConfigFieldType;
  /** For a string field: the accepted values, i.e. an enum at the config layer. */
  readonly oneOf?: readonly string[];
}

/**
 * Build a `ConfigSchema` for an object of settings.
 *
 * @param fields - one spec per key of `T`; the mapped type is what keeps a field
 *   from existing without a validator.
 * @returns the validator `Fiber` runs before the plugin body.
 */
export function objectConfig<T extends object>(
  fields: { readonly [K in keyof T & string]: ConfigFieldSpec },
): ConfigSchema<T> {
  const specs: Readonly<Record<string, ConfigFieldSpec>> = fields;
  return {
    '~standard': {
      validate(value: unknown): StandardResult<T> {
        if (value === undefined) return { value: {} as T };
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return { issues: [{ message: `expected an object of settings, got ${describe(value)}` }] };
        }
        const raw = value as Record<string, unknown>;
        const issues: { message: string }[] = [];
        for (const key of Object.keys(raw)) {
          if (!Object.hasOwn(specs, key)) issues.push({ message: `unknown setting "${key}"` });
        }
        const out: Record<string, unknown> = {};
        for (const [key, spec] of Object.entries(specs)) {
          const field = raw[key];
          if (field === undefined) continue;
          // `string[]` is the one composite field, and it exists because a
          // security-relevant LIST (whose QQ identities may control this machine)
          // must not be stored as a delimited string: the escaping would become
          // the operator's problem and a stray separator would silently change who
          // is authorized. Copied on the way out so a caller cannot mutate the
          // document it was validated from.
          if (spec.type === 'string[]') {
            if (!Array.isArray(field) || !field.every((item) => typeof item === 'string')) {
              issues.push({ message: `setting "${key}" must be an array of strings` });
              continue;
            }
            out[key] = [...field];
            continue;
          }
          if (typeof field !== spec.type || (spec.type === 'number' && !Number.isFinite(field))) {
            issues.push({ message: `setting "${key}" must be a ${spec.type}` });
            continue;
          }
          if (spec.oneOf !== undefined && !spec.oneOf.includes(field as string)) {
            issues.push({ message: `setting "${key}" must be one of ${spec.oneOf.join(' | ')}` });
            continue;
          }
          out[key] = field;
        }
        return issues.length > 0 ? { issues } : { value: out as T };
      },
    },
  };
}

/** How a rejected value reads in an issue (never its content — it may be a secret). */
function describe(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}
