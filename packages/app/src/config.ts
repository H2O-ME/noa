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
import { migrateConfigDocument } from './config-migrate.js';

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
        /**
         * What the model above accepts, when models.dev cannot say.
         *
         * `["text"]` means images are NOT sent to it: they are replaced by a line
         * naming the file on disk, because a gateway that does not accept image
         * parts may answer 200 and drop them, leaving the model to explain a
         * question about a picture it never received. `["text","image"]` sends
         * them. Absent means "ask models.dev".
         *
         * It exists because automatic metadata runs out on gateway aliases: the
         * id `DeepSeek-V4-Flash` appears under ~40 models.dev providers and they
         * disagree, and `GLM-4V-Flash` does not appear at all. Measured on this
         * product's own gateway, `DeepSeek-V4-Flash` answers 200 to a request
         * carrying a 195KB image and reports the same `prompt_tokens` as one
         * carrying none — the picture is dropped in silence. No amount of
         * metadata can detect that; the operator can.
         */
        inputModalities: z.array(z.string().min(1)).min(1).optional(),
        /** Sampling temperature, passed through to the provider. */
        temperature: z.number().min(0).max(2).optional(),
        /** Passed through as `max_tokens` when set. */
        maxTokens: z.number().int().positive().max(1_000_000).optional(),
        /**
         * Extra endpoints to fall back to, in order, when the primary cannot
         * serve a request: a terminal rejection (401/403/404 — re-asking the
         * same host cannot help) or a spent retry budget (rate limit, quota, a
         * host that is down). The fallback is tried INSIDE the same request, so
         * a turn survives the primary going away instead of failing on the first
         * message of the outage.
         *
         * Same protocol, different address: this is for a second key or a second
         * mirror of the same model, not for a provider of another shape.
         * `model` is optional because the usual case is the same id served
         * elsewhere; name it when the two endpoints spell it differently.
         *
         * After the primary fails, the next ~60s of requests try the fallbacks
         * FIRST and only then the primary — so a rate-limited endpoint is not
         * re-hit on every turn. That window is a preference, not a verdict: it
         * lapses on its own and a working primary takes the lead back.
         */
        fallbacks: z
          .array(
            z
              .object({
                baseURL: z.string().min(1),
                apiKey: z.string().min(1),
                model: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1)
          .optional(),
      })
      .strict()
      .optional(),
    /** Permission tier new conversations start at. Defaults to `auto`. */
    approval: z.enum(['full', 'auto']).optional(),
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
     * The model that reviews a gated tool call in the `auto` tier (the
     * smart-approval classifier). It runs on the SAME endpoint as `provider`
     * (baseURL/apiKey are reused); unset means the reviewer uses the main model.
     * A cheap, fast model is the right choice here — it classifies one command,
     * it does not do the work.
     */
    reviewModel: z.string().min(1).optional(),
    /**
     * The model that turns text into vectors, for the memory system's semantic
     * recall. Same endpoint as `provider` (baseURL/apiKey are reused).
     *
     * Unset means NO embeddings, and that is a supported state rather than a
     * half-configured one: `recall` falls back to keyword matching and everything
     * else about memory works unchanged. There is deliberately no fallback to
     * `provider.model` — a chat model id sent to `/embeddings` is a 404, so
     * guessing would trade "no semantic search" for "every recall fails".
     */
    embedModel: z.string().min(1).optional(),
    /**
     * The model that turns voice messages into text, for the QQ channel's inbound
     * voice. Same endpoint as `provider` (baseURL/apiKey are reused).
     *
     * Unset means NO transcription, and that is a supported state rather than a
     * half-configured one: a voice message then arrives as
     * 「收到一条语音，未配置转写」and the rest of the message is unaffected. There is
     * deliberately no fallback to `provider.model` — a chat model id sent to
     * `/audio/transcriptions` is a 404, so guessing would trade "no transcripts"
     * for "every voice message fails".
     */
    sttModel: z.string().min(1).optional(),
    /**
     * What each model costs, in USD per MILLION tokens — the unit every endpoint
     * publishes prices in. Keyed by model id exactly as the endpoint spells it
     * (the same spelling `provider.model` carries after boot reconciliation).
     *
     * This is a DISPLAY fact, not a routing one: nothing here changes what is
     * sent or where. Its only reader is `/usage`, which turns the session's token
     * totals into an estimate.
     *
     * Unset is a supported state: `/usage` then reports tokens and says the model
     * is unpriced, rather than printing $0.00 — a number that is indistinguishable
     * from "free". A model missing from the table reads the same way, and so does a
     * table entry with neither side filled in.
     *
     * A price on ONE side only is honored as such: the estimate is then reported
     * as a LOWER BOUND rather than pretending the unpriced side is free.
     */
    pricing: z
      .record(
        z.string().min(1),
        z
          .object({
            /** Prompt-token price, USD per million. */
            input: z.number().nonnegative().optional(),
            /** Completion-token price, USD per million. */
            output: z.number().nonnegative().optional(),
          })
          .strict(),
      )
      .optional(),
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
  /**
   * Non-fatal upgrades applied to the document while loading (deprecated keys
   * rewritten to their current shape). Printed once at boot so the operator
   * knows why their file looks different the next time a save rewrites it.
   */
  readonly warnings: readonly string[];
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
      return { config: configSchema.parse({}), diagnostics: [], warnings: [] };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${errMessage(err)}`);
  }
  // Upgrade deprecated keys BEFORE expanding/validating: the schema is strict and
  // would otherwise refuse a file written by an earlier release.
  const warnings = migrateConfigDocument(parsed);
  const { value: expanded, diagnostics } = expandConfigDocument(parsed);
  const result = configSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid config ${file}:\n${issues}`);
  }
  return { config: result.data, diagnostics, warnings };
}

/**
 * Load the config, discarding the diagnostics.
 * @param homedir - the home directory to resolve `~/.noa` under.
 * @returns the parsed config.
 */
export async function loadConfig(homedir: string = os.homedir()): Promise<Config> {
  return (await loadConfigWithDiagnostics(homedir)).config;
}
