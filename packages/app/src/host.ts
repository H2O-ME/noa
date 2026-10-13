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
import { runningQqBotAccess, runningQqBotChannel } from '@noa/channel-qq';
import type { ChatProvider } from '@noa/core';
import { bootKernel } from './boot.js';
import { configPathOf, dataDirOf, CHANNEL_ROW_ID } from './channel-row.js';
import { diagnosticText, loadConfigWithDiagnostics, type Config } from './config.js';
import {
  bannerLines,
  CHANNEL_LIVE,
  channelRefusal,
  credentialRefusal,
  enrolledLine,
  enrollmentHint,
} from './copy.js';
import { failedPluginLines, pluginRowState } from './plugin-report.js';
import { VERSION } from './version.js';

/** How long the boot waits for the gateway's READY before it says "still connecting". */
const READY_WAIT_MS = 10_000;

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
      ? { config: options.config, diagnostics: [] as const }
      : await loadConfigWithDiagnostics(homedir ?? os.homedir());
  const config = loaded.config;
  const workspace = options.workspace ?? config.workspace ?? process.cwd();

  for (const diagnostic of loaded.diagnostics) {
    console.warn(`警告：${diagnosticText(diagnostic)}`);
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
        approval: config.approval ?? 'read-only',
      })) {
        console.log(line);
      }
    }
    // A failed row never stops the boot; it is a line the operator may need.
    for (const line of failedPluginLines(roster)) console.warn(`警告：${line}`);

    if (options.check) {
      await kernel.dispose();
      reportCheck(state, channel !== undefined, options.json === true);
      return channel !== undefined ? 0 : 1;
    }

    if (state.kind !== 'active') {
      console.error(channelRefusal(state));
      await kernel.dispose();
      return 1;
    }    if (channel === undefined) {
      console.error(credentialRefusal());
      await kernel.dispose();
      return 1;
    }

    // No human at this end: the read-only tools are usable and everything else is
    // refused before it is even asked. A peer can still LOWER its own tier with
    // `/perm`, which the gate holds — never a way around the policy.
    kernel.agent.setApprovalPolicy('never');

    const access = runningQqBotAccess();
    if (access !== undefined) {
      const owners = access.owners();
      console.log(owners.length === 0 ? enrollmentHint(access.pairingCode()) : enrolledLine(owners.length));
    }
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
 */
function reportCheck(
  state: ReturnType<typeof pluginRowState>,
  live: boolean,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify({ channel: state.kind, live }, null, 2));
    return;
  }
  if (live) {
    console.log('检查结果：通道可用（凭据已填，socket 已在拨号）。');
    return;
  }
  console.log(state.kind === 'active' ? credentialRefusal() : channelRefusal(state));
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
 * @param kernel - the live kernel.
 */
async function stayUp(kernel: { dispose(): Promise<void> }): Promise<void> {
  const shutdown = (): void => {
    void kernel.dispose().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The socket holds the event loop open; this promise is only "the host does not
  // finish on its own".
  await new Promise<never>(() => undefined);
}
