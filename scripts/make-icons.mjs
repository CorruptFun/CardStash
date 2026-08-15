#!/usr/bin/env node
/**
 * Regenerates the whole app-icon set from ONE source of truth: `markSvg()`
 * below. Run it after any change to the mark.
 *
 *   node scripts/make-icons.mjs          # writes public/favicon.svg + the PNGs
 *   node scripts/make-icons.mjs --check  # fails if anything is stale (CI-safe)
 *
 * Why a script and not four hand-drawn files: an icon set is the same artwork
 * at four sizes with three different framings, and keeping those in sync by
 * hand is how a magnifier survives in the favicon three months after it left
 * the launcher icon. Everything here derives from `markSvg()`.
 *
 * PNG rasterization goes through headless Chromium (playwright-core, already a
 * devDependency for the scan harness) rather than a native image library, so
 * there is no new dependency and the PNGs are rendered by the same engine that
 * renders the SVG in the browser.
 *
 * Chromium resolution matches the harnesses (`CHROMIUM_PATH`, then the CI
 * path, then Playwright's registry) — see the harness docs if it can't find one.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')

/* ---------------------------------------------------------------- the mark */

/**
 * A single holographic card, face on, on black.
 *
 * The card IS the mark — there is no magnifier, no second card, no lens. At
 * 32px in a browser tab you get one recognizable silhouette, which is the only
 * thing that survives at that size; the earlier lens-over-card composition
 * turned to mud there and read as a generic "search" glyph everywhere else.
 *
 * Everything scales off `size`, so the same drawing works at 64 and at 512.
 *
 * @param {object} opts
 * @param {number} opts.size      viewBox edge, px
 * @param {number} opts.radius    ground corner radius as a fraction of size
 *                                (0 = square, for maskable and iOS, which
 *                                apply their own mask)
 * @param {number} opts.cardScale card height as a fraction of size
 */
function markSvg({ size: S, radius = 0.234, cardScale = 0.74 }) {
  const r = (n) => Math.round(n * 1000) / 1000
  // Cards are 63:88. Height drives the layout; the tilt is small on purpose —
  // enough to say "held", not so much that it reads as falling over.
  const h = S * cardScale
  const w = (h * 63) / 88
  const x = (S - w) / 2
  const y = (S - h) / 2
  const cardR = h * 0.055
  const stroke = S * 0.026
  // The art window: the one interior detail that makes a rounded rectangle
  // read as a CARD rather than as a button. Its inset is asymmetric — more
  // room below than above — because that is where a real card puts its text.
  const winX = x + w * 0.125
  const winY = y + h * 0.105
  const winW = w * 0.75
  const winH = h * 0.45
  const grain = S * 0.016

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <linearGradient id="holo" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#25b6d4"/>
      <stop offset=".22" stop-color="#6250f2"/>
      <stop offset=".44" stop-color="#cb4dbf"/>
      <stop offset=".64" stop-color="#e8952f"/>
      <stop offset=".82" stop-color="#3fc98a"/>
      <stop offset="1" stop-color="#2ea3ee"/>
    </linearGradient>
    <!-- The specular band. Diffraction splits light into colour at the edge of
         a highlight, so the band has cyan and rose shoulders; a purely white
         one reads as glass. -->
    <linearGradient id="spec" x1="0" y1="1" x2="1" y2="0">
      <stop offset=".28" stop-color="#fff" stop-opacity="0"/>
      <stop offset=".4" stop-color="#7ee7ff" stop-opacity=".16"/>
      <stop offset=".47" stop-color="#fff" stop-opacity=".4"/>
      <stop offset=".54" stop-color="#ffb0f3" stop-opacity=".18"/>
      <stop offset=".64" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <!-- The diffraction grating: real holo stock is a physically ruled
         surface. It disappears below ~64px, which is correct — it is texture,
         not silhouette. -->
    <pattern id="grain" width="${r(grain)}" height="${r(grain)}"
             patternTransform="rotate(-24)" patternUnits="userSpaceOnUse">
      <rect width="${r(grain)}" height="${r(grain * 0.3)}" fill="#fff" opacity=".06"/>
    </pattern>
    <radialGradient id="ground" cx=".5" cy=".42" r=".72">
      <stop offset="0" stop-color="#191410"/>
      <stop offset=".55" stop-color="#0a0807"/>
      <stop offset="1" stop-color="#000"/>
    </radialGradient>
    <radialGradient id="bloom" cx=".5" cy=".46" r=".5">
      <stop offset="0" stop-color="#8ea6d8" stop-opacity=".22"/>
      <stop offset="1" stop-color="#8ea6d8" stop-opacity="0"/>
    </radialGradient>
    <clipPath id="cardclip">
      <rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(cardR)}"/>
    </clipPath>
    <filter id="lift" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="${r(S * 0.018)}" stdDeviation="${r(S * 0.028)}"
                    flood-color="#000" flood-opacity=".55"/>
    </filter>
    <!-- The white specular band and the grating both desaturate what they lie
         over, and a foil that has gone pastel reads as a plastic sleeve. This
         puts the chroma back after those layers, not before. -->
    <filter id="rich" x="-5%" y="-5%" width="110%" height="110%">
      <feColorMatrix type="saturate" values="1.35"/>
    </filter>
  </defs>

  <rect width="${S}" height="${S}" ${radius ? `rx="${r(S * radius)}"` : ''} fill="url(#ground)"/>
  <rect width="${S}" height="${S}" ${radius ? `rx="${r(S * radius)}"` : ''} fill="url(#bloom)"/>

  <g transform="rotate(-8 ${r(S / 2)} ${r(S / 2)})" filter="url(#lift)">
    <g clip-path="url(#cardclip)" filter="url(#rich)">
      <rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#holo)"/>
      <rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#grain)"/>
      <rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" fill="url(#spec)"/>
      <rect x="${r(winX)}" y="${r(winY)}" width="${r(winW)}" height="${r(winH)}"
            rx="${r(cardR * 0.7)}" fill="#0a0908" opacity=".62"/>
      <rect x="${r(winX)}" y="${r(winY)}" width="${r(winW)}" height="${r(winH)}"
            rx="${r(cardR * 0.7)}" fill="none" stroke="#f4efe8" stroke-opacity=".28"
            stroke-width="${r(stroke * 0.42)}"/>
    </g>
    <rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(cardR)}"
          fill="none" stroke="#f4efe8" stroke-width="${r(stroke)}"/>
  </g>
