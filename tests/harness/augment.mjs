/**
 * Deterministic image degradations for the scan harness — the stand-ins for
 * what a phone camera does to a real card: soft focus, low sensor detail,
 * rotation, perspective tilt, specular glare, low light, and a card that
 * doesn't fill the reticle. Runs IN PAGE (browser canvas); every effect is
 * seeded/parameterized so before/after runs are comparable cell by cell.
 */

/** The captured-frame stand-in: same 63:88 shape the reticle crop yields. */
export const FRAME_W = 756
export const FRAME_H = 1056

/** Seeded PRNG so noise/glare land identically run to run. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

/**
 * Trim flat margins (TCGplayer product shots pad the card on white).
 * Scans a downsampled copy for rows/cols that differ from the corner color.
 */
export function trimToCard(img) {
  const w = img.naturalWidth ?? img.width
  const h = img.naturalHeight ?? img.height
  const sw = 200
  const sh = Math.max(1, Math.round((h / w) * sw))
  const probe = makeCanvas(sw, sh)
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, sw, sh)
  const { data } = ctx.getImageData(0, 0, sw, sh)
  const luma = (i) => (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
  const corners = [0, (sw - 1) * 4, (sh - 1) * sw * 4, ((sh - 1) * sw + sw - 1) * 4]
  const bg = corners.reduce((sum, i) => sum + luma(i), 0) / 4
  const differs = (x, y) => Math.abs(luma((y * sw + x) * 4) - bg) > 26
  const rowHit = (y) => {
    let hits = 0
    for (let x = 0; x < sw; x++) if (differs(x, y)) hits++
    return hits / sw > 0.04
  }
  const colHit = (x) => {
    let hits = 0
    for (let y = 0; y < sh; y++) if (differs(x, y)) hits++
    return hits / sh > 0.04
  }
  let top = 0, bottom = sh - 1, left = 0, right = sw - 1
  while (top < bottom && !rowHit(top)) top++
  while (bottom > top && !rowHit(bottom)) bottom--
  while (left < right && !colHit(left)) left++
  while (right > left && !colHit(right)) right--
  // Nothing to trim (or degenerate): use the whole image.
  if (right - left < sw * 0.3 || bottom - top < sh * 0.3) return { sx: 0, sy: 0, sw: w, sh: h }
  const fx = w / sw
  const fy = h / sh
  return {
    sx: Math.max(0, Math.floor(left * fx)),
    sy: Math.max(0, Math.floor(top * fy)),
    sw: Math.min(w, Math.ceil((right - left + 1) * fx)),
    sh: Math.min(h, Math.ceil((bottom - top + 1) * fy)),
  }
}

/**
 * Compose one matrix cell: the (trimmed) card drawn into a frame-shaped
 * canvas under a degradation spec.
 *
 * spec: {
 *   fill?: 0..1     card height as a fraction of frame height (default .92)
 *   dx?, dy?        center offset as fractions of frame size
 *   rotate?         degrees
 *   tilt?: 0..1     perspective: top edge narrower by this fraction
 *   downscale?: 0..1  simulate low sensor detail (render via a small buffer)
 *   blurPx?         gaussian blur radius on the finished frame
 *   glare?: 0..1    specular streak strength
 *   brightness?: 0..1+  luma multiplier (low light)
 *   noise?: 0..~12  ± per-channel sensor noise at low light
 *   seed?           PRNG seed (defaults from the numeric params)
 * }
 */
