export type CameraPermission = 'granted' | 'prompt' | 'denied' | 'unknown'

/** Peek at the camera permission without triggering a prompt. */
export async function cameraPermissionState(): Promise<CameraPermission> {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' as PermissionName })
    const state = status?.state
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unknown'
  } catch {
    // Firefox has no 'camera' permission name; older Safari has no query().
    return 'unknown'
  }
}

/** iOS/iPadOS — iPads masquerade as Macs, so touch points break the tie. */
const IS_IOS =
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))

/** Running installed to the Home Screen (standalone display mode). */
export const IS_STANDALONE =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true)

/**
 * iOS Home-Screen web apps get NO persistent camera grant: Apple re-prompts
 * on each fresh getUserMedia acquisition after the app was closed — there's
 * no Settings entry, no aA menu, no web API to change that. What the app CAN
 * control is how often it re-acquires: every getUserMedia call this flag lets
 * us skip is a permission dialog the user doesn't see.
 */
export const CAMERA_REPROMPTS_EACH_ACQUIRE = IS_IOS && IS_STANDALONE

export interface CameraSession {
  stream: MediaStream
  track: MediaStreamTrack
  setTorch: ((on: boolean) => Promise<void>) | null
  /**
   * Best-effort low-light boost: pushes exposure compensation toward its
   * upper range (and back). Null when the platform exposes no such control
   * — callers treat it as advisory, never required.
   */
  setLowLightBoost: ((on: boolean) => Promise<void>) | null
  isLive: () => boolean
  stop: () => void
  /** Retire the session but leave the stream's tracks running (for parking). */
  detach: () => void
}

/* --- parked stream -------------------------------------------------------- */

/**
 * On platforms where re-acquiring the camera re-prompts (iOS Home-Screen
 * apps), a stopped scan session parks its live stream here for a short grace
 * window instead of ending it. Reopening the scanner inside the window —
 * closing a card sheet, hopping back from another tab — adopts the parked
 * stream: no getUserMedia, no permission dialog, no camera warm-up. iOS
 * interrupts the capture itself while the app is hidden (hardware off,
 * indicator cleared), so holding the track is cheap.
 */
const PARK_MS = 25_000

interface ParkedStream {
  stream: MediaStream
  timer: ReturnType<typeof setTimeout>
  onEnded: () => void
}

let parked: ParkedStream | null = null

function clearParked(stop: boolean): void {
  if (!parked) return
  const { stream, timer, onEnded } = parked
  parked = null
  clearTimeout(timer)
  stream.getVideoTracks()[0]?.removeEventListener('ended', onEnded)
  if (stop) for (const track of stream.getTracks()) track.stop()
}

/** The parked stream, if it's still alive — caller takes ownership. */
function adoptParked(): MediaStream | null {
  if (!parked) return null
  const stream = parked.stream
  const live = stream.getVideoTracks()[0]?.readyState === 'live'
  clearParked(!live)
  return live ? stream : null
}

/**
 * Release a camera session: an outright stop on most platforms, a short park
 * on the ones where the next acquisition would re-prompt. Torch is forced off
 * before parking — a flashlight must not outlive the scan view.
 */
export function releaseCamera(session: CameraSession): void {
  if (!CAMERA_REPROMPTS_EACH_ACQUIRE || !session.isLive()) {
    session.stop()
    return
  }
  const stream = session.stream
  const track = session.track
  track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }).catch(() => {})
  session.detach()
  clearParked(true)
  const onEnded = () => clearParked(false)
  track.addEventListener('ended', onEnded)
  parked = { stream, onEnded, timer: setTimeout(() => clearParked(true), PARK_MS) }
}

export async function startCamera(
  video: HTMLVideoElement,
  opts: { onLost?: () => void } = {},
): Promise<CameraSession> {
  const stream =
    adoptParked() ??
    (await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        // The collector line is the smallest type on a card and the whole
        // language-independent identification path reads it, so captured
        // detail is the scanner's real ceiling — at 1080p the card reaches
        // OCR about 790px wide and those digits land near 15px tall, which
        // is where the harness's soft-focus column stops resolving them.
        // `ideal` degrades to the nearest mode the device actually has, so
        // asking for more costs nothing on a camera that hasn't got it.
        width: { ideal: 2560 },
        height: { ideal: 1440 },
        // Paired deliberately with the resolution: the sense loop analyses
        // at most every 48ms, so frames past 30/s are heat and battery for
        // no accuracy, and heat is what makes a phone camera drop modes.
        frameRate: { ideal: 30 },
      },
    }))
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play().catch(() => {})
  const track = stream.getVideoTracks()[0]
  const capabilities = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    torch?: boolean
    focusMode?: string[]
    exposureMode?: string[]
    exposureCompensation?: { min?: number; max?: number; step?: number }
  }
  const setTorch = capabilities.torch
    ? (on: boolean) => track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
    : null
  // Continuous auto-exposure where the platform supports choosing it — the
  // default on phones, but explicit beats assumed.
  if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ exposureMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
  }
  // Same for focus. A card held at arm's length sits near the close end of
  // the focus range, which is exactly where a camera left on a single-shot
  // or fixed mode parks out of focus — and the scanner's focus gate then
  // patiently refuses to fire on frames the camera is never going to sharpen.
  if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
  }
  const exposure = capabilities.exposureCompensation
  const canBoost =
    exposure && typeof exposure.max === 'number' && typeof exposure.min === 'number' && exposure.max > 0
  const setLowLightBoost = canBoost
    ? (on: boolean) =>
        track
          .applyConstraints({
            advanced: [
              // Meaningful lift without blowing highlights; 0 restores auto.
              { exposureCompensation: on ? Math.min(exposure.max!, exposure.max! * 0.6) : 0 } as MediaTrackConstraintSet,
            ],
          })
          .then(() => {})
    : null
  let stopped = false
  const handleEnded = () => {
    if (!stopped) {
      stopped = true
      opts.onLost?.()
    }
  }
  track.addEventListener('ended', handleEnded)
  const detach = () => {
    stopped = true
    track.removeEventListener('ended', handleEnded)
    video.srcObject = null
  }
  return {
    stream,
    track,
    setTorch,
    setLowLightBoost,
    isLive: () => !stopped && track.readyState !== 'ended',
    stop: () => {
      detach()
      for (const t of stream.getTracks()) t.stop()
    },
    detach,
  }
}

