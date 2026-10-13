import { defineConfig } from 'tsdown';

export default defineConfig({
  // Two entries: the kernel (Node) and the browser-safe leaf (totals.ts imports
// nothing at runtime, so its dist file is safe to bundle into the ui's browser
// build — the kernel's dist top-level imports node:fs and is not).
  entry: ['src/index.ts', 'src/totals.ts'],
  format: 'esm',
  dts: true,
  clean: true,
  fixedExtension: true,
});
