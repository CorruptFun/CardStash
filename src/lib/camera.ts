export interface CameraSession {
  stream: MediaStream
  track: MediaStreamTrack
  setTorch: ((on: boolean) => Promise<void>) | null
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
  return {
    stream,
    track,
    setTorch,
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
