import { defineConfig } from 'tsdown';

export default defineConfig({
  // The search worker is a standalone spawn-only entry: the keyed entry pins
  // the output name (dist/search-worker.mjs) that the tool's
  // `new URL('./search-worker.mjs', import.meta.url)` resolution depends on.
  // (The PTC worker moved with its plugin to `@noa/plugin-ptc`.)
  entry: { index: 'src/index.ts', 'search-worker': 'src/builtin/search-worker.ts' },
  format: 'esm',
  dts: true,
  clean: true,
  fixedExtension: true,
});
