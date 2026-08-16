/**
 * Drive the REAL binder screens: filing cards from the collection, the binder
 * list, the printed label, the link a printed QR carries, and the delete that
 * must keep every card.
 *
 *   node tests/harness/binder-ui.mjs                  # pass/fail
 *   node tests/harness/binder-ui.mjs --shots=/tmp/x   # + screenshots
 *
 * No camera and no fixtures: the cards come from the demo collection, so a run
 * says nothing about (and cannot be broken by) the scan pipeline. External
 * requests are aborted so a sandbox without network reads the same as one with.
 *
 * The invariants worth a harness, all of which are about a label outliving the
 * session that made it:
 *
 *   - filing writes `binderCards` rows pointing at the collection rows;
 *   - the label carries a link that this app's own router resolves back to
 *     that binder — the thing that is glued to a shelf and cannot be reissued;
 *   - deleting a binder DELETES NO CARDS.
 *
 * `tests/unit/qr.test.mjs` proves the symbol decodes; this proves the screen
 * around it is wired to the right binder.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PORT = Number(process.env.BINDER_UI_PORT ?? 5216)

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
const vite = spawn(
  'node',
  [join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
)
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
const stopVite = () => {
  try {
    vite.kill('SIGTERM')
  } catch {
    /* gone */
  }
}
process.on('exit', stopVite)

const waitFor = async (url, ms = 40_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up */
    }
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
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 })
  await ctx.route('**/*', (route) => {
    const url = route.request().url()
    const local = url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:')
    return local ? route.continue() : route.abort('failed')
  })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))
  const shot = async (name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `binder-${name}.png`) })
  }

  // `welcome=0` because a harness is a first-time visitor every run and the
  // welcome dialog is modal — see onboarding.ts.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?demo=1&welcome=0&nosw=1`)
  await page.waitForSelector('.nav', { timeout: 30_000 })
  await page.waitForTimeout(2000)

  /* --- file two rows from the collection ---------------------------------- */

  await page.goto(`http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/collection`)
  await page.waitForSelector('.cardcell', { timeout: 20_000 })
  await page.click('.colltools .btn:has-text("Edit")')
  const cells = page.locator('.cardcell')
  await cells.nth(0).click()
  await cells.nth(1).click()
  await page.click('.bulkbar .btn:has-text("Binder")')
  await page.waitForSelector('.modal', { timeout: 5000 })
  await shot('picker')
  await page.fill('.modal .addfriend input.input', 'Rares')
  await page.click('.modal .addfriend .btn')
  await page.waitForTimeout(800)

  const binders = await readAll(page, 'binders')
  check(binders.length === 1, 'creating a binder writes one row', JSON.stringify(binders.map((b) => b.name)))
  const binder = binders[0]
  check(binder?.visibility === 'private', 'and it starts private, whatever made it', binder?.visibility)
  const cards = await readAll(page, 'binderCards')
  const items = new Set((await readAll(page, 'collection')).map((row) => row.id))
  check(cards.length === 2, 'both selected rows are filed in it', `${cards.length} filed`)
  check(
    cards.every((row) => row.binderId === binder?.id && items.has(row.itemId)),
    'and every binder row points at a collection row it owns',
  )

  /* --- the binder screen --------------------------------------------------- */

  await page.goto(`http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/binders`)
  await page.waitForSelector('.social-row', { timeout: 10_000 })
  const listText = await page.locator('.social-row').first().innerText()
  check(listText.includes('Rares'), 'the binder is listed by name', listText.replace(/\n/g, ' · '))
  await page.click('.social-row')
  await page.waitForSelector('.bindercell', { timeout: 10_000 })
  const shown = await page.locator('.bindercell').count()
  check(shown === 2, 'the binder screen lists the cards filed in it', `${shown} on screen`)
  await shot('detail')

  /* --- the printed label --------------------------------------------------- */

  await page.click('.friendacts .btn:has-text("Print label")')
  await page.waitForSelector('.labelsheet', { timeout: 5000 })
  const pathLength = await page.locator('.labelsheet__qr path').getAttribute('d').then((d) => d?.length ?? 0)
  check(pathLength > 200, 'the label draws a real QR symbol', `${pathLength} chars of path`)
  const code = (await page.locator('.labelsheet__code').innerText()).trim()
  check(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), 'the fallback code is printed under it', code)
  check(
    binder.id.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().startsWith(code.replace('-', '').toLowerCase()),
    'and it fingerprints this binder’s id',
    `${code} vs ${binder.id}`,
  )
  await shot('label')

  /* --- the link a scanned label opens -------------------------------------- */

  await page.goto(`http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/binders/${binder.id}`)
  await page.waitForSelector('.friendhead h1', { timeout: 10_000 })
  const title = await page.locator('.friendhead h1').innerText()
  check(title.trim() === 'Rares', 'the label’s own link opens that binder', title)

  // A code from another install — the case a stranger's sticker, or a binder
  // deleted long ago, produces. It must explain itself, not render blank.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/binders/zzzzzzzzzz`)
  await page.waitForSelector('.empty', { timeout: 10_000 })
  const missing = await page.locator('.empty').innerText()
  check(/No such binder/i.test(missing), 'an unknown code says so', missing.split('\n')[0])

  /* --- deleting the label keeps every card --------------------------------- */

  await page.goto(`http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/binders/${binder.id}`)
  await page.waitForSelector('.bindercell', { timeout: 10_000 })
  const before = (await readAll(page, 'collection')).length
  await page.click('.friendacts .btn:has-text("Delete")')
  await page.waitForSelector('.modal', { timeout: 5000 })
  await page.click('.modal .btn--danger')
  await page.waitForTimeout(900)
  const after = await readAll(page, 'collection')
  check(after.length === before, 'deleting a binder deletes no cards', `${before} → ${after.length}`)
  check((await readAll(page, 'binderCards')).length === 0, 'its rows go with it')
  check((await readAll(page, 'binders')).length === 0, 'and so does the label')

  check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '))
} catch (err) {
  check(false, 'harness ran', String(err).slice(0, 300))
} finally {
  await browser?.close()
  stopVite()
}

console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nAll binder UI checks passed')
process.exit(failures.length ? 1 : 0)
