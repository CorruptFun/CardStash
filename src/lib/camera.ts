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
}

export async function startCamera(
  video: HTMLVideoElement,
  opts: { onLost?: () => void } = {},
): Promise<CameraSession> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  })
  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  video.muted = true
  await video.play().catch(() => {})
  const track = stream.getVideoTracks()[0]
  const capabilities = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    torch?: boolean
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
  return {
    stream,
    track,
    setTorch,
    setLowLightBoost,
    isLive: () => !stopped && track.readyState !== 'ended',
    stop: () => {
      stopped = true
      track.removeEventListener('ended', handleEnded)
      for (const t of stream.getTracks()) t.stop()
      video.srcObject = null
    },
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
  maxEdge = 1100,
): Promise<FrameCapture> {
  const first = captureFrame(video, region, maxEdge)
  if (frames <= 1) return first
  const { width, height } = first.canvas
  const sum = new Float32Array(width * height * 4)
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
