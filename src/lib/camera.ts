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
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    }))
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play().catch(() => {})
  const track = stream.getVideoTracks()[0]
  const capabilities = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean }
  const setTorch = capabilities.torch
    ? (on: boolean) => track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
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

/** Crop a region of the live video into a canvas for OCR/analysis, capped at maxEdge. */
export function captureFrame(video: HTMLVideoElement, region: Region | null, maxEdge = 1100): FrameCapture {
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
