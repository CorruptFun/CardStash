/**
 * The invite link, end to end on the client, in a real browser.
 *
 * An invite is two halves that never run on the same device: `InvitePanel`
 * writes a URL on the inviter's phone, and `captureReferral()` reads it back on
 * a stranger's, at boot, before anything else touches the URL. Everything in
 * between is chat apps and an OAuth redirect. The unit tests pin the string
 * arithmetic; this drives the actual screen and then opens what it produced as
 * a brand-new visitor, which is the only way to see that the banking half runs
 * at all — `captureReferral()` is the first statement of `boot()` and a
 * regression there is silent, permanent and invisible to every other test.
 *
 * What it CANNOT check is the server half: `befriend_referrer()` needs a real
 * project and a real account. That is `tests/harness/social-rls.mjs` §6b.
 *
 *   node tests/harness/invite-ui.mjs
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PORT = Number(process.env.INVITE_UI_PORT ?? 5213)
const HANDLE = 'raetest'

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
const stopVite = () => {
  try {
    server.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}
process.on('exit', stopVite)

const until = Date.now() + 25_000
let up = false
while (Date.now() < until && !up) {
  up = await fetch(`http://127.0.0.1:${PORT}/`)
    .then((r) => r.ok)
    .catch(() => false)
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('preview server never came up')
  stopVite()
  process.exit(1)
}

const ORIGIN = `http://127.0.0.1:${PORT}`
let browser
const pageErrors = []

try {
  const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  // The real clipboard is deliberately NOT used: `clipboard-read` needs a
  // permission this headless build never settles, so the harness would hang
  // rather than fail. Stubbing writeText keeps the part that matters — the
  // button hands the clipboard the exact URL it displays — and drops the part
  // that only tests Chromium.
  await page.addInitScript(() => {
    window.__copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text) => {
          window.__copied = text
          return Promise.resolve()
        },
      },
    })
  })
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text())
  })
  // Nothing here should need the network. Anything that tries is answered
  // rather than left hanging, so a run is the same with or without egress.
  await page.route('**', (route) => {
    const url = route.request().url()
    if (url.startsWith(ORIGIN)) return route.continue()
    return route.fulfill({ status: 204, body: '' })
  })

  console.log('\nThe serverless path stays clean')
  await page.goto(`${ORIGIN}/?nosw=1&welcome=0#/friends`, { waitUntil: 'load' })
  await page.waitForTimeout(1200)
  const invite = page.locator('.invite__link')
  check(
    (await page.getByRole('heading', { name: 'Invite a friend' }).count()) === 0,
    'signed out, there is no invite section at all',
  )

  console.log('\nWith a handle')
  // socialHandle is a localStorage cache and every "are they set up?" check
  // reads it (CLAUDE.md), so seeding it is the supported way to stand in for a
  // set-up account without a live project.
  await page.evaluate((handle) => {
    const key = 'cardstock-settings'
    const raw = JSON.parse(localStorage.getItem(key) ?? '{"state":{},"version":0}')
    raw.state = { ...raw.state, socialHandle: handle }
    localStorage.setItem(key, JSON.stringify(raw))
  }, HANDLE)
  // reload(), not goto(): the URL is identical to the one already loaded, and a
  // goto that differs only in fragment is a same-document navigation — the app
  // never re-boots, never re-reads what was just seeded, and the assertions
  // below quietly grade the previous page.
  await page.reload({ waitUntil: 'load' })
  await page.waitForTimeout(1500)

  check((await invite.count()) === 1, 'the invite section is on the Friends screen')
  const shown = (await invite.textContent())?.trim() ?? ''
  check(shown.includes(`?via=${HANDLE}`), 'it shows a link carrying my handle', shown)
  check(!shown.includes('#'), 'and nothing else — no fragment rides along', shown)

  await page.getByRole('button', { name: /Copy link/i }).click()
  await page.waitForTimeout(400)
  const copied = await page.evaluate(() => window.__copied)
  check(copied === `${ORIGIN}/?via=${HANDLE}`, 'Copy link puts the real URL on the clipboard', copied)
  check(
    (await page.getByRole('button', { name: 'Copied' }).count()) === 1,
    'and says so, because a copy with no feedback gets tapped twice',
  )

  console.log('\nOpening it as a stranger')
  // A different browser context: no localStorage, no settings, nothing. This
  // is the person receiving the invite.
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const guest = await fresh.newPage()
  guest.on('pageerror', (err) => pageErrors.push(String(err)))
  await guest.route('**', (route) =>
    route.request().url().startsWith(ORIGIN) ? route.continue() : route.fulfill({ status: 204, body: '' }),
  )
  await guest.goto(`${copied}&nosw=1&welcome=0`, { waitUntil: 'load' })
  await guest.waitForTimeout(1500)
  const banked = await guest.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('cardstock-settings') ?? '{"state":{}}')
    return raw.state?.referralFrom ?? ''
  })
  check(banked === HANDLE, 'THE REFERRAL IS BANKED AT BOOT, before any account exists', banked || '(nothing)')

  // The first link wins, for ever: claim_referral() records one referrer per
  // account and refuses to change it, so a second link overwriting this would
  // leave the app crediting someone the database does not.
  await guest.goto(`${ORIGIN}/?via=someoneelse&nosw=1&welcome=0`, { waitUntil: 'load' })
  await guest.waitForTimeout(1200)
  const afterSecond = await guest.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('cardstock-settings') ?? '{"state":{}}')
    return raw.state?.referralFrom ?? ''
  })
  check(afterSecond === HANDLE, 'a later link does not overwrite the first', afterSecond)

  check(pageErrors.length === 0, 'no uncaught page errors', pageErrors.slice(0, 3).join(' | '))
} catch (err) {
  console.error('\n' + String(err))
  failures.push(String(err).slice(0, 200))
} finally {
  await browser?.close().catch(() => {})
  stopVite()
}

if (failures.length) {
  console.log(`\n\x1b[31mINVITE UI FAILED\x1b[0m — ${failures.length}: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('\n\x1b[32mINVITE OK\x1b[0m — the link carries the handle, copies, and banks itself on arrival.')
// Explicit: the preview server is a live child with open pipes, so the event
// loop never drains on its own and a run would hang after passing.
process.exit(0)
