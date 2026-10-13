/**
 * The product version, read from this package's own `package.json` so it cannot
 * drift from what is published.
 */
import { createRequire } from 'node:module';

interface PackageJson {
  readonly version?: string;
}

const require_ = createRequire(import.meta.url);

/** `@noa/app`'s version (the number `noa --version` prints). */
export const VERSION: string = (require_('../package.json') as PackageJson).version ?? '0.0.0';
