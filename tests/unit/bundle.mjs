/**
 * Import an app TypeScript module from plain-node unit tests: bundles the
 * entry with esbuild (already present as Vite's dependency) into the ESM the
 * test imports. Browser-only entries can stub DOM-touching siblings via
 * `alias`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const outDir = mkdtempSync(join(tmpdir(), 'cardstock-unit-'))
let n = 0

export async function bundleImport(entryRelativeToRepo, { alias = {}, external = [] } = {}) {
  const outfile = join(outDir, `m${n++}.mjs`)
  // esbuild's `alias` option only takes package names; relative keys
  // ("./fetchJson") are matched against the specifier as written, via a
  // resolve plugin, so tests can stub a sibling module wherever it's
  // imported from.
  const names = {}
  const paths = {}
  for (const [from, to] of Object.entries(alias)) (from.startsWith('.') || from.startsWith('/') ? paths : names)[from] = to
  const pathAlias = {
    name: 'path-alias',
    setup(build) {
      for (const [from, to] of Object.entries(paths)) {
        const filter = new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
        build.onResolve({ filter }, () => ({ path: to }))
      }
    },
  }
  await build({
    entryPoints: [join(REPO, entryRelativeToRepo)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    alias: names,
    external,
    plugins: Object.keys(paths).length ? [pathAlias] : [],
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}
