/**
 * Verifies the install banner's real behaviour in the built bundle: it must
 * appear for a user with a real collection, on both the Chromium and iOS
 * routes, and must stay hidden in every case where it would be noise.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright-core'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.INSTALL_PORT ?? 5271)

if (!existsSync(join(REPO, 'dist', 'index.html'))) {
  console.error('No dist/ — run `npm run build` first.')
  process.exit(2)
}
// --host 127.0.0.1: vite's default binds the loopback *name*, which resolves
// to ::1 on some machines, and the probe below then times out against
// 127.0.0.1 and reports the server never started. Same fix as its siblings.
const server = spawn('node', [join(REPO, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' })
process.on('exit', () => { try { server.kill('SIGTERM') } catch {} })

const until = Date.now() + 20000
let up = false
while (Date.now() < until && !up) {
  up = await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.ok).catch(() => false)
  if (!up) await new Promise(r => setTimeout(r, 250))
}
if (!up) { console.error('preview never came up'); process.exit(1) }

const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const results = []
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }

// Chromium fires beforeinstallprompt off engagement heuristics that headless
// never satisfies, so replay a faithful synthetic one: preventDefault-able,
// with the prompt()/userChoice pair the component consumes.
const FIRE_BIP = `(() => {
  const e = new Event('beforeinstallprompt', { cancelable: true });
  e.prompt = async () => { window.__promptCalled = true };
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  window.dispatchEvent(e);
})()`

async function seeded(ctx, { ios = false } = {}) {
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e)))
  page.on('console', m => {
    const t = m.text()
    if (m.type() === 'error' && !/Failed to load resource|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|net::/.test(t)) errs.push(t)
  })
  await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&demo=1#/collection`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  if (!ios) await page.evaluate(FIRE_BIP)
  await page.waitForTimeout(500)
  return { page, errs }
}

// 1. Chromium, real collection, install event available -> banner + Install.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const { page, errs } = await seeded(ctx)
  const cards = await page.evaluate(async () => {
    const db = await new Promise(res => { const r = indexedDB.open('cardstock'); r.onsuccess = () => res(r.result) })
    return await new Promise(res => { const t = db.transaction('collection').objectStore('collection').count(); t.onsuccess = () => res(t.result) })
  }).catch(() => -1)
  const shown = await page.locator('.installtip').isVisible().catch(() => false)
  const hasInstall = await page.locator('.installtip__go').isVisible().catch(() => false)
  check('chromium: banner shows for a seeded collection', shown, `${cards} rows in collection`)
  check('chromium: offers a real Install button', hasInstall)
  check('chromium: says the collection carries over', /carries over/i.test(await page.locator('.installtip').innerText().catch(() => '')))
  check('chromium: no console errors', errs.length === 0, errs.join(' | '))

  // Install must invoke the stashed event, not navigate anywhere.
  if (hasInstall) {
    await page.locator('.installtip__go').click()
    await page.waitForTimeout(400)
    check('chromium: Install calls the stashed prompt()', await page.evaluate(() => window.__promptCalled === true))
    check('chromium: banner clears after accepting', !(await page.locator('.installtip').isVisible().catch(() => false)))
  }
  await ctx.close()
}

// 2. iOS: no event ever fires, so the Share instructions are the whole path.
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true })
  const { page, errs } = await seeded(ctx, { ios: true })
  const shown = await page.locator('.installtip').isVisible().catch(() => false)
  const body = await page.locator('.installtip').innerText().catch(() => '')
  check('ios: banner shows with no beforeinstallprompt', shown)
  check('ios: gives Share -> Add to Home Screen steps', /Add to Home Screen/.test(body) && /Share/.test(body))
  // The load-bearing one: a Home Screen web app gets storage partitioned away
  // from Safari, so prompting to install WITHOUT warning strands the very
  // collection the banner exists to protect.
  check('ios: warns the installed app starts empty', /starts empty/i.test(body))
  check('ios: says storage is separate from Safari', /separate storage/i.test(body))
  // Which route back it names depends on the bundle — "Collection → Import"
  // without Drive, "Settings → Restore from Drive" with it. Assert that it
  // names one, not which: this harness runs against both builds.
  check('ios: tells them how to get the backup back after installing', /Import|Restore from Drive/i.test(body), body.slice(0, 120))
  // The primary iOS action must be a BACKUP, never the install — the exact
  // label depends on whether Drive is configured ("Back up to Drive" vs
  // "Save a file"), so assert the intent, not the wording.
  const primary = await page.locator('.installtip__go').first().innerText().catch(() => '')
  check('ios: offers a backup as the primary action, not the install', /back up|save a file|save backup/i.test(primary), primary)
  check('ios: no console errors', errs.length === 0, errs.join(' | '))

  // The backup must actually produce a file — the whole iOS flow depends on it.
  const pending = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  // Target the file route explicitly: the Drive button, when configured, sits
  // in the same primary slot but uploads instead of downloading.
  await page.getByRole('button', { name: /save a file|save backup|save again/i }).first().click()
  const dl = await pending
  const name = dl ? dl.suggestedFilename() : ''
  check('ios: Save backup downloads a real backup file', /^cardstock-backup-.*\.json$/.test(name), name || 'no download fired')
  check('ios: banner stays up after saving (install is step two)', await page.locator('.installtip').isVisible().catch(() => false))

  // By label, never by class: `installtip__dismiss` is secondary *styling*, not
  // the dismiss action. With Drive configured the file-backup button moves into
  // that same class and the selector matches two nodes.
  await page.getByRole('button', { name: /^(Done|Not now)$/ }).click()
  await page.waitForTimeout(300)
  check('ios: dismiss hides it', !(await page.locator('.installtip').isVisible().catch(() => false)))
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(1500)
  check('ios: dismissal survives a reload', !(await page.locator('.installtip').isVisible().catch(() => false)))
  await ctx.close()
}

// 3. Empty collection: nothing to protect yet, so stay quiet.
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${PORT}/?nosw=1#/collection`, { waitUntil: 'load' })
  await page.waitForTimeout(1500)
  check('below the threshold: no banner', !(await page.locator('.installtip').isVisible().catch(() => false)))
  await ctx.close()
}

// 4. Already installed: display-mode standalone must suppress it entirely.
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()
  await page.emulateMedia({ media: 'screen', reducedMotion: null, forcedColors: null })
  await page.addInitScript(() => {
    const mm = window.matchMedia.bind(window)
    window.matchMedia = q => (q.includes('standalone') ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : mm(q))
  })
  await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&demo=1#/collection`, { waitUntil: 'load' })
  await page.waitForTimeout(2500)
  check('installed (standalone): no banner', !(await page.locator('.installtip').isVisible().catch(() => false)))
  await ctx.close()
}

// 5. The camera view must stay unobstructed.
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${PORT}/?nosw=1&demo=1#/scan`, { waitUntil: 'load' })
  await page.waitForTimeout(2000)
  check('scan view: banner never covers the camera', !(await page.locator('.installtip').isVisible().catch(() => false)))
  await ctx.close()
}

await browser.close()
const failed = results.filter(r => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
