/**
 * Render composed harness frames to PNG so a human can LOOK at them.
 *
 * Lesson 25: a synthetic degradation that was never held up beside a real
 * photo will happily justify fixes for a failure that does not happen. The
 * first foil model was a full-card rainbow and looked nothing like the thing
 * it claimed to model. This is the cheap way to not repeat that.
 *
 *   node tests/harness/preview.mjs --keys=dark-magician --degradations=clean,foil-text
 *     → tests/harness/report/preview-<key>-<degradation>.png
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURES = process.env.HARNESS_FIXTURES ?? join(HERE, 'fixtures')
const OUT = join(HERE, 'report')
const PORT = Number(process.env.HARNESS_PORT ?? 5198)

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const list = (v) => (typeof v === 'string' && v.length ? v.split(',') : null)

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium'
  return undefined
}

async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${url}`)
}

const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
const keys = list(args.keys)
const degradations = list(args.degradations) ?? ['clean']
const fixtures = manifest.fixtures.filter((f) => !keys || keys.includes(f.key))
mkdirSync(OUT, { recursive: true })

const vite = spawn('node', [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
process.on('exit', () => { try { vite.kill('SIGTERM') } catch { /* gone */ } })

await waitFor(`http://127.0.0.1:${PORT}/tests/harness/page.html`)
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 1200 } })
await page.goto(`http://127.0.0.1:${PORT}/tests/harness/page.html`)
await page.waitForFunction(() => !!window.__harness)

for (const fixture of fixtures) {
  for (const degradation of degradations) {
    const dataUrl = await page.evaluate(
      (c) => window.__harness.preview(c),
      { imageUrl: `/tests/harness/fixtures/${fixture.image}`, degradation, game: fixture.game },
    )
    const file = join(OUT, `preview-${fixture.key}-${degradation}.png`)
    writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'))
    console.log(file)
  }
}
await browser.close()
vite.kill('SIGTERM')
process.exit(0)
