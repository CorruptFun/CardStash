/**
 * Verifies the install banner's real behaviour in the built bundle: it must
 * appear for a user with a real collection, on both the Chromium and iOS
 * routes, and must stay hidden in every case where it would be noise.
 *
 * Runs against whatever `dist/` holds, and two different bundles ship from
 * this tree. With VITE_GOOGLE_CLIENT_ID set — CI's deploy build, and what a
 * local .env.local usually gives you — the banner offers a Drive backup as
 * the primary iOS action and rewrites the restore step to match; without it
 * the downloaded file is the only backup there is. The iOS section reads
 * which one it is off the banner and asserts the matching copy and actions,
 * so both configurations are covered and neither is the "wrong" build.
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
// --host 127.0.0.1: on a machine where `localhost` resolves to ::1, vite's
// default bind leaves the v4 probe below (and the browser) knocking on a
// closed door, and the harness blames the server for never coming up.
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
const summarise = () => {
  const failed = results.filter(r => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

// A harness that dies mid-run prints no tally, which reads like a harness that
// was never run — and the thing most likely to kill it is a locator that
// matches two nodes because the bundle under test isn't the one the assertion
// was written against. That is a finding about the UI, so report it as a
// failure and still print the tally.
for (const fatal of ['uncaughtException', 'unhandledRejection']) {
  process.on(fatal, err => {
    check('harness ran to completion', false, String(err?.message ?? err).split('\n')[0])
    summarise()
  })
}

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

  // Which bundle is this? Every button below is addressed by what it says
  // rather than by its class, because Drive reshuffles the classes: the file
  // backup is `.installtip__go` on its own and `.installtip__dismiss` once
  // Drive outranks it, so a class selector either points at the wrong button
  // or matches two of them and takes the run down with it.
  const banner = page.locator('.installtip')
  const driveButton = banner.getByRole('button', { name: /Back up (to Drive|again)/i })
  const fileButton = banner.getByRole('button', { name: /Save (a file|again)/i })
  const dismissButton = banner.getByRole('button', { name: /^(Not now|Done)$/i })
  const drive = (await driveButton.count().catch(() => 0)) > 0
  const build = drive ? 'Drive build (VITE_GOOGLE_CLIENT_ID set)' : 'file-only build (no VITE_GOOGLE_CLIENT_ID)'
  console.log(`      · dist/ under test: ${build}`)

  check('ios: banner shows with no beforeinstallprompt', shown)
  check('ios: gives Share -> Add to Home Screen steps', /Add to Home Screen/.test(body) && /Share/.test(body))
  // The load-bearing one: a Home Screen web app gets storage partitioned away
  // from Safari, so prompting to install WITHOUT warning strands the very
  // collection the banner exists to protect.
  check('ios: warns the installed app starts empty', /starts empty/i.test(body))
  check('ios: says storage is separate from Safari', /separate storage/i.test(body))
  // The last step has to name the route this build actually has. Sending a
  // Drive user to import a file nobody told them to save is the same dead end
  // as sending a file user to a Drive restore that isn't in their Settings.
  check('ios: names the restore step this build can deliver', drive ? /Restore from Drive/i.test(body) : /Import/.test(body), build)
  // The primary action is a backup in both builds — which backup differs, that
  // it outranks the install does not.
  const primary = await page.locator('.installtip__go').innerText().catch(() => '')
  check('ios: offers the backup as the primary action', drive ? /Back up to Drive/i.test(primary) : /Save a file/i.test(primary), primary || 'no primary action')
  // Drive must never be the only way out: someone who won't sign in to Google
  // still needs a backup, and the file is the one that needs no account.
  check('ios: keeps the account-free file backup on offer', await fileButton.isVisible().catch(() => false))
  check('ios: no console errors', errs.length === 0, errs.join(' | '))

  // The backup must actually produce a file — the whole iOS flow depends on
  // it. Deliberately the file button and never the Drive one: clicking Drive
  // injects Google's script and opens a real OAuth flow, which is neither
  // this harness's business nor something a dummy client id can finish.
  const pending = page.waitForEvent('download', { timeout: 10000 }).catch(() => null)
  await fileButton.click()
  const dl = await pending
  const name = dl ? dl.suggestedFilename() : ''
  check('ios: Save backup downloads a real backup file', /^cardstock-backup-.*\.json$/.test(name), name || 'no download fired')
  check('ios: banner stays up after saving (install is step two)', await page.locator('.installtip').isVisible().catch(() => false))

  await dismissButton.click()
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
summarise()
