/**
 * argv parsing: the shapes an operator can type, and the two mistakes that must
 * NOT be silently absorbed (an unknown option, a value flag with no value).
 */
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli-args.js';

describe('parseArgs', () => {
  it('defaults to a plain run, and reads the flags that change it', () => {
    expect(parseArgs([])).toEqual({ kind: 'run', check: false, json: false });
    expect(parseArgs(['--check', '--json', '--workspace', '/tmp/ws'])).toEqual({
      kind: 'run',
      check: true,
      json: true,
      workspace: '/tmp/ws',
    });
  });

  it('reads `init` as a verb, not as a workspace', () => {
    expect(parseArgs(['init'])).toEqual({ kind: 'init' });
    expect(parseArgs(['init', '--workspace', '/tmp/ws'])).toEqual({ kind: 'init', workspace: '/tmp/ws' });
  });

  it('refuses an unknown option and a value flag with no value', () => {
    // A swallowed next-flag would run in the wrong directory — the failure this
    // refusal exists to make impossible.
    expect(parseArgs(['--workspace'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--workspace', '--check'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['--wat'])).toMatchObject({ kind: 'error' });
    expect(parseArgs(['deploy'])).toMatchObject({ kind: 'error' });
  });

  it('answers help and version before anything else', () => {
    expect(parseArgs(['--workspace', '/tmp/ws', '-h'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-v'])).toEqual({ kind: 'version' });
  });
});