export function compose(img, spec = {}) {
  const {
    fill = 0.92, dx = 0, dy = 0, rotate = 0, tilt = 0,
    downscale = 1, blurPx = 0, glare = 0, brightness = 1, noise = 0,
  } = spec
  const seed = spec.seed ?? Math.round(fill * 97 + rotate * 13 + tilt * 57 + glare * 31 + brightness * 71 + noise * 7 + 1)
  const rand = mulberry32(seed)

  const src = trimToCard(img)

  // Card buffer at target size (optionally through a low-res bounce to shed detail).
  const cardH = Math.round(FRAME_H * fill)
  const cardW = Math.round((cardH * src.sw) / src.sh)
  let card = makeCanvas(cardW, cardH)
  {
    const ctx = card.getContext('2d')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (downscale < 1) {
      const small = makeCanvas(Math.max(24, Math.round(cardW * downscale)), Math.max(24, Math.round(cardH * downscale)))
      const sctx = small.getContext('2d')
      sctx.imageSmoothingEnabled = true
      sctx.imageSmoothingQuality = 'high'
      sctx.drawImage(img, src.sx, src.sy, src.sw, src.sh, 0, 0, small.width, small.height)
      ctx.drawImage(small, 0, 0, cardW, cardH)
    } else {
      ctx.drawImage(img, src.sx, src.sy, src.sw, src.sh, 0, 0, cardW, cardH)
    }
  }

  // Perspective tilt: top edge narrower + rows compressed toward the top,
  // approximated with horizontal strips (fine at the ≤15% tilts we test).
  if (tilt > 0) {
    const warped = makeCanvas(cardW, cardH)
    const ctx = warped.getContext('2d')
    ctx.imageSmoothingEnabled = true
    const strips = 48
    const stripH = cardH / strips
    for (let i = 0; i < strips; i++) {
      const v = i / (strips - 1) // 0 top → 1 bottom
      const shrink = tilt * (1 - v)
      const w = cardW * (1 - shrink)
      const x = (cardW - w) / 2
      const yScale = 1 - tilt * 0.5 * (1 - v)
      const y = cardH - (strips - i) * stripH * yScale
      ctx.drawImage(card, 0, i * stripH, cardW, stripH, x, y, w, stripH * yScale + 0.75)
    }
    card = warped
  }

  const frame = makeCanvas(FRAME_W, FRAME_H)
  const ctx = frame.getContext('2d', { willReadFrequently: true })
  // Desk-like backdrop with a soft vignette so edges aren't a synthetic flat.
  ctx.fillStyle = '#8f8874'
  ctx.fillRect(0, 0, FRAME_W, FRAME_H)
  const vign = ctx.createRadialGradient(FRAME_W / 2, FRAME_H / 2, FRAME_H * 0.2, FRAME_W / 2, FRAME_H / 2, FRAME_H * 0.75)
  vign.addColorStop(0, 'rgba(255,255,255,0.06)')
  vign.addColorStop(1, 'rgba(0,0,0,0.18)')
  ctx.fillStyle = vign
  ctx.fillRect(0, 0, FRAME_W, FRAME_H)

  ctx.save()
  ctx.translate(FRAME_W / 2 + dx * FRAME_W, FRAME_H / 2 + dy * FRAME_H)
  ctx.rotate((rotate * Math.PI) / 180)
  ctx.shadowColor = 'rgba(0,0,0,0.35)'
  ctx.shadowBlur = 14
  ctx.drawImage(card, -card.width / 2, -card.height / 2)
  ctx.restore()

  if (glare > 0) {
    // Two diagonal specular streaks; the first crosses the upper half where
    // most games print the name.
    const streak = (x0, y0, x1, y1, width, alpha) => {
      const nx = y1 - y0
      const ny = -(x1 - x0)
      const len = Math.hypot(nx, ny) || 1
      const off = (width / 2 / len)
      const g = ctx.createLinearGradient(x0 + nx * off, y0 + ny * off, x0 - nx * off, y0 - ny * off)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.5, `rgba(255,252,240,${alpha})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, FRAME_W, FRAME_H)
    }
    streak(FRAME_W * 0.05, FRAME_H * (0.08 + rand() * 0.1), FRAME_W, FRAME_H * (0.4 + rand() * 0.1), FRAME_W * 0.3, 0.5 * glare)
    streak(FRAME_W * 0.3, FRAME_H, FRAME_W * 0.9, FRAME_H * 0.35, FRAME_W * 0.22, 0.32 * glare)
    const bloomX = FRAME_W * (0.3 + rand() * 0.4)
    const bloomY = FRAME_H * (0.12 + rand() * 0.2)
    const bloom = ctx.createRadialGradient(bloomX, bloomY, 0, bloomX, bloomY, FRAME_W * 0.24)
    bloom.addColorStop(0, `rgba(255,255,255,${0.55 * glare})`)
    bloom.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = bloom
    ctx.fillRect(0, 0, FRAME_W, FRAME_H)
  }

  if (brightness !== 1 || noise > 0) {
    const image = ctx.getImageData(0, 0, FRAME_W, FRAME_H)
    const d = image.data
    for (let i = 0; i < d.length; i += 4) {
      const n = noise > 0 ? (rand() * 2 - 1) * noise : 0
      d[i] = Math.max(0, Math.min(255, d[i] * brightness + n))
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * brightness + n))
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * brightness + n))
    }
    ctx.putImageData(image, 0, 0)
  }

  if (blurPx > 0) {
    const soft = makeCanvas(FRAME_W, FRAME_H)
    const sctx = soft.getContext('2d')
    sctx.filter = `blur(${blurPx}px)`
    sctx.drawImage(frame, 0, 0)
    return soft
  }
  return frame
}

/** The fixed degradation battery every fixture runs through. */
export const DEGRADATIONS = {
  clean: { fill: 0.92 },
  'small-offset': { fill: 0.58, dx: 0.07, dy: 0.05 },
  'soft-focus': { downscale: 0.5, blurPx: 1.4 },
  'rot+5': { rotate: 5, fill: 0.86 },
  'rot-5': { rotate: -5, fill: 0.86 },
  perspective: { tilt: 0.13, fill: 0.88 },
  glare: { glare: 1 },
  lowlight: { brightness: 0.42, noise: 7 },
  worst: { fill: 0.62, dx: 0.05, rotate: 3, downscale: 0.65, blurPx: 0.8, glare: 0.55, brightness: 0.55, noise: 5 },
}
