/**
 * Drive the REAL app's scan UI: photo upload and a binder page scan, end to
 * end, ending in a Dexie write.
 *
 * Neither path is reachable from anything else here. The matrix drives
 * `identifyFrame` directly and never renders a component; `smoke-app.mjs`
 * checks the built bundle boots but cannot scan. This is the only check that a
 * picked file reaches the pipeline, that the review screen shows what was
 * found, and that confirming it actually files the cards — the bug it was
 * written for was a z-index tie that left "Add N cards" unclickable while
 * looking perfectly correct in a screenshot.
 *
 *   node tests/harness/drive-scan-ui.mjs            # pass/fail
 *   node tests/harness/drive-scan-ui.mjs --shots=/tmp/x   # + screenshots
 *
 * Two things make it deterministic. A fake camera device (chromium's
 * --use-fake-device-for-media-stream) stands the scanner up without hardware,
 * so the top bar and Page mode are reachable. And the card APIs are answered
 * by the same captured fixtures the matrix stubs from — restricted sandboxes
 * cannot reach them, and a lookup that fails for want of a network says
 * nothing about the UI.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createStubs } from './stub-apis.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURES = process.env.HARNESS_FIXTURES ?? join(HERE, 'fixtures')
const PHOTOS = join(HERE, 'photos')
const PORT = Number(process.env.SCAN_UI_PORT ?? 5210)

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const SHOTS = typeof args.shots === 'string' ? args.shots : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

if (!existsSync(join(FIXTURES, 'manifest.json'))) {
  console.error(`No fixtures at ${FIXTURES} — see tests/harness/README or the scan-harness skill.`)
  process.exit(2)
}

const findChromium = () => process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

// `--host 127.0.0.1` for the same reason run-matrix.mjs passes it: vite binds
// the loopback NAME by default, so on a machine where `localhost` resolves to
// ::1 nothing listens on 127.0.0.1 — the literal the readiness probe and the
// route filter below are both written against — and the run dies blaming the
// dev server on a perfectly healthy checkout.
const vite = spawn('node', [join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
const stopVite = () => { try { vite.kill('SIGTERM') } catch { /* gone */ } }
process.on('exit', stopVite)

