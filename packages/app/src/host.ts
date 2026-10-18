/**
 * The resident host: boot, say what happened, and stay up serving the channel.
 *
 * This is what `nova qqbot` used to be in nova, with the surface registry left
 * behind: there is ONE way to run this product, so there is no argv-to-surface
 * resolution — only a config load, a boot, a status report and a wait.
 *
 * The status report is the point of the file. A headless channel that fails to
 * come up has four distinct causes (row absent / row off / row failed to load /
 * credentials missing), and each one has a different next action. Merging them
 * into a single "please enable it" is the defect this shape exists to prevent.
 */
import os from 'node:os';
import process from 'node:process';
import { probeQqBotConnection, runningQqBotChannel } from '@noa/channel-qq';
import { errMessage, type ChatProvider } from '@noa/core';
import { bootKernel } from './boot.js';
import { configPathOf, dataDirOf, CHANNEL_ROW_ID } from './channel-row.js';
import { diagnosticText, loadConfigWithDiagnostics, type Config } from './config.js';
import { healConfigFile } from './config-doc.js';
import { bannerLines, CHANNEL_LIVE, CONFIG_HEALED, channelRefusal, credentialRefusal } from './copy.js';
import { failedPluginLines, pluginRowState } from './plugin-report.js';
import { VERSION } from './version.js';

/** How long the boot waits for the gateway's READY before it says "still connecting". */
const READY_WAIT_MS = 10_000;

/** ~12 days: long enough that the keep-alive never actually fires. */
const KEEP_ALIVE_MS = 2 ** 30;

export interface HostOptions {
  /** `--workspace`, or the config's `workspace`, or the process's cwd. */
  workspace?: string;
  /** Boot, report, tear down and return an exit code (`--check`). */
  check?: boolean;
  /** `--json` shapes the report for a service manager. */
  json?: boolean;
  /** Test seam: the home directory every path resolves under. */
  homedir?: string;
  /** Test seam: a fake provider, so a test never dials an endpoint. */
  provider?: ChatProvider;
  /** Test seam: skip the config file entirely. */
  config?: Config;
}

/**
 * Run the product once. Returns the process exit code — no `process.exit` here,
 * so a test can call this and inspect what happened.
 * @param options - overrides for the three test seams and the CLI flags.
 * @returns 0 when the channel is up (or `check` found it up), 1 otherwise.
 */
export async function runHost(options: HostOptions = {}): Promise<number> {
  const homedir = options.homedir;
  const loaded =
    options.config !== undefined
      ? { config: options.config, diagnostics: [] as const, warnings: [] as const }
      : await loadConfigWithDiagnostics(homedir ?? os.homedir());
  const config = loaded.config;
  const workspace = options.workspace ?? config.workspace ?? process.cwd();

  for (const diagnostic of loaded.diagnostics) {
    console.warn(`警告：${diagnosticText(diagnostic)}`);
  }
  // Deprecated keys rewritten on load: say so, since the next save will write the
  // migrated form and the operator should not be surprised by the difference.
  for (const warning of loaded.warnings) {
    console.warn(`提示：${warning}`);
  }
  // …and then actually do it, when this is a real boot. Nothing patches the file
  // during normal operation any more (the settings page is gone), so without this
  // the notes above would be re-printed on every single start forever. `--check`
  // stays read-only: a check that edits the file it is checking is not a check.
  if (options.check !== true && loaded.warnings.length > 0) {
    try {
      await healConfigFile(homedir);
      console.warn(CONFIG_HEALED);
    } catch (err) {
      // A home the process cannot write is not a reason to refuse to start: the
      // config it already loaded IS the migrated one, so this only means the notes
      // will come back next time.
      console.warn(`提示：${errMessage(err)}`);
    }
  }

  const kernel = await bootKernel({
    rootDir: workspace,
    config,
    ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  });

  try {
    const roster = kernel.roster();
    const state = pluginRowState(roster, CHANNEL_ROW_ID);
    const channel = state.kind === 'active' ? runningQqBotChannel() : undefined;

    if (!options.json) {
      for (const line of bannerLines({
        version: VERSION,
        dataDir: dataDirOf(homedir),
        configPath: configPathOf(homedir),
        workspace,
        model: kernel.llm.model,
        approval: config.approval ?? 'auto',
      })) {
        console.log(line);
      }
    }
    // A failed row never stops the boot; it is a line the operator may need.
    for (const line of failedPluginLines(roster)) console.warn(`警告：${line}`);

    if (options.check) {
      await kernel.dispose();
      return await reportCheck(state, channel !== undefined, options.json === true, config);
    }

    if (state.kind !== 'active') {
      console.error(channelRefusal(state));
      await kernel.dispose();
      return 1;
    }

    if (channel === undefined) {
      console.error(credentialRefusal());
      await kernel.dispose();
      return 1;
    }

    // The approval policy is left at the default (`ask`): in the `auto` tier a
    // dangerous call is classified by the reviewer model first, and only when it
    // is unsure does the question reach this peer's chat window. `full` never
    // asks. Nothing here pins `never` — that would silence the escalation path
    // the whole design rests on.
    console.log(CHANNEL_LIVE);

    await waitForReady(() => channel.running);
    await stayUp(kernel);
    return 0;
  } catch (err) {
    await kernel.dispose();
    throw err;
  }
}

