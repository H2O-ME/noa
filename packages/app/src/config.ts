/**
 * `~/.noa/config.json` — the ONLY config location, and the whole of what an
 * operator can change without editing source.
 *
 * Ported from nova's `packages/cli/src/config.ts`, TRIMMED to the sections this
 * product actually reads. The trimming is the point: nova's schema accepted
 * `ui` / `notify` / `providers` / `models` / `surfaces` because its surfaces read
 * them, and every accepted-but-unread key is the "looks saved, does nothing"
 * failure mode the strict schema exists to prevent. A key that no code in this
 * repo reads is refused at load, by name.
 *
 * Strict at every level: a typo ("apporval", "temprature", "plugins.entrys") is a
 * silent no-op on a lenient schema and a confusing wrong-way run.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { z } from 'zod';
import { errMessage, userConfigPath } from '@noa/core';
import { expandConfigDocument, type ConfigDiagnostic } from './config-expand.js';

export { expandRefs, diagnosticText, unresolvedRef } from './config-expand.js';
export type { ConfigDiagnostic } from './config-expand.js';

const configSchema_ = z
  .object({
    /**
     * The model endpoint. Optional on purpose: a first run with no file at all is
     * the supported starting state, and the product refuses with a sentence that
     * says which key to fill rather than failing inside a client constructor.
     */
    provider: z
      .object({
        /** Any OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. */
        baseURL: z.string().min(1),
        /** The key; `{env:NAME}` is expanded at load (see `config-expand.ts`). */
        apiKey: z.string().min(1),
        /** Model id as the endpoint spells it. */
        model: z.string().min(1).optional(),
        /** Sampling temperature, passed through to the provider. */
        temperature: z.number().min(0).max(2).optional(),
        /** Passed through as `max_tokens` when set. */
        maxTokens: z.number().int().positive().max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    /** Permission tier new conversations start at. Defaults to `read-only`. */
    approval: z.enum(['read-only', 'auto-edit', 'full']).optional(),
    /**
     * Appended to every session's directives (not the persona). Use it for
     * deployment-wide instructions — "answer in Chinese", a house style.
     */
    systemPrompt: z.string().optional(),
    /** Hard cap on turns per run. */
    maxTurns: z.number().int().positive().max(500).optional(),
    /**
     * Auto-compact threshold in prompt tokens: past it the session is summarized
     * and restarted. Unset disables it.
     */
    autoCompactTokenLimit: z.number().int().positive().max(2_000_000).optional(),
    /** Token budget for the injected AGENTS.md chain (default 8000). */
    projectDocMaxTokens: z.number().int().positive().max(1_000_000).optional(),
    /**
     * Model id used to title conversations (log-only `title` marker). Unset
     * means no titles; a failure to title never touches the run.
     */
    titleModel: z.string().min(1).optional(),
    /**
     * The directory the agent works in — its workspace. Defaults to the process's
     * current directory. This is where `read_file` / `write_file` are rooted and
     * what the model sees as "here".
     */
    workspace: z.string().min(1).optional(),
    /**
     * The plugin tree: the ONE place a row is switched or configured. A row is
     * `{ id, enabled?, config? }`, `id` is a built-in plugin's name or a module
     * specifier, and `config` is validated by THAT plugin's own schema.
     */
    plugins: z
      .object({
        entries: z
          .array(
            z
              .object({
                id: z.string().min(1),
                enabled: z.boolean().optional(),
                config: z.unknown().optional(),
              })
              .strict(),
          )
          // Duplicate ids are ambiguous BY CONSTRUCTION, and the ambiguity is not
          // even consistent: the writer edits the FIRST row with an id while the
          // runtime tree maps rows by id (LAST one wins) — so a duplicate could
          // mean the operator's switch and the running row disagree.
          .superRefine((rows, ctx) => {
            const seen = new Set<string>();
            for (const row of rows) {
              if (seen.has(row.id)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `plugins.entries 有重复的插件 id "${row.id}"（同一个插件只能有一行）`,
                });
                return;
              }
              seen.add(row.id);
            }
          })
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Skills switched off globally, by name: a disabled skill is absent from the
     * `<available_skills>` index AND from the `skill` tool — one rule, not two.
     */
    skills: z
      .object({
        disable: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The config schema, exported for the RAW-document writers (`config-doc.ts`):
 * every writer validates the unexpanded document BEFORE its atomic commit, so a
 * save that would produce an unbootable file is refused at the save — with the
 * file untouched — instead of at the next start, when the operator is no longer
 * looking.
 */
export const configSchema = configSchema_;

export type Config = z.infer<typeof configSchema>;

/**
 * The loaded config plus what was wrong with it without being fatal.
 *
 * `diagnostics` is non-empty when a PLUGIN-owned section holds an unset
 * `{env:NAME}`. The value is left as written, so the owning plugin reports it
 * where it is actually needed.
 */
export interface LoadedConfig {
  readonly config: Config;
  readonly diagnostics: readonly ConfigDiagnostic[];
}

/**
 * Load `~/.noa/config.json` — the ONLY config location — with the non-fatal
 * problems found while expanding it.
 *
 * **A MISSING file is an empty shell, not an error**: a first run has no file at
 * all, and that is the supported starting state. A file that EXISTS but is
 * malformed still throws — that is a config the operator wrote and got wrong,
 * and silently replacing it with defaults would hide the mistake.
 *
 * @param homedir - the home directory to resolve `~/.noa` under.
 * @returns the config and its diagnostics.
 */
export async function loadConfigWithDiagnostics(homedir: string = os.homedir()): Promise<LoadedConfig> {
  const file = userConfigPath(homedir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { config: configSchema.parse({}), diagnostics: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${errMessage(err)}`);
  }
  const { value: expanded, diagnostics } = expandConfigDocument(parsed);
  const result = configSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid config ${file}:\n${issues}`);
  }
  return { config: result.data, diagnostics };
}

/**
 * Load the config, discarding the diagnostics.
 * @param homedir - the home directory to resolve `~/.noa` under.
 * @returns the parsed config.
 */
export async function loadConfig(homedir: string = os.homedir()): Promise<Config> {
  return (await loadConfigWithDiagnostics(homedir)).config;
}
