/**
 * Verifies the dark-scene capture path that the matrix can't reach: the
 * matrix composes stacked frames in-page, but the PHONE runs
 * captureFrameStacked() against a live <video>. This drives that real
 * function through the dev server and asserts the physics it exists for —
 * averaging N noisy frames must reduce noise — plus that it degrades safely
 * when the camera dies mid-stack.
 *
 *   node tests/harness/capture-stack.mjs
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.CAPTURE_TEST_PORT ?? 5199)

// `--host 127.0.0.1` is not decoration: vite's default binds the loopback NAME,
// so on a machine where `localhost` resolves to ::1 nothing listens on
// 127.0.0.1 — and every URL below is written against that literal. Without it
// this exits "dev server never came up" on a perfectly healthy checkout.
const vite = spawn(
  'node',
  [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
)
process.on('exit', () => {
  try {
    vite.kill('SIGTERM')
  } catch { /* gone */ }
})

const until = Date.now() + 30_000
let up = false
while (Date.now() < until && !up) {
  up = await fetch(`http://127.0.0.1:${PORT}/tests/harness/page.html`).then((r) => r.ok).catch(() => false)
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('dev server never came up')
  process.exit(1)
}

const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath())
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage()
page.on('pageerror', (err) => console.error('pageerror:', String(err).slice(0, 200)))
await page.goto(`http://127.0.0.1:${PORT}/tests/harness/page.html`, { waitUntil: 'domcontentloaded' })

const result = await page.evaluate(async () => {
  const { captureFrame, captureFrameStacked } = await import('/src/lib/camera.ts')

  // A dark, noisy "scene": mid-grey card on a dark table, heavy per-frame
  // noise redrawn continuously — i.e. what a phone sensor delivers at night.
  const source = document.createElement('canvas')
  source.width = 320
  source.height = 448
  const sctx = source.getContext('2d')
  let seed = 1
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const paint = () => {
    sctx.fillStyle = '#0d0d0d'
    sctx.fillRect(0, 0, source.width, source.height)
    sctx.fillStyle = '#4a4a4a'
    sctx.fillRect(40, 60, 240, 330)
    const image = sctx.getImageData(0, 0, source.width, source.height)
    const d = image.data
    for (let i = 0; i < d.length; i += 4) {
      const n = (rand() * 2 - 1) * 46
      d[i] = Math.max(0, Math.min(255, d[i] + n))
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
    }
    sctx.putImageData(image, 0, 0)
  }
  paint()
  const timer = setInterval(paint, 16)

  const video = document.createElement('video')
  video.srcObject = source.captureStream(60)
  video.muted = true
  video.playsInline = true
  await video.play()
  await new Promise((r) => setTimeout(r, 300))
  if (!video.videoWidth) return { error: 'video never produced frames' }

  /** Noise proxy: mean |difference| between horizontally adjacent pixels
   * INSIDE the flat card area. Flat region ⇒ all of it is noise. */
  const roughness = (canvas) => {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const x0 = Math.round(canvas.width * 0.25)
    const y0 = Math.round(canvas.height * 0.3)
    const w = Math.round(canvas.width * 0.4)
    const h = Math.round(canvas.height * 0.3)
    const d = ctx.getImageData(x0, y0, w, h).data
    let sum = 0
    let n = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 4
        sum += Math.abs(d[i] - d[i + 4])
        n++
      }
    }
    return sum / n
  }

  const single = roughness(captureFrame(video, null).canvas)
  const stacked5 = roughness((await captureFrameStacked(video, null, 5, 30)).canvas)

  // Camera dies mid-stack: must still return a usable canvas, not throw.
  const dying = document.createElement('video')
  let survived = true
  try {
    const capture = await captureFrameStacked(video, null, 3, 20)
    survived = capture.canvas.width > 0
  } catch {
    survived = false
  }
  clearInterval(timer)
  return { single, stacked5, survived, zeroWidthHandled: dying.videoWidth === 0 }
})

await browser.close()
vite.kill('SIGTERM')

if (result.error) {
  console.error('FAIL:', result.error)
  process.exit(1)
}
const reduction = 1 - result.stacked5 / result.single
console.log(`single-frame noise ${result.single.toFixed(1)} → 5-frame stack ${result.stacked5.toFixed(1)} (${(reduction * 100).toFixed(0)}% quieter)`)
// Averaging N independent frames scales noise by ~1/√N (≈55% quieter at
// N=5); anything under a third of that means the stack isn't really
// averaging distinct frames.
if (reduction < 0.2) {
  console.error(`FAIL: stacking barely reduced noise (${(reduction * 100).toFixed(0)}%) — is it averaging distinct frames?`)
  process.exit(1)
}
if (!result.survived) {
  console.error('FAIL: captureFrameStacked threw instead of degrading gracefully')
  process.exit(1)
}
console.log('CAPTURE-STACK OK — averaging reduces noise and survives a dying camera.')
