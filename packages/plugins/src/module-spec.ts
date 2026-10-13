/**
 * Where a plugin module IS: the ONE resolution rule for `plugins.entries` rows,
 * the configured `surfaces` rows and the extension table.
 *
 * A config row is a module specifier, and it means one of three things:
 *
 *  - **a path** (absolute, or starting with `.`): resolved against the working
 *    directory — the operator wrote the row while standing in a workspace, and
 *    a local file is the zero-install way to try a plugin.
 *  - **a bare package name the product itself can resolve**: handed to Node
 *    untouched, or — when only the host application can resolve it — turned into
 *    the file it resolved to. That covers the bundled extensions and anything
 *    installed next to the product.
 *  - **a bare package name that only exists in the USER PLUGIN ROOT**
 *    (`~/.noa/plugins/`): resolved from there, because that is the one tree a
 *    user can install into (`nova plugin add`, or `pnpm add` in that directory)
 *    without reaching into wherever the product was installed.
 *
 * The user root is a **fallback, never a shadow**: a name the product can
 * already resolve keeps resolving where it did. A shadowing root would let a
 * stale copy the operator installed months ago silently replace a bundled
 * package the moment nova is upgraded — the bug would surface as "the upgrade
 * did nothing", far from its cause.
 *
 * ## What "the product" is anchored at
 *
 * `appModulesUrl` is the HOST APPLICATION's own module URL (`cli` passes its
 * `import.meta.url` at kernel assembly), and it has to come from the caller: the
 * product's packages are siblings of the EXECUTABLE, not of this library (the QQ
 * channel package ships with `cli`), so a library-level anchor cannot see them —
 * a config row naming one could never load, while `noa` tells the
 * operator to write exactly that row. This package's tree is consulted FIRST
 * (its answer is the bare spec, which Node resolves identically at import time);
 * the app's tree second, and ITS answer is the resolved file, because a bare
 * spec would be re-resolved from here at import time and fail. No anchor means
 * library-level, exactly as before (embedded kernels and kernel tests).
 *
 * Entry resolution inside the user root is Node's own (`createRequire` anchored
 * at the root's `package.json`), so `exports` / `module` / `main` are honored
 * rather than re-implemented. The plugin convention is
 * `exports: { ".": { types, default } }`; a package whose export map offers
 * only an `import` arm cannot be named by the CJS resolver, and the bare spec is
 * returned instead — the resulting boot error names the config row.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { userPluginsDir } from '@noa/core';

/** `createRequire(base).resolve(spec)`, or undefined when it cannot name it. */
function tryResolve(base: string, spec: string): string | undefined {
  try {
    return createRequire(base).resolve(spec);
  } catch {
    return undefined;
  }
}

/**
 * Can the product resolve this specifier on its own (before the user root is
 * tried)? Exported for diagnostics (`nova plugin list` tells a row that ships
 * with the product from one that will fail to load).
 *
 * `false` only means "neither the library's tree nor the app's could name it":
 * the spec still goes back untouched, and Node's ESM resolver — the one that
 * will actually load it — gets to decide (which is also the answer for a package
 * whose export map has no `require`/`default` arm).
 * @param spec - the config row's module specifier.
 * @param appModulesUrl - the host application's own module URL; see the header.
 */
export function resolvableFromProduct(spec: string, appModulesUrl?: string): boolean {
  if (tryResolve(import.meta.url, spec) !== undefined) return true;
  return appModulesUrl !== undefined && tryResolve(appModulesUrl, spec) !== undefined;
}

/**
 * Resolve a module spec the way plugins and surfaces load it.
 *
 * Shared by the plugin tree (`plugin-tree.ts`) and the surface registry
 * (`surface-registry.ts`), so one config string means one thing everywhere.
 * @param spec - the config row's module specifier.
 * @param cwd - the base for relative paths (the process working directory).
 * @param homedir - Override for tests; defaults to the real home (the user plugin root lives under it).
 * @param appModulesUrl - the host application's own module URL; see the header.
 * @returns a file URL, or the bare spec for Node to resolve at import time.
 */
export function resolveModuleSpec(spec: string, cwd: string, homedir?: string, appModulesUrl?: string): string {
  if (isAbsolute(spec) || spec.startsWith('.')) return pathToFileURL(resolve(cwd, spec)).href;
  // This package's own tree. The proven file URL, not the bare spec: the bare
  // spec assumes Node re-resolves it identically at import time, which a loader
  // that patches only CJS resolution (tsx under `pnpm dev`) breaks — require
  // "succeeds" from a tree that cannot actually import it, and the ESM import
  // then fails from here (a bundled channel package is NOT a dependency of this
  // library). Both branches hand back the file they proved, so the library tree,
  // the app tree and the user root tell ONE resolution story.
  const fromLibrary = tryResolve(import.meta.url, spec);
  if (fromLibrary !== undefined) return pathToFileURL(fromLibrary).href;
  // The app's tree: NOT on this package's resolution path, so the proven target
  // is what gets imported — a bare spec would be re-resolved from here and fail.
  const fromApp = appModulesUrl === undefined ? undefined : tryResolve(appModulesUrl, spec);
  if (fromApp !== undefined) return pathToFileURL(fromApp).href;
  const root = homedir === undefined ? userPluginsDir() : userPluginsDir(homedir);
  if (!existsSync(join(root, 'node_modules', spec, 'package.json'))) return spec;
  try {
    return pathToFileURL(createRequire(join(root, 'package.json')).resolve(spec)).href;
  } catch {
    return spec;
  }
}