</svg>
`
}

/* ------------------------------------------------------------------ outputs */

const OUTPUTS = [
  // The browser tab. Rounded, because nothing masks a favicon for us.
  { file: 'public/favicon.svg', svg: { size: 64, radius: 0.234, cardScale: 0.74 } },
  { file: 'public/icons/icon-192.png', png: 192, svg: { size: 512, radius: 0.234, cardScale: 0.74 } },
  { file: 'public/icons/icon-512.png', png: 512, svg: { size: 512, radius: 0.234, cardScale: 0.74 } },
  // Maskable: square and full-bleed, and the card shrinks to clear the safe
  // zone. Android crops this to whatever shape the launcher wants — a circle
  // on many devices — so anything outside the centre 80% can be cut off.
  { file: 'public/icons/maskable-512.png', png: 512, svg: { size: 512, radius: 0, cardScale: 0.56 } },
  // iOS applies its own squircle, so this one ships square too. Black corners
  // under a black ground are invisible either way; what matters is that we
  // don't double-round it.
  { file: 'public/icons/apple-touch-icon.png', png: 180, svg: { size: 512, radius: 0, cardScale: 0.7 } },
]

/* ---------------------------------------------------------------- rendering */

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium'
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return p
  } catch {
    /* fall through to the error below */
  }
  throw new Error('No Chromium found — set CHROMIUM_PATH (see tests/harness docs)')
}

async function main() {
  const stale = []
  const svgOnly = OUTPUTS.filter((o) => !o.png)
  const pngs = OUTPUTS.filter((o) => o.png)

  for (const out of svgOnly) {
    const body = markSvg(out.svg)
    const path = join(root, out.file)
    if (check) {
      if (!existsSync(path) || readFileSync(path, 'utf8') !== body) stale.push(out.file)
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, body)
      console.log(`  ${out.file}`)
    }
  }

  const browser = await chromium.launch({ executablePath: findChromium() })
  try {
    for (const out of pngs) {
      const page = await browser.newPage({
        viewport: { width: out.png, height: out.png },
        // Render at 1× of the target: the SVG is resolution-independent, so
        // asking Chromium for a 512-wide viewport gives a clean 512 PNG with
        // no resampling step to soften the edges.
        deviceScaleFactor: 1,
      })
      const svg = markSvg(out.svg)
      await page.setContent(
        `<!doctype html><meta charset="utf-8">
         <style>html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${out.png}px;height:${out.png}px}</style>${svg}`,
      )
      const buf = await page.screenshot({ omitBackground: true })
      await page.close()
      const path = join(root, out.file)
      if (check) {
        if (!existsSync(path) || !readFileSync(path).equals(buf)) stale.push(out.file)
      } else {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, buf)
        console.log(`  ${out.file}  ${out.png}×${out.png}`)
      }
    }
  } finally {
    await browser.close()
  }

  if (check && stale.length) {
    console.error(`Icons are stale — run \`npm run icons\`:\n  ${stale.join('\n  ')}`)
    process.exit(1)
  }
  console.log(check ? 'Icons are up to date.' : 'Icons written.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
