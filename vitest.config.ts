import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Ordered array, not an object map: object keys give no matching-order
    // guarantee, and `@noa/core/totals` must resolve BEFORE the
    // `@noa/core` prefix rule turns it into `…/index.ts/totals`.
    alias: [
      { find: /^@noa\/core\/totals$/, replacement: fileURLToPath(new URL('./packages/core/src/totals.ts', import.meta.url)) },
      { find: '@noa/core', replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)) },
      { find: '@noa/ai', replacement: fileURLToPath(new URL('./packages/ai/src/index.ts', import.meta.url)) },
      { find: '@noa/plugins', replacement: fileURLToPath(new URL('./packages/plugins/src/index.ts', import.meta.url)) },
      { find: '@noa/channel-qq', replacement: fileURLToPath(new URL('./packages/channel-qq/src/index.ts', import.meta.url)) },
      { find: '@noa/plugin-subagent', replacement: fileURLToPath(new URL('./packages/plugin-subagent/src/index.ts', import.meta.url)) },
      { find: '@noa/plugin-context', replacement: fileURLToPath(new URL('./packages/plugin-context/src/index.ts', import.meta.url)) },
      { find: '@noa/plugin-ptc', replacement: fileURLToPath(new URL('./packages/plugin-ptc/src/index.ts', import.meta.url)) },
      { find: '@noa/app', replacement: fileURLToPath(new URL('./packages/app/src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    environment: 'node',
    // Tests do real I/O by design (spawned shells, real worker threads, real
    // ports); the wall clock belongs to this machine, not to the behaviour under
    // test. 30s matches the budget the I/O-heavy suites ask for by name.
    testTimeout: 30_000,
    /**
     * Every suite runs with `~/.noa` redirected to a throwaway directory,
     * installed globally so no test author has to remember it.
     */
    setupFiles: ['./packages/test-setup.ts'],
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
  },
});
