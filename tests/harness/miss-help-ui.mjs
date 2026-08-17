/**
 * Drive the REAL app's miss surfaces: the chip that says a card would not read,
 * and the panel that does something about it.
 *
 * WHY THIS EXISTS AT ALL. The bug it was written for is invisible to every
 * other check here: the actions lived on the miss chip, the chip is torn down
 * by the scanner's own retry about a second later, and reaching for a button
 * moves the phone — which is itself what dismisses it. Nothing was broken in a
 * way a screenshot or a type could show. The fix is a split (a transient chip
 * that only states, a panel that persists and acts), so what has to be proven
 * is DURABILITY: the panel is still there, and still clickable, after the
 * scanner has flipped status underneath it.
 *
 *   node tests/harness/miss-help-ui.mjs                  # pass/fail
 *   node tests/harness/miss-help-ui.mjs --shots=/tmp/x   # + screenshots
 *
 * Misses are manufactured rather than waited for: chromium's fake camera
 * device is a rolling test pattern, so every identification of it fails, and
 * the viewfinder's own tap-to-scan forces the attempts instead of hoping the
 * motion gate lets one through. Fixtures answer the card APIs for the same
 * reason the other UI harnesses stub them — a lookup that fails for want of a
 * network says nothing about the UI.
 *
 * The three passes are three different users, because the offer's whole design
 * is that they see different things: signed out (never asked for money — the
 * folded rescue-value-prop line names the free path instead: an account, 50
 * free reads), signed in with cloud rescue off (offered the FREE switch, never
 * the subscription), and signed in with it on (offered the discounted year).
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
const PORT = Number(process.env.MISS_UI_PORT ?? 5214)

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

const findChromium = () =>
  process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

// `--host 127.0.0.1` for the reason run-matrix.mjs documents: vite binds the
// loopback NAME, so where `localhost` is ::1 nothing listens on the literal the
// probe below is written against. `VITE_SCAN_OFFER=on` is the client half of
// the offer's two switches — without it the panel never mentions money, which
// is exactly what the deployed build does today.
const vite = spawn(
  'node',
  [join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VITE_SCAN_OFFER: 'on' } },
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

/** Requests the app made that this harness answered itself, for asserting on. */
const seen = { checkout: [] }

