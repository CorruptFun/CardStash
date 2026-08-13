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
  await build({
    entryPoints: [join(REPO, entryRelativeToRepo)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    alias,
    external,
    logLevel: 'silent',
  })
  return import(pathToFileURL(outfile).href)
}
