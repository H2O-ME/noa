/**
 * Test-run isolation: point `~/.noa` at a throwaway directory before any test
 * module loads.
 *
 * WHY THIS EXISTS — and why it is here rather than in each test:
 *
 * `appHome()` resolves against `os.homedir()`, which follows `USERPROFILE` /
 * `HOME` at CALL time. Individual tests that remembered to swap those variables
 * were isolated; the ones that did not (five of them, including
 * `plugins/test/runtime.test.ts`, which builds a REAL kernel over a temp
 * workspace) wrote their session logs, spill caches and config into the
 * developer's actual `~/.noa/`. The result was hundreds of junk session files
 * in the real home — a test suite must never touch the operator's data, and a
 * rule every author has to REMEMBER is a rule that will be forgotten.
 *
 * So the isolation is installed ONCE, below every suite, and it is total: there
 * is no opt-in, no per-file helper to call, and no way to forget. A test that
 * genuinely needs a specific home still uses `withFakeHome`, which now merely
 * narrows the window further — it no longer has to be the thing that saves the
 * developer's data.
 *
 * DISPOSAL — green runs clean up after themselves; red runs leave the scene:
 * every test file (each setup-file invocation) used to leave its home behind
 * "for the OS temp reaper", and 76,000+ directories later that premise is dead
 * — Windows does not reap %TEMP%. A green run removes its own home (afterAll
 * below); a failing file's home SURVIVES, because a failed run's state is
 * exactly what a test author wants to inspect. Other `noa-*` temp families
 * created inside individual test files are reaped by `pnpm clean`
 * (scripts/clean-test-temp.mjs), which only touches directories older than a
 * few hours so a concurrent session's live run is never swept.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach } from 'vitest';

const home = mkdtempSync(path.join(tmpdir(), 'noa-test-home-'));
process.env['USERPROFILE'] = home;
process.env['HOME'] = home;
// `os.homedir()` on POSIX prefers `HOME`; on Windows it prefers `USERPROFILE`.
// Both are set above, and `HOMEDRIVE`/`HOMEPATH` are cleared so a Windows
// lookup cannot fall back to the real profile through those instead.
delete process.env['HOMEDRIVE'];
delete process.env['HOMEPATH'];

// One failed test in the file keeps the whole home (all files of the run may
// have written into theirs) — this is the inspection window, not a leak.
let fileFailed = false;
afterEach((ctx) => {
  if (ctx?.task?.result?.state === 'fail') fileFailed = true;
});
afterAll(() => {
  if (fileFailed) return;
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a lingering handle is not worth failing a green suite over */
  }
});