let browser
try {
  await waitFor(`http://127.0.0.1:${PORT}/index.html`)
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })

  const stubs = createStubs(FIXTURES)

  /**
   * One pass = one kind of user. `session` and `settings` are seeded before the
   * app's first script runs, because both are read during boot and a value set
   * afterwards is a value the first render never saw.
   */
  const open = async ({ session, settings, entitlements }) => {
    const ctx = await browser.newContext({
      viewport: { width: 420, height: 900 },
      deviceScaleFactor: 2,
      permissions: ['camera'],
    })
    await ctx.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:')) {
        return route.continue()
      }
      if (url.includes('/rest/v1/entitlements')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(entitlements ?? []) })
      }
      if (url.includes('/stripe-billing/checkout')) {
        seen.checkout.push(route.request().postData() ?? '')
        // Answered as a deployment with no offer price configured would answer
        // it. That keeps the browser on the page (a 200 with a URL would
        // navigate away mid-run) AND exercises the refusal that exists so a
        // panel quoting $10.99 can never end at a $11.99 till.
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'offer not configured' }),
        })
      }
      const hit = stubs.handle(url, route.request())
      if (hit) return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body })
      return route.abort('failed')
    })
    await ctx.addInitScript(
      ([session, settings]) => {
        if (session) localStorage.setItem('cardstock-cloud-session', JSON.stringify(session))
        localStorage.setItem('cardstock-settings', JSON.stringify({ state: settings, version: 0 }))
      },
      [session, settings],
    )
    const page = await ctx.newPage()
    page.on('pageerror', (err) => check(false, 'no page errors', String(err).slice(0, 160)))
    // `welcome=0` because a harness is a first-time visitor every run and the
    // welcome dialog is modal — it takes the taps meant for the scan screen.
    await page.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1&welcome=0`)
    await page.waitForSelector('.nav', { timeout: 30_000 })
    await page.evaluate(() => (location.hash = '#/scan'))
    await page.waitForTimeout(800)
    const start = page.locator('.scan__gate .btn--primary').first()
    if (await start.count()) await start.click().catch(() => {})
    await page.waitForTimeout(3000)
    return { ctx, page }
  }

  /** Force one identification of the test pattern and wait for it to fail. */
  const missOnce = async (page) => {
    // Top-left corner of the tap layer: the help panel sits over the middle of
    // it once it appears, and a click that lands on the panel is not a scan.
    await page.locator('.scan__tap').click({ position: { x: 8, y: 8 }, timeout: 10_000 }).catch(() => {})
    await page.waitForSelector('.chip--nomatch', { timeout: 60_000 }).catch(() => {})
  }

  const signedIn = {
    accessToken: 'harness-access-token',
    refreshToken: 'harness-refresh-token',
    // Far future: `freshToken()` only calls the auth server once this passes.
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    email: 'harness@example.test',
    userId: '00000000-0000-4000-8000-00000000beef',
  }
  const baseSettings = { onboardedAt: Date.now(), cameraApproved: true, diagShare: false, diagConsentAt: Date.now() }

  /* --- signed out: the free path is never asked for money ----------------- */

  console.log('\nSigned out — the chip states, the panel acts')
  {
    const { ctx, page } = await open({ session: null, settings: baseSettings })
    await missOnce(page)

    // The chip lives ~1.6s before the retry replaces it — wait for it rather
    // than racing it, or this check samples an empty slot and calls it a bug.
    await page.waitForSelector('.chip__misshint', { timeout: 15_000 }).catch(() => {})
    const chipButtons = await page.locator('.chip--nomatch button').count()
    check(chipButtons === 0, 'the miss chip carries no buttons', `${chipButtons} found`)
    const hint = (await page.locator('.chip__misshint').first().textContent().catch(() => ''))?.trim() ?? ''
    check(/try again/i.test(hint) && /upload/i.test(hint), 'the chip says what to do', JSON.stringify(hint))
    check(await page.locator('.scan__misshelp').count() === 0, 'one miss is not yet a problem')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'miss-1-chip.png') })

    await missOnce(page)
    check(
      await page.waitForSelector('.scan__misshelp', { timeout: 30_000 }).then(() => true).catch(() => false),
      'a run of misses brings up the help panel',
    )
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'miss-2-help.png') })

    const labels = (await page.locator('.scan__misshelp .scan__tipbtns button').allTextContents()).map((t) => t.trim())
    check(labels.some((t) => /try again/i.test(t)), 'the panel offers a retry', labels.join(' · '))
    check(labels.some((t) => /add it myself/i.test(t)), 'the panel keeps "add it myself"')
    // The folded rescue-value-prop line: signed out, the panel NAMES the free
    // path (an account, 50 free reads) — and still never asks for money.
    const offerText = ((await page.locator('.scan__offer').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check(!/\$|a year|get it|subscribe/i.test(offerText), 'a signed-out user is never asked for money', offerText)
    check(/50 a month free/i.test(offerText) && /sign in/i.test(offerText), 'the free path is named, with the way in', offerText)

    // THE REGRESSION. Retrying flips the scanner's status underneath the panel
    // — which is what used to take the buttons away mid-reach.
    await page.locator('.scan__misshelp button', { hasText: /try again/i }).first().click()
    await page.waitForTimeout(700)
    check(await page.locator('.scan__misshelp').isVisible(), 'the panel survives the retry it started')
    await page.waitForSelector('.chip--nomatch', { timeout: 60_000 }).catch(() => {})
    check(await page.locator('.scan__misshelp').isVisible(), 'and survives the miss that follows')

    // And the buttons work, which is the point of them being reachable.
    await page.locator('.scan__misshelp button', { hasText: /add it myself/i }).first().click()
    check(
      await page.waitForSelector('.cardedit', { timeout: 20_000 }).then(() => true).catch(() => false),
      '"add it myself" opens the card editor',
    )
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(600)
    await page.locator('.scan__misshelp button', { hasText: /^hide$/i }).first().click()
    await page.waitForTimeout(300)
    check(await page.locator('.scan__misshelp').count() === 0, 'Hide dismisses it')
    await ctx.close()
  }

  /* --- signed in, rescue off: the free switch, not the subscription ------- */

  console.log('\nSigned in, cloud rescue off — offered the free thing')
  {
    const { ctx, page } = await open({
      session: signedIn,
      settings: { ...baseSettings, cloudScanRescue: false },
    })
    await missOnce(page)
    await missOnce(page)
    await page.waitForSelector('.scan__misshelp', { timeout: 30_000 }).catch(() => {})
    const text = ((await page.locator('.scan__offer').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check(/cloud rescue is off/i.test(text), 'the panel names the switch that is off', text.slice(0, 90))
    check(/50 a month are free/i.test(text), 'and says the free allowance out loud')
    check(!/\$/.test(text), 'no price is quoted to someone who has not tried the free version', text.slice(0, 90))
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'miss-3-rescueoff.png') })

    await page.locator('.scan__offer button', { hasText: /turn it on/i }).first().click()
    await page.waitForTimeout(500)
    const on = await page.evaluate(() => JSON.parse(localStorage.getItem('cardstock-settings') ?? '{}')?.state?.cloudScanRescue)
    check(on === true, 'tapping it switches cloud rescue on')
    await ctx.close()
  }

  /* --- signed in, rescue on, unsubscribed: the discounted year ------------ */

  console.log('\nSigned in, cloud rescue on, no subscription — the offer')
  {
    const { ctx, page } = await open({
      session: signedIn,
      settings: { ...baseSettings, cloudScanRescue: true },
      entitlements: [], // no row at all: the one answer that means "never subscribed"
    })
    await missOnce(page)
    await missOnce(page)
    await page.waitForSelector('.scan__misshelp', { timeout: 30_000 }).catch(() => {})
    check(await page.locator('.scan__offer').count() === 0, 'two misses do not yet cost money')
    await missOnce(page)
    check(
      await page.waitForSelector('.scan__offer', { timeout: 30_000 }).then(() => true).catch(() => false),
      'the third brings the offer',
    )
    const text = ((await page.locator('.scan__offer').first().textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ')
    check(text.includes('$10.99') && text.includes('$11.99'), 'it quotes both prices', text.slice(0, 120))
    check(/\$1 off/i.test(text), 'and names the discount as a discount')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'miss-4-offer.png') })

    await page.locator('.scan__offer button', { hasText: /get it for/i }).first().click()
    await page.waitForTimeout(1500)
    check(seen.checkout.some((body) => body.includes('scan-miss')), 'the checkout asks for the scan-miss offer', seen.checkout.join(' '))
    const toast = ((await page.locator('.toast__text').first().textContent().catch(() => '')) ?? '').trim()
    check(/isn.t available/i.test(toast), 'a refused offer says so instead of selling the full price', JSON.stringify(toast))

    // "No thanks" has to outlive the session — a run of misses is the easiest
    // thing in this app to reproduce by accident.
    await page.locator('.scan__offer button', { hasText: /no thanks/i }).first().click()
    await page.waitForTimeout(400)
    check(await page.locator('.scan__offer').count() === 0, '"no thanks" takes the offer away')
    const snoozed = await page.evaluate(() => JSON.parse(localStorage.getItem('cardstock-settings') ?? '{}')?.state?.scanOfferAt)
    check(typeof snoozed === 'number' && snoozed > 0, 'and is remembered across launches', `scanOfferAt=${snoozed}`)
    await ctx.close()
  }
} catch (err) {
  console.error(`\nharness error: ${err?.stack ?? err}`)
  failures.push('harness ran to completion')
} finally {
  await browser?.close().catch(() => {})
  stopVite()
}

console.log(`\n${failures.length ? `FAIL — ${failures.length} check(s)` : 'PASS'}`)
process.exit(failures.length ? 1 : 0)
