/**
 * Builds marketing/index.html into a single self-contained file.
 *
 * The page is published as an Artifact and can be handed to anyone as a file,
 * and both of those forbid a font CDN — the Artifact CSP blocks external hosts
 * outright, and a file opened from disk has no origin to fetch from. So the
 * three woff2 subsets are inlined as data URIs here rather than linked.
 *
 * Output goes to marketing/dist/, which is gitignored: it is build output, and
 * the base64 fonts alone are ~225 KB that would otherwise land in every diff.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'marketing/index.html')
const outDir = resolve(root, 'marketing/dist')

let html = readFileSync(src, 'utf8')

// Rewrite every node_modules url(...) in the @font-face block to a data URI.
const FONT_URL = /url\((\.\.\/node_modules\/[^)]+\.woff2)\)/g
const missing = []
html = html.replace(FONT_URL, (whole, rel) => {
  const file = resolve(root, rel.replace('../', ''))
  try {
    return `url(data:font/woff2;base64,${readFileSync(file).toString('base64')})`
  } catch {
    missing.push(rel)
    return whole
  }
})

if (missing.length) {
  console.error('Missing font files — run `npm install` first:')
  for (const m of missing) console.error('  ' + m)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
const out = resolve(outDir, 'index.html')
writeFileSync(out, html)
console.log(`marketing → ${out} (${(html.length / 1024).toFixed(0)} KB)`)