const waitFor = async (url, ms = 40_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${url}\n${viteLog.split('\n').slice(-12).join('\n')}`)
}

let browser
try {
  await waitFor(`http://127.0.0.1:${PORT}/index.html`)
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    deviceScaleFactor: 2,
    permissions: ['camera'],
  })
  const stubs = createStubs(FIXTURES)
  await ctx.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    const hit = stubs.handle(url, route.request())
    if (hit) return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body })
    return route.abort('failed')
  })

  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `scan-ui-${name}.png`) }) }

  // `welcome=0` for the reason onboarding.ts documents: a harness is a
  // first-time visitor every run, and the welcome dialog is modal — it takes
  // the taps meant for the scan screen's own controls.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&welcome=0`)
  await page.waitForSelector('.nav', { timeout: 30_000 })
  await page.evaluate(() => (location.hash = '#/scan'))
  await page.waitForTimeout(1000)
  const start = page.locator('.scan__gate .btn--primary').first()
  if (await start.count()) await start.click().catch(() => {})
  await page.waitForTimeout(3500)
  await shot('1-live')

  console.log('\nUpload — one card')
  const upload = page.locator('button[aria-label="Scan a photo from your library"]')
  check(await upload.count() === 1, 'upload control is on the scan screen')
  await page.setInputFiles('input[type=file]', join(PHOTOS, 'ygo-duel-tower-prismatic.jpg'))
  await page.waitForSelector('.sheet, .toast', { timeout: 120_000 }).catch(() => {})
  await page.waitForTimeout(1500)
  await shot('2-upload')
  const sheetName = (await page.locator('.sheet h1, .sheet h2, .sheet__title').first().textContent().catch(() => ''))?.trim()
  check(sheetName === 'Duel Tower', 'a picked photo identifies and opens the card sheet', `sheet said ${JSON.stringify(sheetName)}`)
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(800)

  console.log('\nPage mode — a binder page')
  // Page is not its own pill any more: the three mode pills collapsed into one
  // "Modes" button opening a sheet of switches (`components/ScanModes.tsx`).
  const modes = page.locator('button[aria-label^="Scan modes"]')
  check(await modes.count() === 1, 'the Modes pill is on the scan screen')
  await modes.click()
  const pageSwitch = page.locator('.moderow button[role="switch"][aria-label="Page"]')
  check(await pageSwitch.count() === 1, 'Page is one of the scan modes')
  await pageSwitch.click()
  await page.waitForTimeout(400)
  // The sheet stays up over the scan screen; close it before picking a photo.
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(500)
  await page.setInputFiles('input[type=file]', join(PHOTOS, 'ygo-binder-horus.jpg'))
  check(await page.waitForSelector('.pagescan', { timeout: 30_000 }).then(() => true).catch(() => false), 'a progress overlay appears while the page is read')
  await shot('3-progress')
  await page.waitForSelector('.binder', { timeout: 240_000 })
  await page.waitForTimeout(600)
  await shot('4-review')

  const rows = await page.locator('.binderrow').count()
  const ticked = await page.locator('.binderrow--on').count()
  const identified = await page.locator('.binderrow__name:not(.binderrow__name--miss)').count()
  console.log(`    ${rows} rows · ${identified} identified · ${ticked} pre-ticked`)
  check(rows >= 6, 'the review screen lists what was found', `${rows} rows`)
  check(identified >= 4, 'most of the page identified', `${identified} of ${rows}`)
  // The whole point of the screen: nothing is filed without a confirmation,
  // and a row the pipeline was not sure about does not arrive ticked.
  check(ticked > 0 && ticked <= identified, 'only identified rows are pre-ticked', `${ticked} ticked`)

  const before = await page.evaluate(async () => (await import('/src/lib/db.ts')).db.collection.count())
  check(before === 0, 'nothing was filed before the confirmation', `${before} rows in the collection`)

  /* --- page after page: one binder, one review ---------------------------- */

  // A binder is not one page. "Next page" parks the review behind the camera
  // and the next page appends to it — the ticks already made, and the binder
  // already chosen, have to survive the trip.
  console.log('\nA second page, into a named binder')
  await page.locator('.binder__foot .btn--ghost').click()
  await page.waitForTimeout(600)
  check(await page.locator('.binder--parked').count() === 1, 'the review parks rather than closing')
  check(await page.locator('.pageresume').isVisible(), 'a resume bar offers the way back to it')
  await shot('5-parked')

  await page.setInputFiles('input[type=file]', join(PHOTOS, 'ygo-binder-horus.jpg'))
  await page.waitForSelector('.pagescan', { timeout: 30_000 }).catch(() => {})
  await page.waitForSelector('.binder:not(.binder--parked)', { timeout: 240_000 })
  await page.waitForTimeout(600)
  const rows2 = await page.locator('.binderrow').count()
  const ticked2 = await page.locator('.binderrow--on').count()
  check(rows2 > rows, 'the second page appends to the same review', `${rows} → ${rows2} rows`)
  check(ticked2 >= ticked, 'the first page’s ticks survived the trip', `${ticked} → ${ticked2} ticked`)
  check(await page.locator('.binder__pagehead').count() === 2, 'the rows are grouped by page')
  await shot('6-twopages')

  // Name the binder here, on the review screen — the whole session files into
  // it, and that is what a printed label points at afterwards.
  await page.selectOption('.binderpick select', 'new')
  await page.fill('.binderpick input', 'Shelf A')
  await page.waitForTimeout(200)

  const cta = page.locator('.binder__foot .btn--primary')
  const ctaText = (await cta.textContent())?.trim()
  check(await cta.isEnabled(), 'the confirm button is enabled', ctaText)
  await cta.click({ timeout: 15_000 })
  await page.waitForTimeout(3000)
  await shot('7-added')
  // Copies, not rows: the second page here is the SAME photograph, so each card
  // is filed twice into one row at qty 2 — the same merge an ordinary re-scan
  // does. What must hold is that every ticked row became a copy in the
  // collection and none of them arrived twice over.
  const copies = await page.evaluate(async () => {
    const { db } = await import('/src/lib/db.ts')
    return (await db.collection.toArray()).reduce((sum, row) => sum + row.qty, 0)
  })
  check(copies === ticked2, 'confirming files exactly the ticked cards', `${copies} copies, ${ticked2} ticked`)
  check(await page.locator('.binder').count() === 0, 'the review screen closes after adding')

  // The point of the whole session: every card knows which binder — and which
  // page of it — it came off.
  const filing = await page.evaluate(async () => {
    const { db } = await import('/src/lib/db.ts')
    const binders = await db.binders.toArray()
    const rows = await db.collection.toArray()
    return {
      binders: binders.map((b) => b.name),
      filed: rows.filter((r) => r.binderId === binders[0]?.id).length,
      pages: [...new Set(rows.map((r) => r.binderPage))].sort(),
      total: rows.length,
    }
  })
  check(filing.binders.length === 1 && filing.binders[0] === 'Shelf A', 'the binder named on the review screen exists', filing.binders.join(', '))
  check(filing.filed === filing.total, 'every filed card points at it', `${filing.filed}/${filing.total}`)
  // Every row knows a page, and re-reading a card that is already filed keeps
  // the page it was first seen on rather than overwriting it — the same
  // photograph twice must not move a card to page 2 of the binder.
  check(
    filing.pages.length === 1 && filing.pages[0] === 1,
    'and carries the page it was read from',
    `pages ${filing.pages.join(', ')}`,
  )

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3).join(' | '))
} catch (err) {
  console.error('\n' + String(err))
  failures.push(String(err).slice(0, 200))
} finally {
  await browser?.close().catch(() => {})
  stopVite()
}

console.log(failures.length ? `\nSCAN UI FAILED — ${failures.length}: ${failures.join('; ')}` : '\nSCAN UI OK — upload identifies, a page reviews, confirming files exactly what was ticked.')
process.exit(failures.length ? 1 : 0)
