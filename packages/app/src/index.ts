#!/usr/bin/env node
/**
 * `noa` — argv in, one of three actions out.
 *
 * This file is deliberately thin: parse, dispatch, report. Everything that
 * touches the kernel lives in `host.ts` / `boot.ts`, and everything that touches
 * the config file lives in `config*.ts`, so a reader looking for "what happens on
 * startup" has one file to open.
 */
import process from 'node:process';
import { helpText } from './copy.js';
import { parseArgs } from './cli-args.js';
import { writeStarterConfig } from './channel-row.js';
import { runHost } from './host.js';
import { VERSION } from './version.js';

async function main(): Promise<number> {
  const command = parseArgs(process.argv.slice(2));
  switch (command.kind) {
    case 'help':
      console.log(helpText());
      return 0;
    case 'version':
      console.log(VERSION);
      return 0;
    case 'error':
      console.error(`${command.message}\n\n${helpText()}`);
      return 2;
    case 'init': {
      const file = await writeStarterConfig(command.workspace ?? process.cwd());
      console.log(`已写入起始配置：${file}\n请填好 provider（baseURL / apiKey / model）与通道行的 appId / clientSecret，然后运行 noa。`);
      return 0;
    }
    case 'run':
      return await runHost({
        check: command.check,
        json: command.json,
        ...(command.workspace !== undefined ? { workspace: command.workspace } : {}),
      });
  }
}

main().then(
  (code) => {
    // Not process.exit(code): stdout may still be draining, and truncating the
    // banner is exactly the failure the operator would report as "it printed
    // nothing".
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
