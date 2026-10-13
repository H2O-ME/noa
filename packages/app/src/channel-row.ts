/**
 * The QQ channel's config row — its id, and the starter file `noa init`
 * writes.
 *
 * The row is how the channel is switched and configured, exactly like every other
 * plugin: the id is what `plugins.entries` names, and the object inside its
 * `config` is validated by the channel package's own schema. Nothing in this file
 * knows what those settings mean.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { appHome, userConfigPath } from '@noa/core';

/** The channel's row id: a module specifier, resolved against this app. */
export const CHANNEL_ROW_ID = '@noa/channel-qq';

/** The placeholder `noa init` writes for values only the operator can fill. */
export const PLACEHOLDER = 'REPLACE_ME';

/**
 * The starter document. Every key it writes is one the product really reads — a
 * commented-out idea would be a key that does nothing, and the strict schema
 * refuses those on purpose.
 * @param workspace - the directory to record as the agent's workspace.
 * @returns the document to write.
 */
export function starterConfig(workspace: string): Record<string, unknown> {
  return {
    provider: {
      baseURL: 'https://api.example.com/v1',
      apiKey: PLACEHOLDER,
      model: 'your-model-id',
    },
    approval: 'read-only',
    workspace,
    plugins: {
      entries: [
        {
          id: CHANNEL_ROW_ID,
          enabled: true,
          config: {
            appId: '',
            clientSecret: '',
            maxTier: 'read-only',
          },
        },
      ],
    },
  };
}

/**
 * Write the starter config, refusing to touch an existing file.
 *
 * Refusing rather than merging is deliberate: this file is the operator's, and a
 * command that silently rewrote parts of it would be indistinguishable from one
 * that lost their edits.
 * @param workspace - the directory to record as the agent's workspace.
 * @param homedir - Override for tests; defaults to the real home.
 * @returns the path written.
 */
export async function writeStarterConfig(workspace: string, homedir?: string): Promise<string> {
  const file = homedir === undefined ? userConfigPath() : userConfigPath(homedir);
  if (await exists(file)) {
    throw new Error(`${file} 已存在：init 不会覆盖它。要重新生成，请先把它移走或改名。`);
  }
  const dir = homedir === undefined ? appHome() : appHome(homedir);
  await mkdir(dir, { recursive: true });
  await writeFile(file, `${JSON.stringify(starterConfig(workspace), null, 2)}\n`, 'utf8');
  return file;
}

/** Whether a path exists (any type). */
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The data directory this process uses, for the banner. */
export function dataDirOf(homedir?: string): string {
  return homedir === undefined ? appHome() : appHome(homedir);
}

/** The config file path this process uses, for the banner and refusals. */
export function configPathOf(homedir?: string): string {
  return homedir === undefined ? userConfigPath() : userConfigPath(homedir);
}

/** Sessions land here (date buckets) — exported so the banner can point at them. */
export function sessionsDirOf(homedir?: string): string {
  return homedir === undefined ? path.join(appHome(), 'sessions') : path.join(appHome(homedir), 'sessions');
}
