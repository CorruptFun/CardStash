/**
 * Drive the REAL batch-add screen: the scan tray, its Review button, ticking,
 * dropping a row, and the confirm that writes to Dexie.
 *
 *   node tests/harness/batch-add-ui.mjs               # pass/fail
 *   node tests/harness/batch-add-ui.mjs --shots=/tmp/x  # + screenshots
 *
 * No fixtures and no camera. What this checks starts AFTER identification —
 * the tray is seeded straight into IndexedDB from the demo collection's own
 * cards, so every row is a real `Card` the app can price and render, and a run
 * says nothing about (and cannot be broken by) the scan pipeline. External
 * requests are aborted so a sandbox without network reads the same as one with.
 *
 * The invariant worth the harness: what the screen shows and what gets filed
 * are the same set, in both directions. A row the user unticked must not land,
 * and a row already filed by Collect mode must not arrive ticked a second
 * time — silently double-filing a collection is the one failure here nobody
 * would notice until the totals were wrong.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PORT = Number(process.env.BATCH_UI_PORT ?? 5212)

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const SHOTS = typeof args.shots === 'string' ? args.shots : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

// `--host 127.0.0.1` for the reason the other harnesses carry it: vite binds
// the loopback NAME by default, so where `localhost` resolves to ::1 nothing
// listens on the literal this file is written against.
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

/** Read the whole of a Dexie table over raw IndexedDB (no app import needed). */
const readAll = (page, store) =>
  page.evaluate(async (name) => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('cardstock')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    return await new Promise((res, rej) => {
      const req = db.transaction(name, 'readonly').objectStore(name).getAll()
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
  }, store)

let browser
try {
  await waitFor(`http://127.0.0.1:${PORT}/index.html`)
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2, permissions: ['camera'] })
  await ctx.route('**/*', (route) => {
    const url = route.request().url()
    const local = url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:')
    return local ? route.continue() : route.abort('failed')
  })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `batch-${name}.png`) }) }

  // `welcome=0` because a harness is a first-time visitor every run and the
  // welcome dialog is modal — see onboarding.ts.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?demo=1&welcome=0&nosw=1`)
  await page.waitForSelector('.nav', { timeout: 30_000 })
  await page.waitForTimeout(2500)

  // Five scans, oldest first. The OLDEST carries a detected foil (it survives
  // the ticking below, and must be filed as foil rather than as the printing's
  // default), and the NEWEST is already filed — Collect mode's state, and the
  // row this screen must not re-offer.
  const seeded = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open('cardstock')
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    const all = (store) =>
      new Promise((res, rej) => {
        const req = db.transaction(store, 'readonly').objectStore(store).getAll()
        req.onsuccess = () => res(req.result)
        req.onerror = () => rej(req.error)
      })
    const cards = []
    const seen = new Set()
    for (const item of await all('collection')) {
      if (!seen.has(item.card.id)) {
        seen.add(item.card.id)
        cards.push(item.card)
      }
      if (cards.length === 5) break
    }
    const tx = db.transaction('scans', 'readwrite')
    const store = tx.objectStore('scans')
    cards.forEach((card, i) => {
      store.put({
        id: `seed-${i}`,
        cardId: card.id,
        at: Date.now() - (cards.length - i) * 1000,
        card,
        finish: i === 0 ? 'foil' : undefined,
        added: i === 4 ? true : undefined,
      })
    })
    await new Promise((res, rej) => {
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
    return {
      count: cards.length,
      foilId: cards[0].id,
      qty: (await all('collection')).reduce((n, it) => n + it.qty, 0),
      foilQty: (await all('collection'))
        .filter((it) => it.cardId === cards[0].id && it.finish === 'foil')
        .reduce((n, it) => n + it.qty, 0),
    }
  })
  check(seeded.count === 5, 'demo data gave us five cards to scan', `${seeded.count}`)

  await page.goto(`http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/scan`)
  await page.waitForSelector('.nav', { timeout: 30_000 })
  await page.waitForTimeout(2000)

  console.log('\nThe tray')
  check((await page.locator('.tray__item').count()) === 5, 'every scan is a tile')
  const review = page.locator('.tray__clear--go')
  // Pinned OUTSIDE the scroller: inside it, a full tray pushes the button off
  // the right edge behind the fade, reachable only by swiping past every tile.
  check(await review.isVisible(), 'the Review button is visible without scrolling the strip')
  check((await review.textContent())?.includes('5'), 'it counts the whole tray', (await review.textContent())?.trim())
  await shot('1-tray')

  console.log('\nThe batch screen')
  await review.click()
  await page.waitForSelector('.batchrow', { timeout: 15_000 })
  await page.waitForTimeout(500)
  check((await page.locator('.batchrow').count()) === 5, 'every scan has a row')
  check((await page.locator('.batchrow.binderrow--on').count()) === 4, 'rows arrive ticked — except the one already filed')
  check((await page.locator('.batchrow--filed').count()) === 1, 'the filed row says so')
  const sum = () => page.locator('.binder__sum strong').textContent()
  check((await sum()) === '4 selected', 'the footer counts the selection')
  await shot('2-review')

  // Row 0 is the newest scan — the already-filed one. Ticking it opts a second
  // copy in; unticking row 1 takes one back out. Both must move the footer.
  await page.locator('.batchrow .binderrow__tick').first().click()
  await page.waitForTimeout(150)
  check((await sum()) === '5 selected', 'ticking a filed row opts a second copy in', await sum())
  await page.locator('.batchrow .binderrow__tick').nth(1).click()
  await page.waitForTimeout(150)
  check((await sum()) === '4 selected', 'unticking takes a row back out', await sum())

  // The × is the tray's own remove: it forgets the scan, it never files.
  await page.locator('.batchrow .binderrow__retry').nth(1).click()
  await page.waitForTimeout(500)
  check((await page.locator('.batchrow').count()) === 4, 'the × drops the row')
  check((await sum()) === '4 selected', 'dropping an unticked row leaves the selection alone', await sum())

  console.log('\nThe confirm')
  const cta = page.locator('.binder__foot .btn')
  check((await cta.textContent())?.trim() === 'Add 4 cards', 'the button names what will be filed', (await cta.textContent())?.trim())
  await cta.click({ timeout: 15_000 })
  await page.waitForTimeout(2000)
  check((await page.locator('.binder').count()) === 0, 'the screen closes on confirm')
  await shot('3-added')

  const scans = await readAll(page, 'scans')
  const collection = await readAll(page, 'collection')
  const qty = collection.reduce((n, it) => n + it.qty, 0)
  check(qty === seeded.qty + 4, 'exactly the ticked copies were filed', `${seeded.qty} → ${qty}`)
  check(scans.length === 4, 'the tray keeps the log', `${scans.length} rows`)
  check(scans.every((s) => s.added), 'every filed row is marked added')
  const foilQty = collection
    .filter((it) => it.cardId === seeded.foilId && it.finish === 'foil')
    .reduce((n, it) => n + it.qty, 0)
  check(foilQty === seeded.foilQty + 1, 'the scanned foil was filed as foil, not as the printing default', `${seeded.foilQty} → ${foilQty}`)

  // Re-opening must not offer the same copies again — the double-file guard.
  await page.locator('.tray__clear--go').click()
  await page.waitForSelector('.batchrow', { timeout: 15_000 })
  await page.waitForTimeout(400)
  check((await page.locator('.batchrow.binderrow--on').count()) === 0, 're-opening offers nothing that was just filed')
  await shot('4-reopen')

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3).join(' | '))
} catch (err) {
  console.error('\n' + String(err))
  failures.push(String(err).slice(0, 200))
} finally {
  await browser?.close().catch(() => {})
  stopVite()
}

console.log(failures.length ? `\nBATCH ADD FAILED — ${failures.length}: ${failures.join('; ')}` : '\nBATCH ADD OK — the tray reviews, ticks hold, and confirming files exactly what was ticked.')
process.exit(failures.length ? 1 : 0)
