/**
 * Bring a real card photograph into the harness.
 *
 * Phones shoot 4000px, 4MB JPEGs. The harness resizes to CAPTURE_MAX_EDGE
 * (1600) anyway — that is what the app's own captureFrame hands identifyFrame
 * — so anything above it is repo weight for no signal. This downscales to
 * that edge, writes the file under a stable key, and adds the manifest row so
 * ground truth lands beside the image instead of in someone's memory.
 *
 *   node tests/harness/photos/ingest.mjs <source> \
 *     --key=ygo-secret-ip-masquerena --game=yugioh --name="I:P Masquerena" \
 *     --label=photo-secret --note="blue holo, handheld, indoor lamp"
 *
 * Re-running with an existing key replaces both the image and its row.
 */
import { chromium } from 'playwright-core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'manifest.json')
const MAX_EDGE = 1600
const QUALITY = 0.82

const positional = []
const args = {}
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, ...rest] = a.slice(2).split('=')
    args[k] = rest.join('=') || true
  } else positional.push(a)
}
const source = positional[0]
if (!source || !args.key || !args.game || (!args.name && !args.cards)) {
  console.error('usage: ingest.mjs <source> --key=… --game=… --name="…" [--label=…] [--note=…]')
  console.error('   or: ingest.mjs <source> --key=… --game=… --binder --cards="A|B|C" [--note=…]')
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`no such file: ${source}`)
  process.exit(2)
}

const mime = /\.png$/i.test(source) ? 'image/png' : 'image/jpeg'
const dataUrl = `data:${mime};base64,${readFileSync(source).toString('base64')}`

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const out = await page.evaluate(
  async ({ url, maxEdge, quality }) => {
    const img = new Image()
    await new Promise((resolve, reject) => {
      img.onload = resolve
      img.onerror = () => reject(new Error('decode failed'))
      img.src = url
    })
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    return {
      data: canvas.toDataURL('image/jpeg', quality),
      w: canvas.width,
      h: canvas.height,
      fromW: img.naturalWidth,
      fromH: img.naturalHeight,
    }
  },
  { url: dataUrl, maxEdge: MAX_EDGE, quality: QUALITY },
)
await browser.close()

const file = `${args.key}.jpg`
const bytes = Buffer.from(out.data.split(',')[1], 'base64')
writeFileSync(join(HERE, file), bytes)

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { photos: [], binders: [] }
// A binder page is a different KIND of ground truth: an unordered multiset of
// the cards on the page, not one name. It lives in its own list so the
// single-card runner never tries to grade a nine-card photo as one card.
const list = args.binder ? 'binders' : 'photos'
manifest[list] = (manifest[list] ?? []).filter((p) => p.key !== args.key)
manifest[list].push({
  key: args.key,
  file,
  game: args.game,
  ...(args.binder ? { cards: String(args.cards).split('|').map((c) => c.trim()).filter(Boolean) } : { name: args.name }),
  ...(args.label ? { label: args.label } : {}),
  ...(args.note ? { note: args.note } : {}),
  source: basename(source),
})
manifest[list].sort((a, b) => (a.key < b.key ? -1 : 1))
manifest.photos ??= []
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`${file}  ${out.fromW}x${out.fromH} → ${out.w}x${out.h}  ${Math.round(bytes.length / 1024)}KB`)