/**
 * The `--check` report: one line a service manager or a person can read.
 *
 * An `active` row without a live channel is NOT "unknown" — it is the one cause
 * the row cannot show: the credentials are missing, which the channel itself is
 * the only thing that can decide (it declines to dial without them).
 *
 * With credentials present the row IS live, so the remaining question is whether
 * the credentials actually WORK — a wrong AppSecret produces a live object whose
 * socket never comes up. That is answered by the same probe the (removed)
 * settings page's "test connection" button used, so `--check` verifies rather
 * than merely confirms that two fields are non-empty.
 * @param state - the channel row's resolved state.
 * @param live - whether a channel object exists at all.
 * @param json - shape the report for a service manager.
 * @param config - the loaded config, for the row's credentials.
 * @returns the process exit code.
 */
async function reportCheck(
  state: ReturnType<typeof pluginRowState>,
  live: boolean,
  json: boolean,
  config: Config,
): Promise<number> {
  const credentials = qqCredentials(config);
  if (!live || credentials === undefined) {
    if (json) console.log(JSON.stringify({ channel: state.kind, live }, null, 2));
    else console.log(state.kind === 'active' ? credentialRefusal() : channelRefusal(state));
    return 1;
  }
  try {
    const gateway = await probeQqBotConnection(credentials);
    if (json) console.log(JSON.stringify({ channel: state.kind, live: true, credentials: 'ok' }, null, 2));
    else console.log(`检查结果：通道可用（凭据有效，网关 ${gateway}）。`);
    return 0;
  } catch (err) {
    if (json) {
      console.log(JSON.stringify({ channel: state.kind, live: true, credentials: 'invalid', error: errMessage(err) }, null, 2));
    } else {
      console.error(`检查结果：凭据无效（${errMessage(err)}）。`);
    }
    return 1;
  }
}

/**
 * The QQ row's credentials, read from the config document.
 *
 * The row's `config` is `unknown` to the host (a plugin's settings are its own
 * business), so this reads the two string fields defensively and returns
 * undefined when either is missing — the same "cannot dial" answer the plugin
 * reaches through `qqBotCredentialProblem`.
 * @param config - the loaded config.
 * @returns the credentials, or undefined when the row has none to dial with.
 */
function qqCredentials(config: Config): { appId: string; clientSecret: string } | undefined {
  const row = config.plugins?.entries?.find((entry) => entry.id === CHANNEL_ROW_ID);
  const raw = row?.config;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const appId = (raw as Record<string, unknown>)['appId'];
  const clientSecret = (raw as Record<string, unknown>)['clientSecret'];
  if (typeof appId !== 'string' || typeof clientSecret !== 'string') return undefined;
  if (appId.trim().length === 0 || clientSecret.trim().length === 0) return undefined;
  return { appId, clientSecret };
}

/**
 * Give the gateway a bounded chance to answer, then say which of the two it is.
 * Silence would leave an operator guessing whether a quiet bot is broken.
 * @param running - the channel's own READY reading.
 */
async function waitForReady(running: () => boolean): Promise<void> {
  const deadline = Date.now() + READY_WAIT_MS;
  while (!running() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(running() ? '网关已就绪（READY）。' : `网关尚未就绪（等待 ${READY_WAIT_MS / 1000}s 未收到 READY，继续在后台重试）。`);
}

/**
 * Stay resident until a signal arrives.
 *
 * Shutdown goes through the kernel's own teardown: disposing the container
 * unwinds the plugin fibers, and the channel closes its socket on the way out —
 * no second stop() path that could drift from that one.
 *
 * The interval is load-bearing, not decoration. A pending promise does NOT hold
 * Node's event loop open, and neither do signal listeners: with nothing else
 * pending — a channel whose dial failed before it armed a retry — the loop
 * drained and the process exited 0, so a resident bot vanished with a clean exit
 * code and no bot behind it. A live timer handle is what makes "resident" true.
 * @param kernel - the live kernel.
 */
async function stayUp(kernel: { dispose(): Promise<void> }): Promise<void> {
  const shutdown = (): void => {
    void kernel.dispose().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  setInterval(() => undefined, KEEP_ALIVE_MS);
  // Unreachable by design: the loop above keeps this process alive until a signal
  // runs `shutdown`, which exits.
  await new Promise<never>(() => undefined);
}