export interface Region {
  x: number
  y: number
  w: number
  h: number
}

export interface FrameCapture {
  canvas: HTMLCanvasElement
}

/**
 * How much of the captured card to keep. Every per-frame analysis downsamples
 * to its own fixed size (192px detection, 9x8 hash, foil sample), and OCR
 * bands prep to their own target width, so this cap governs one thing only:
 * how much real detail survives for the magnified collector-line reads. At
 * 1100 a card crop is ~790px wide and the printed fraction sits at the edge
 * of legibility; 1600 carries it clear while still downscaling from a
 * 1440p-class stream rather than upsampling.
 */
export const CAPTURE_MAX_EDGE = 1600

/** Crop a region of the live video into a canvas for OCR/analysis, capped at maxEdge. */
export function captureFrame(video: HTMLVideoElement, region: Region | null, maxEdge = CAPTURE_MAX_EDGE): FrameCapture {
  const vw = video.videoWidth
  const vh = video.videoHeight
  const r = region ?? { x: 0, y: 0, w: 1, h: 1 }
  const sx = r.x * vw
  const sy = r.y * vh
  const sw = Math.max(1, r.w * vw)
  const sh = Math.max(1, r.h * vh)
  const scale = Math.min(1, maxEdge / Math.max(sw, sh))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw * scale)
  canvas.height = Math.round(sh * scale)
  canvas.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return { canvas }
}

/**
 * Low-light capture: average several video frames a beat apart. Sensor gain
 * noise is independent per frame, so the average keeps the card and divides
 * the noise by √N — the one recovery no single-frame processing can make.
 * The scanner only calls this when the scene is dark AND held still (the
 * stillness gate has already fired), so ghosting isn't a practical concern.
 */
export async function captureFrameStacked(
  video: HTMLVideoElement,
  region: Region | null,
  frames = 3,
  gapMs = 70,
  maxEdge = CAPTURE_MAX_EDGE,
): Promise<FrameCapture> {
  const first = captureFrame(video, region, maxEdge)
  if (frames <= 1) return first
  const { width, height } = first.canvas
  // Uint16 holds frames*255 (3 frames -> 765) with room to spare and costs
  // half of what a Float32 accumulator does — worth having now that the
  // capture keeps more pixels, since this buffer is the one allocation here
  // that scales with them.
  const sum = new Uint16Array(width * height * 4)
  const accumulate = (canvas: HTMLCanvasElement) => {
    const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data
    for (let i = 0; i < data.length; i++) sum[i] += data[i]
  }
  accumulate(first.canvas)
  let taken = 1
  for (let n = 1; n < frames; n++) {
    await new Promise((resolve) => setTimeout(resolve, gapMs))
    // The camera can die mid-stack (backgrounded, another app) — average
    // what was actually captured rather than failing the attempt.
    if (video.videoWidth === 0) break
    accumulate(captureFrame(video, region, maxEdge).canvas)
    taken++
  }
  if (taken > 1) {
    const ctx = first.canvas.getContext('2d', { willReadFrequently: true })!
    const image = ctx.getImageData(0, 0, width, height)
    for (let i = 0; i < image.data.length; i++) image.data[i] = sum[i] / taken
    ctx.putImageData(image, 0, 0)
  }
  return first
}

/**
 * Decode a picked photo (or a kept crop) to a canvas at capture resolution.
 *
 * The scan pipeline never sees a file — it sees the same thing a live capture
 * hands it, at the same scale. Everything downstream is calibrated for that:
 * band prep widths, the 192px detection buffer, and above all the magnified
 * collector-line reads, which is why CAPTURE_MAX_EDGE exists at all. An image
 * left at its native 4032px would not be "better input", it would be input the
 * pipeline has never been measured on.
 *
 * EXIF orientation is honoured. A phone stores a portrait photo as landscape
 * pixels plus a rotation tag, and ignoring it would hand the pipeline a
 * quarter-turned card — pushing an ordinary upload down the sideways path,
 * which pays two full name ladders before it can answer.
 */
export async function decodeImage(src: Blob | string, maxEdge = CAPTURE_MAX_EDGE): Promise<HTMLCanvasElement> {
  const bitmap = await loadBitmap(src)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height)
  if ('close' in bitmap) bitmap.close()
  return canvas
}

async function loadBitmap(src: Blob | string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof src !== 'string' && typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(src, { imageOrientation: 'from-image' })
    } catch {
      /* Safari < 17 has no imageOrientation option — fall through to <img>,
       * which applies EXIF itself. */
    }
  }
  const url = typeof src === 'string' ? src : URL.createObjectURL(src)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error("That image couldn't be read"))
      img.src = url
    })
  } finally {
    if (typeof src !== 'string') setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
