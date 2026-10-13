import { defineConfig } from 'tsdown';

export default defineConfig({
  // The PTC worker is a standalone spawn-only entry: keyed entries pin the
  // output names (dist/index.mjs, dist/worker.mjs) that the runtime's
  // `new URL('./worker.mjs', import.meta.url)` resolution depends on.
  entry: { index: 'src/index.ts', worker: 'src/worker.ts' },
  format: 'esm',
  dts: true,
  clean: true,
  fixedExtension: true,
});
