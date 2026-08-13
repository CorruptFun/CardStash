/**
 * Built-app smoke: serve dist/ and drive the real bundle headless — the scan
 * gate must render, tabs must navigate, Settings must show the version, and
 * the console must stay clean. Catches wiring the type checker can't (JSX
 * structure, store subscriptions, dead imports) in the artifact users get.
 *
 *   npm run build && node tests/harness/smoke-app.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.SMOKE_PORT ?? 5198)

if (!existsSync(join(REPO, 'dist', 'index.html'))) {
  console.error('No dist/ — run `npm run build` first.')
  process.exit(2)
}

const server = spawn('node', [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
process.on('exit', () => {
  try {
    server.kill('SIGTERM')
  } catch { /* gone */ }
})

const until = Date.now() + 20_000
let up = false
while (Date.now() < until && !up) {
  up = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.ok).catch(() => false)
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('preview server never came up')
  process.exit(1)
}

const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', (err) => errors.push(String(err)))
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})

const fail = async (what) => {
  console.error(`SMOKE FAIL: ${what}`)
  if (errors.length) console.error('console/page errors:\n  ' + errors.join('\n  '))
  await browser.close()
  process.exit(1)
}

// ?nosw=1: the service worker must not install from a preview run.
await page.goto(`http://127.0.0.1:${PORT}/?nosw=1#/scan`, { waitUntil: 'load' })
await page.waitForTimeout(600)

if (!(await page.getByText('Start scanning').isVisible().catch(() => false))) await fail('scan start gate did not render')
if ((await page.locator('.shutter').count()) !== 0) await fail('a shutter button is still in the DOM')

await page.goto(`http://127.0.0.1:${PORT}/?nosw=1#/settings`, { waitUntil: 'load' })
await page.waitForTimeout(400)
const pkg = (await import(`file://${join(REPO, 'package.json')}`, { with: { type: 'json' } })).default
if (!(await page.getByText(`v${pkg.version}`).isVisible().catch(() => false))) await fail(`Settings does not show v${pkg.version}`)

await page.goto(`http://127.0.0.1:${PORT}/?nosw=1#/search`, { waitUntil: 'load' })
await page.waitForTimeout(300)
if ((await page.locator('input').count()) === 0) await fail('search screen did not render an input')

const fatal = errors.filter((e) => !/favicon|manifest|Failed to load resource/i.test(e))
if (fatal.length) await fail('console errors during smoke')

console.log(`SMOKE OK — gate, no shutter, v${pkg.version} in Settings, search renders, console clean.`)
await browser.close()
process.exit(0)
