import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '../lib/analytics'
import { captureFrame, startCamera, type CameraSession, type Region } from '../lib/camera'
import { isAbort } from '../lib/fetchJson'
import { identifyFrame, type IdentifyOutcome, type ScanMode } from '../lib/identify'
import { stopOcr } from '../lib/ocr'
import { analyzeFrame, frameHash } from '../lib/vision'

/* Scanner tuning */
const SENSE_WIDTH = 288
const MOTION_STILL = 7.5
const STILL_DELAY_SENSING_MS = 360
const STILL_DELAY_BLIND_MS = 950
const RETRY_MIN_GAP_MS = 1600
const RETRY_MAX_GAP_MS = 60_000

interface ApiFailurePolicy {
  waitMs: number
  autoRetry: boolean
  detail: string
}

function apiFailurePolicy(outcome: Extract<IdentifyOutcome, { ok: false }>, consecutive: number): ApiFailurePolicy {
  const waitMs = Math.min(RETRY_MAX_GAP_MS, RETRY_MIN_GAP_MS * 2 ** Math.max(0, consecutive - 1))
  const seconds = Math.round(waitMs / 1000)
  const message = outcome.message.replace(/[.\s]+$/, '')
  return { waitMs, autoRetry: true, detail: `${message} (retrying in ${seconds}s)` }
}

/** One in-flight identification; superseded runs may not report. */
class ScanJob {
  private gen = 0
  private ctrl: AbortController | null = null
  running = false

  cancel(): void {
    this.gen++
    this.ctrl?.abort(new DOMException('Scanner stopped', 'AbortError'))
    this.ctrl = null
    this.running = false
  }

  async run(
    work: (signal: AbortSignal) => Promise<IdentifyOutcome>,
    report: {
      outcome: (outcome: IdentifyOutcome) => void
      error: (err: unknown) => void
      settled: () => void
    },
  ): Promise<void> {
    if (this.running) return
    const gen = ++this.gen
    const ctrl = new AbortController()
    this.ctrl = ctrl
    this.running = true
    const current = () => gen === this.gen
    try {
      const outcome = await work(ctrl.signal)
      if (current()) report.outcome(outcome)
    } catch (err) {
      if (current() && !isAbort(err)) report.error(err)
    } finally {
      if (current()) {
        this.running = false
        this.ctrl = null
        report.settled()
      }
    }
  }
}

/** Fallback capture region: a card-shaped window centered in frame. */
function reticleRegion(videoWidth: number, videoHeight: number): Region {
  const CARD_ASPECT = 63 / 88
  let h = videoHeight * 0.8
  let w = h * CARD_ASPECT
  if (w > videoWidth * 0.92) {
    w = videoWidth * 0.92
    h = w / CARD_ASPECT
  }
  return {
    x: (1 - w / videoWidth) / 2,
    y: Math.max(0, 0.47 - h / videoHeight / 2),
    w: w / videoWidth,
    h: h / videoHeight,
  }
}

/** Packs/boxes aren't card-shaped — capture a wide centered window instead. */
function sealedRegion(): Region {
  return { x: 0.04, y: 0.1, w: 0.92, h: 0.74 }
}

interface FailureState {
  consecutive: number
  waitMs: number
  autoRetry: boolean
  detail: string
}

const freshFailureState = (): FailureState => ({ consecutive: 0, waitMs: 0, autoRetry: true, detail: '' })

export type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'searching'
  | 'locking'
  | 'thinking'
  | 'found'
  | 'nomatch'
  | 'paused'
  | 'denied'
  | 'unsupported'
  | 'error'

export interface ScannerState {
  status: ScannerStatus
  sensing: boolean
  hit: Extract<IdentifyOutcome, { ok: true }> | null
  miss: Extract<IdentifyOutcome, { ok: false }> | null
  detail: string | null
  torchAvailable: boolean
  torchOn: boolean
  needsResume: boolean
}

export const ACTIVE_SCAN_STATUSES: ScannerStatus[] = ['searching', 'locking', 'thinking', 'found', 'nomatch']

