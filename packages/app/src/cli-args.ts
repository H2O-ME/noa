/**
 * argv in, one command out.
 *
 * Deliberately tiny: this product has three verbs (run, init, help/version), so
 * the parser is a switch over flags rather than a table that has to be kept in
 * sync with a registry.
 */

/** What the operator asked for. */
export type CliCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'run'; readonly check: boolean; readonly json: boolean; readonly workspace?: string }
  | { readonly kind: 'init'; readonly workspace?: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Parse argv (without the node/script prefix).
 *
 * A value flag with no value is an ERROR rather than a silent default: `--workspace`
 * swallowing the next flag is how a run ends up in the wrong directory.
 * @param argv - `process.argv.slice(2)`.
 * @returns the command to run.
 */
export function parseArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) return { kind: 'run', check: false, json: false };

  const positional: string[] = [];
  let check = false;
  let json = false;
  let workspace: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    switch (arg) {
      case '--help':
      case '-h':
        return { kind: 'help' };
      case '--version':
      case '-v':
        return { kind: 'version' };
      case '--check':
        check = true;
        break;
      case '--json':
        json = true;
        break;
      case '--workspace': {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          return { kind: 'error', message: '--workspace 需要一个目录参数' };
        }
        workspace = value;
        index += 1;
        break;
      }
      default:
        if (arg.startsWith('-')) return { kind: 'error', message: `未知选项：${arg}` };
        positional.push(arg);
        break;
    }
  }

  if (positional.length === 0) {
    return { kind: 'run', check, json, ...(workspace !== undefined ? { workspace } : {}) };
  }
  if (positional.length === 1 && positional[0] === 'init') {
    return { kind: 'init', ...(workspace !== undefined ? { workspace } : {}) };
  }
  return { kind: 'error', message: `未知命令：${positional.join(' ')}` };
}
