/**
 * The camera is on while the scan screen is the screen, and off otherwise.
 *
 * Nothing else here can check this. The matrix drives `identifyFrame` with no
 * camera at all, and `drive-scan-ui.mjs` cares whether a scan lands in Dexie,
 * not whether a MediaStreamTrack outlived the view. What this pins is the
 * thing a user actually sees — the OS camera indicator — and the reason it is
 * easy to get wrong: the scan screen is never unmounted (it hides behind
 * `hidden`), so the camera only stops if something deliberately stops it.
 *
 *   node tests/harness/camera-lifecycle.mjs
 *
 * Runs twice. Once as an ordinary browser, and once with the app fooled into
 * thinking it is an iOS Home-Screen app (iPhone UA + `navigator.standalone`),
 * because that is the ONLY configuration where `releaseCamera()` parks a live
 * stream instead of stopping it — and therefore the only one where leaving a
 * tab could leave the camera running. Needs no fixtures: a fake camera device
 * stands the scanner up, and identification is allowed to fail.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PORT = Number(process.env.CAMERA_LIFECYCLE_PORT ?? 5212)
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const findChromium = () =>
  process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined)

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

const vite = spawn('node', [join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: REPO,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
const stopVite = () => {
  try {
    vite.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}
process.on('exit', stopVite)

const waitFor = async (url, ms = 40_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${url}\n${viteLog.split('\n').slice(-12).join('\n')}`)
}

/** Every video track the app has ever acquired, and how many are still live. */
const cameraState = (page) =>
  page.evaluate(() => ({
    acquired: window.__camTracks.length,
    live: window.__camTracks.filter((t) => t.readyState === 'live').length,
  }))

const waitForLive = async (page, ms = 15_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if ((await cameraState(page)).live > 0) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/**
 * The scan screen, live, with every getUserMedia acquisition recorded. The
 * init script has to wrap `getUserMedia` before any app code imports it.
 */
async function openScanner(browser, { standalone }) {
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    permissions: ['camera'],
    ...(standalone ? { userAgent: IPHONE_UA, isMobile: true, hasTouch: true } : {}),
  })
  // Nothing here reaches the network: the card APIs are unreachable in a
  // sandbox anyway, and a failed identification says nothing about whether the
  // camera was released.
  await ctx.route('**/*', (route) => {
    const url = route.request().url()
    const local = url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:')
    return local ? route.continue() : route.abort('failed')
  })
  await ctx.addInitScript(
    ({ standalone }) => {
      if (standalone) Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
      window.__camTracks = []
      const media = navigator.mediaDevices
      const original = media.getUserMedia.bind(media)
      media.getUserMedia = async (constraints) => {
        const stream = await original(constraints)
        window.__camTracks.push(...stream.getVideoTracks())
        return stream
      }
    },
    { standalone },
  )

  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${PORT}/index.html?nosw=1`)
  await page.waitForSelector('.nav', { timeout: 30_000 })
  await page.evaluate(() => (location.hash = '#/scan'))
  await page.waitForTimeout(600)
  const gate = page.locator('.scan__gate .btn--primary').first()
  if (await gate.count()) await gate.click().catch(() => {})
  return { ctx, page }
}

async function run(browser, label, { standalone }) {
  console.log(`\n${label}`)
  const { ctx, page } = await openScanner(browser, { standalone })
  try {
    check(await waitForLive(page), 'the scan screen turns the camera on')

    // The fix. Before it, an iOS Home-Screen app parked the stream here and
    // held the camera indicator lit for 25s on a screen with no viewfinder.
    await page.evaluate(() => (location.hash = '#/collection'))
    await page.waitForTimeout(800)
    let state = await cameraState(page)
    check(state.live === 0, 'leaving the scan tab turns the camera off', `${state.live} live track(s)`)

    await page.evaluate(() => (location.hash = '#/scan'))
    check(await waitForLive(page), 'coming back turns it on again')

    // Two more tabs deep: a stale park would surface as a live track here.
    await page.evaluate(() => (location.hash = '#/settings'))
    await page.waitForTimeout(400)
    await page.evaluate(() => (location.hash = '#/decks'))
    await page.waitForTimeout(800)
    state = await cameraState(page)
    check(state.live === 0, 'still off after hopping between other tabs', `${state.live} live track(s)`)

    // The park contract itself, exercised against a real MediaStream rather
    // than inferred from the UI: parking is for an interruption ON the scan
    // screen, and ending it is unconditional.
    const park = await page.evaluate(async () => {
      const cam = await import('/src/lib/camera.ts')
      const video = document.createElement('video')
      const session = await cam.startCamera(video)
      cam.releaseCamera(session)
      const afterRelease = session.track.readyState
      cam.endParkedCamera()
      return { reprompts: cam.CAMERA_REPROMPTS_EACH_ACQUIRE, afterRelease, afterEnd: session.track.readyState }
    })
    check(park.reprompts === standalone, 'the platform reads as expected', `parking ${park.reprompts ? 'on' : 'off'}`)
    check(
      park.afterRelease === (standalone ? 'live' : 'ended'),
      standalone ? 'releasing on the scan screen parks the stream' : 'releasing stops the stream outright',
      `track was ${park.afterRelease}`,
    )
    check(park.afterEnd === 'ended', 'endParkedCamera() ends a parked stream', `track was ${park.afterEnd}`)

    const leftover = (await cameraState(page)).live
    check(leftover === 0, 'no camera is left running at the end', `${leftover} live track(s)`)
  } finally {
    await ctx.close().catch(() => {})
  }
}

let browser
try {
  await waitFor(`http://127.0.0.1:${PORT}/index.html`)
  browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  await run(browser, 'Ordinary browser', { standalone: false })
  await run(browser, 'iOS Home-Screen app (the platform that parks)', { standalone: true })
} catch (err) {
  console.error('\n' + String(err))
  failures.push(String(err).slice(0, 200))
} finally {
  await browser?.close().catch(() => {})
  stopVite()
}

console.log(
  failures.length
    ? `\nCAMERA LIFECYCLE FAILED — ${failures.length}: ${failures.join('; ')}`
    : '\nCAMERA LIFECYCLE OK — the camera runs on the scan screen and nowhere else.',
)
process.exit(failures.length ? 1 : 0)