export function useScanner(onHit: (hit: Extract<IdentifyOutcome, { ok: true }>) => void, mode: ScanMode = 'card') {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const modeRef = useRef(mode)
  modeRef.current = mode
  const sessionRef = useRef<CameraSession | null>(null)
  const rafRef = useRef(0)
  const jobRef = useRef<ScanJob | null>(null)
  jobRef.current ??= new ScanJob()
  const stillSinceRef = useRef<number | null>(null)
  const lastAttemptRef = useRef(0)
  const failureRef = useRef<FailureState>(freshFailureState())
  const prevGrayRef = useRef<Uint8ClampedArray | null>(null)
  const regionStreakRef = useRef(0)
  const senseCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const wantsCameraRef = useRef(false)
  const startingRef = useRef(false)
  const onHitRef = useRef(onHit)
  onHitRef.current = onHit

  const [state, setState] = useState<ScannerState>({
    status: 'idle',
    sensing: false,
    hit: null,
    miss: null,
    detail: null,
    torchAvailable: false,
    torchOn: false,
    needsResume: false,
  })
  const [busy, setBusy] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const patch = useCallback((partial: Partial<ScannerState>) => {
    setState((prev) => ({ ...prev, ...partial }))
  }, [])

  const teardown = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    jobRef.current?.cancel()
    setBusy(false)
    sessionRef.current?.stop()
    sessionRef.current = null
    prevGrayRef.current = null
    regionStreakRef.current = 0
    stillSinceRef.current = null
    stopOcr()
    patch({ torchAvailable: false, torchOn: false })
  }, [patch])

  const stop = useCallback(() => {
    wantsCameraRef.current = false
    teardown()
    patch({ status: 'idle', sensing: false, needsResume: false })
  }, [patch, teardown])

  const handleLost = useCallback(() => {
    if (sessionRef.current) {
      teardown()
      patch({
        status: 'paused',
        sensing: false,
        needsResume: true,
        detail: 'The camera stopped — another app may have taken it.',
      })
    }
  }, [patch, teardown])

  const senseLoop = useCallback(() => {
    const video = videoRef.current
    const session = sessionRef.current
    if (!session) {
      rafRef.current = 0
      return
    }
    if (!session.isLive()) {
      rafRef.current = 0
      handleLost()
      return
    }
    if (!video || video.videoWidth === 0) {
      rafRef.current = requestAnimationFrame(senseLoop)
      return
    }
    const vw = video.videoWidth
    const vh = video.videoHeight
    const sw = SENSE_WIDTH
    const sh = Math.round((vh / vw) * SENSE_WIDTH)
    if (!senseCtxRef.current) {
      const canvas = document.createElement('canvas')
      senseCtxRef.current = canvas.getContext('2d', { willReadFrequently: true })
    }
    const ctx = senseCtxRef.current!
    if (ctx.canvas.width !== sw || ctx.canvas.height !== sh) {
      ctx.canvas.width = sw
      ctx.canvas.height = sh
    }
    ctx.drawImage(video, 0, 0, sw, sh)
    let analysis
    try {
      analysis = analyzeFrame(ctx.getImageData(0, 0, sw, sh), prevGrayRef.current)
    } catch {
      rafRef.current = requestAnimationFrame(senseLoop)
      return
    }
    prevGrayRef.current = analysis.gray
    regionStreakRef.current = analysis.region
      ? Math.min(6, regionStreakRef.current + 1)
      : Math.max(0, regionStreakRef.current - 1)
    const sensing = regionStreakRef.current >= 3
    const prev = stateRef.current
    const now = performance.now()
    const still = analysis.motion < MOTION_STILL
    const updates: Partial<ScannerState> = {}
    if (sensing !== prev.sensing) updates.sensing = sensing

    const jobRunning = jobRef.current?.running ?? false
    const scanState =
      prev.status === 'searching' || prev.status === 'locking' || prev.status === 'nomatch' || prev.status === 'found'
    if (!jobRunning && scanState) {
      if (still) {
        stillSinceRef.current ??= now
        const heldLongEnough = now - stillSinceRef.current > (sensing ? STILL_DELAY_SENSING_MS : STILL_DELAY_BLIND_MS)
        const failure = failureRef.current
        const minGap = Math.max(RETRY_MIN_GAP_MS, failure.waitMs)
        if (heldLongEnough && failure.autoRetry && now - lastAttemptRef.current > minGap && prev.status !== 'found') {
          attempt()
        } else if (prev.status === 'searching' && sensing) {
          updates.status = 'locking'
        }
      } else {
        stillSinceRef.current = null
        if (prev.status !== 'searching' && analysis.motion > MOTION_STILL * 2.5) {
          updates.status = 'searching'
          updates.hit = prev.status === 'found' && sensing ? prev.hit : null
          updates.miss = null
          updates.detail = null
        }
      }
    }
    if (Object.keys(updates).length) patch(updates)
    rafRef.current = requestAnimationFrame(senseLoop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch])

  const attempt = useCallback(
    async (manual = false) => {
      const video = videoRef.current
      const job = jobRef.current!
      if (!video || !video.videoWidth || job.running) return
      setBusy(true)
      lastAttemptRef.current = performance.now()
      patch({ status: 'thinking', miss: null, detail: null })
      const mode = modeRef.current
      const region = mode === 'sealed' ? sealedRegion() : reticleRegion(video.videoWidth, video.videoHeight)
      const capture = captureFrame(video, region)
      const hash = frameHash(capture.canvas)
      const startedAt = performance.now()
      await job.run(() => identifyFrame(capture, hash, { ignoreMisses: manual, mode }), {
        outcome: (outcome) => {
          track('scan_attempt', {
            engine: outcome.ok ? outcome.identification.via : outcome.reason === 'cached-miss' ? 'cache' : 'ocr',
            outcome: outcome.ok ? 'hit' : 'miss',
            ...(outcome.ok ? {} : { reason: outcome.reason }),
            ...(outcome.ok && outcome.identification.foil != null ? { foil: outcome.identification.foil } : {}),
            ...(outcome.ok && outcome.identification.number != null ? { edition: true } : {}),
            mode,
            ms: Math.round(performance.now() - startedAt),
            manual,
          })
          if (outcome.ok) {
            failureRef.current = freshFailureState()
            patch({ status: 'found', hit: outcome, miss: null, detail: null })
            onHitRef.current(outcome)
          } else if (outcome.reason === 'api') {
            const consecutive = failureRef.current.consecutive + 1
            const policy = apiFailurePolicy(outcome, consecutive)
            failureRef.current = { consecutive, ...policy }
            patch({ status: 'nomatch', miss: outcome, detail: policy.detail })
          } else if (outcome.reason === 'cached-miss' && !manual) {
            failureRef.current = freshFailureState()
            patch({ status: 'searching' })
          } else {
            failureRef.current = freshFailureState()
            patch({ status: 'nomatch', miss: outcome, detail: outcome.message })
          }
        },
        error: (err: any) => {
          patch({ status: 'nomatch', miss: null, detail: err.message?.slice(0, 120) ?? 'Identification failed' })
        },
        settled: () => {
          setBusy(false)
          stillSinceRef.current = null
        },
      })
    },
    [patch],
  )

  const start = useCallback(async () => {
    if (sessionRef.current || startingRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      patch({ status: 'unsupported', detail: 'Camera requires HTTPS and a modern browser' })
      return
    }
    const video = videoRef.current
    if (!video) return
    wantsCameraRef.current = true
    startingRef.current = true
    failureRef.current = freshFailureState()
    patch({ status: 'starting', detail: null, needsResume: false })
    try {
      const session = await startCamera(video, { onLost: handleLost })
      if (!wantsCameraRef.current) {
        session.stop()
        return
      }
      sessionRef.current = session
      patch({ status: 'searching', torchAvailable: session.setTorch != null })
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(senseLoop)
    } catch (err: any) {
      wantsCameraRef.current = false
      patch({
        status: err?.name === 'NotAllowedError' ? 'denied' : 'error',
        detail:
          err?.name === 'NotAllowedError'
            ? 'Camera permission was denied. Enable it in your browser settings.'
            : (err?.message ?? 'Could not start the camera'),
      })
    } finally {
      startingRef.current = false
    }
  }, [handleLost, patch, senseLoop])

  const toggleTorch = useCallback(async () => {
    const session = sessionRef.current
    if (!session?.setTorch) return
    const next = !stateRef.current.torchOn
    try {
      await session.setTorch(next)
      patch({ torchOn: next })
    } catch {
      patch({ torchAvailable: false })
    }
  }, [patch])

  const dismissHit = useCallback(() => {
    patch({ hit: null, miss: null, status: 'searching' })
  }, [patch])

  const rescan = useCallback(() => {
    lastAttemptRef.current = 0
    stillSinceRef.current = null
    failureRef.current = freshFailureState()
    patch({ hit: null, miss: null, status: 'searching', detail: null })
  }, [patch])

  const scanNow = useCallback(() => {
    if (jobRef.current?.running || !sessionRef.current) return
    lastAttemptRef.current = 0
    stillSinceRef.current = null
    failureRef.current = freshFailureState()
    attempt(true)
  }, [attempt])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (sessionRef.current && wantsCameraRef.current) {
          teardown()
          patch({ status: 'paused', sensing: false, needsResume: false })
        }
      } else if (wantsCameraRef.current && !sessionRef.current) {
        start()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [patch, start, teardown])

  useEffect(() => stop, [stop])

  return { ...state, busy, videoRef, start, stop, toggleTorch, dismissHit, rescan, scanNow }
}
