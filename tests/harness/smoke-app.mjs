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

// --host 127.0.0.1 is not optional: vite's default binds the loopback *name*,
// and on a machine where `localhost` resolves to ::1 the readiness probe below
// then fails against 127.0.0.1 and blames the dev server for never starting.
// Same fix run-matrix.mjs and install-prompt.mjs already carry.
const server = spawn('node', [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
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

/*
 * First run gates on an account, so check BOTH sides before anything else:
 * the welcome must appear for a fresh visitor, and `?welcome=0` must get past
 * it. Every assertion below this point rides on that flag, so if the escape
 * ever stops working the whole file fails with a misleading error instead of
 * this one.
 */
await page.goto(`http://127.0.0.1:${PORT}/?nosw=1#/scan`, { waitUntil: 'load' })
await page.waitForTimeout(600)
if (!(await page.getByText('Connect an account').isVisible().catch(() => false))) {
  await fail('first run did not show the welcome screen')
}
if (!(await page.getByText('Skip for now').isVisible().catch(() => false))) {
  await fail('welcome screen offered no way past it')
}

// ?nosw=1: the service worker must not install from a preview run.
// ?welcome=0: skip first-run onboarding (harness escape, see lib/onboarding.ts).
await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&welcome=0#/scan`, { waitUntil: 'load' })
await page.waitForTimeout(600)
if (await page.getByText('Connect an account').isVisible().catch(() => false)) {
  await fail('?welcome=0 did not skip the welcome screen')
}

if (!(await page.getByText('Start scanning').isVisible().catch(() => false))) await fail('scan start gate did not render')
if ((await page.locator('.shutter').count()) !== 0) await fail('a shutter button is still in the DOM')

await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&welcome=0#/settings`, { waitUntil: 'load' })
await page.waitForTimeout(400)
const pkg = (await import(`file://${join(REPO, 'package.json')}`, { with: { type: 'json' } })).default
if (!(await page.getByText(`v${pkg.version}`).isVisible().catch(() => false))) await fail(`Settings does not show v${pkg.version}`)

await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&welcome=0#/search`, { waitUntil: 'load' })
await page.waitForTimeout(300)
if ((await page.locator('input').count()) === 0) await fail('search screen did not render an input')

/*
 * Scan tray: a misidentified card lands there looking as certain as a good
 * one, so removing it has to work. Seeded straight into Dexie because the
 * headless browser has no camera to scan with.
 */
await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&welcome=0#/scan`, { waitUntil: 'load' })
await page.waitForTimeout(600)
const seeded = await page.evaluate(async () => {
  const open = () => new Promise((res) => {
    const req = indexedDB.open('cardstock')
    req.onsuccess = () => res(req.result)
    req.onerror = () => res(null)
  })
  let handle = null
  for (let i = 0; i < 40 && !handle?.objectStoreNames?.contains('scans'); i++) {
    handle?.close()
    handle = await open()
    if (!handle?.objectStoreNames.contains('scans')) await new Promise((r) => setTimeout(r, 250))
  }
  if (!handle?.objectStoreNames.contains('scans')) return 0
  const tx = handle.transaction('scans', 'readwrite')
  const store = tx.objectStore('scans')
  const rows = [
    ['pokemon:smoke-1', 'pokemon', 'Geodude', 'SVP'],
    ['yugioh:smoke-2', 'yugioh', 'Flock Together', 'PHM'],
  ]
  let at = Date.now() - 2000
  for (const [id, game, name, setCode] of rows)
    store.put({ id: `s-${id}`, cardId: id, at: (at += 1000), card: { id, game, apiId: id, name, setCode, prices: { best: 0.1, entries: [] }, links: {} } })
  await new Promise((res) => { tx.oncomplete = res; tx.onerror = res })
  handle.close()
  return rows.length
})
if (seeded !== 2) await fail('could not seed the scan tray')
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(1200)
const tiles = () => page.locator('.tray__item').count()
if ((await tiles()) !== 2) await fail(`scan tray rendered ${await tiles()} tiles, expected 2`)
if ((await page.locator('.tray__remove').count()) !== 2) await fail('scan tray tiles have no remove button')
// dispatchEvent, not click: with no camera the start gate stays up over the
// tray, and this is about the handler, not the overlay's z-order.
await page.locator('.tray__remove').first().dispatchEvent('click')
await page.waitForTimeout(800)
if ((await tiles()) !== 1) await fail(`remove left ${await tiles()} tiles, expected 1`)
const undo = page.getByRole('button', { name: /undo/i }).first()
if (!(await undo.count())) await fail('removing a scan offered no undo')
await undo.dispatchEvent('click')
await page.waitForTimeout(800)
if ((await tiles()) !== 2) await fail(`undo restored ${await tiles()} tiles, expected 2`)

const fatal = errors.filter((e) => !/favicon|manifest|Failed to load resource/i.test(e))
if (fatal.length) await fail('console errors during smoke')

console.log(`SMOKE OK — gate, no shutter, v${pkg.version} in Settings, search renders, scan tray removes + undoes, console clean.`)
await browser.close()
process.exit(0)
