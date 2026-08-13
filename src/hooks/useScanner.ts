import { useCallback, useEffect, useRef, useState } from 'react'
import { track } from '../lib/analytics'
import {
  captureFrame,
  captureFrameStacked,
  releaseCamera,
  startCamera,
  type CameraSession,
  type Region,
} from '../lib/camera'
import { isAbort } from '../lib/fetchJson'
import { identifyFrame, type IdentifyOutcome, type ScanMode } from '../lib/identify'
import { stopOcr, warmOcr } from '../lib/ocr'
import { analyzeFrame, frameHash } from '../lib/vision'

/* Scanner tuning */
const SENSE_WIDTH = 288
const MOTION_STILL = 7.5
const STILL_DELAY_SENSING_MS = 360
const STILL_DELAY_BLIND_MS = 950
const RETRY_MIN_GAP_MS = 1600
const RETRY_MAX_GAP_MS = 60_000
/** Focus gate: capture only near the recent sharpness peak (autofocus hunts
 * right after motion stops), with a floor for flat scenes and a hard cap so
 * the gate can never stall the scanner. */
const FOCUS_RATIO = 0.62
const FOCUS_FLOOR = 6
const FOCUS_WAIT_MAX_MS = 1200
/** Sharpness-peak half-life in ms — time-based, so 120Hz displays decay the
 * same as 60Hz ones. */
const FOCUS_PEAK_HALFLIFE_MS = 750
/** Frame-analysis cadence; display refresh above this is wasted heat. */
const SENSE_MIN_INTERVAL_MS = 48
/**
 * How long after the app hides before a still-capturing camera is released.
 * Platforms that suspend capture for hidden pages (iOS/Safari mute the track
 * within a moment, hardware off) keep the session — resuming then needs no
 * getUserMedia, which on iOS Home-Screen apps means no fresh permission
 * prompt. Platforms that keep capturing in the background fail the probe and
 * release the camera for privacy, exactly as before.
 */
const HIDDEN_CAMERA_PROBE_MS = 2_000
/** Below this mean luma the scene counts as dark: captures stack frames,
 * and a sustained streak turns on what light the platform offers. */
const DARK_LUMA = 58
/** Scene must stay dark this long before the scanner reaches for the torch —
 * a hand shadow passing over the card must not strobe the flash. */
const DARK_STREAK_TORCH_MS = 2200
/** Bright again this long → release the exposure boost. */
const BRIGHT_RELEASE_MS = 1500

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
  /** The scanner turned the torch on itself (dark scene); cleared when off. */
  autoTorch: boolean
  /** The scene is currently too dark for comfortable reading. */
  lowLight: boolean
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
  /** Focus tracking: rolling sharpness peak + how long the gate has blocked. */
  const focusRef = useRef({ max: 0, blockedSince: 0 })
  const lastSenseRef = useRef(0)
  /** Light adaptation: latest luma, dark/bright streak starts, torch etiquette. */
  const lightRef = useRef({ luma: 255, darkSince: 0, brightSince: 0, boosted: false, torchDeclined: false })
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
    autoTorch: false,
    lowLight: false,
    needsResume: false,
  })
  const [busy, setBusy] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const patch = useCallback((partial: Partial<ScannerState>) => {
    setState((prev) => ({ ...prev, ...partial }))
  }, [])

  const hiddenProbeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Halt the scanning work — loops, in-flight job, OCR — but not the camera. */
  const suspendWork = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    jobRef.current?.cancel()
    setBusy(false)
    prevGrayRef.current = null
    regionStreakRef.current = 0
    stillSinceRef.current = null
    focusRef.current = { max: 0, blockedSince: 0 }
    // Torch etiquette survives camera restarts; the streaks don't.
    lightRef.current = { ...lightRef.current, luma: 255, darkSince: 0, brightSince: 0, boosted: false }
    stopOcr()
  }, [])

  /**
   * Let go of the camera session. `park` hands a live stream to
   * releaseCamera's grace window (iOS Home-Screen apps re-prompt on every
   * re-acquisition, so quick hops back shouldn't need one); false is an
   * outright stop — used when the platform kept capturing while hidden.
   */
  const releaseSession = useCallback(
    (park: boolean) => {
      if (hiddenProbeRef.current) {
        clearTimeout(hiddenProbeRef.current)
        hiddenProbeRef.current = null
      }
      const session = sessionRef.current
      if (!session) return
      sessionRef.current = null
      if (park) releaseCamera(session)
      else session.stop()
      patch({ torchAvailable: false, torchOn: false })
    },
    [patch],
  )

  const teardown = useCallback(
    (park = false) => {
      suspendWork()
      releaseSession(park)
    },
    [releaseSession, suspendWork],
  )

  const stop = useCallback(() => {
    wantsCameraRef.current = false
    teardown(true)
    patch({ status: 'idle', sensing: false, needsResume: false })
  }, [patch, teardown])

  const handleLost = useCallback(() => {
    if (!sessionRef.current) return
    teardown()
    if (document.hidden && wantsCameraRef.current) {
      // Died in the background (iOS reclaims capture aggressively): restart
      // silently when the app returns instead of gating on a Resume tap.
      patch({ status: 'paused', sensing: false, needsResume: false })
    } else {
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
    // Sensing at ~20fps reads the scene just as well as at display refresh —
    // running the Sobel pass at 120Hz would only heat the phone.
    const sinceLast = performance.now() - lastSenseRef.current
    if (sinceLast < SENSE_MIN_INTERVAL_MS) {
      rafRef.current = requestAnimationFrame(senseLoop)
      return
    }
    lastSenseRef.current = performance.now()
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
    // Decaying peak: after a scene change the old peak fades within ~a
    // second, so the gate below always compares against CURRENT conditions.
    // Time-based, so the sensing cadence doesn't change the decay rate.
    const decay = Math.pow(0.5, sinceLast / FOCUS_PEAK_HALFLIFE_MS)
    focusRef.current.max = Math.max(analysis.sharpness, focusRef.current.max * decay)
    regionStreakRef.current = analysis.region
      ? Math.min(6, regionStreakRef.current + 1)
      : Math.max(0, regionStreakRef.current - 1)
    const sensing = regionStreakRef.current >= 3
    const prev = stateRef.current
    const now = performance.now()
    const still = analysis.motion < MOTION_STILL
    const updates: Partial<ScannerState> = {}
    if (sensing !== prev.sensing) updates.sensing = sensing

    // Light adaptation: track dark/bright streaks; after a sustained dark
    // streak reach for what the platform offers (exposure boost, then the
    // torch — once, and never again if the user turns it back off).
    const light = lightRef.current
    light.luma = analysis.luma
    const dark = analysis.luma < DARK_LUMA
    if (dark) {
      light.darkSince ||= now
      light.brightSince = 0
    } else {
      light.darkSince = 0
      if (analysis.luma > DARK_LUMA + 30) light.brightSince ||= now
      else light.brightSince = 0
    }
    if (prev.lowLight !== dark) updates.lowLight = dark
    if (dark && light.darkSince && now - light.darkSince > DARK_STREAK_TORCH_MS) {
      if (!light.boosted && session.setLowLightBoost) {
        light.boosted = true
        session.setLowLightBoost(true).catch(() => {})
      }
      if (session.setTorch && !prev.torchOn && !light.torchDeclined) {
        session
          .setTorch(true)
          .then(() => patch({ torchOn: true, autoTorch: true }))
          // A torch that refuses is a torch we stop asking for — otherwise
          // this retries every couple of seconds for the whole session.
          .catch(() => {
            light.torchDeclined = true
          })
        light.darkSince = now // don't re-fire every frame while it ramps
      }
    } else if (light.boosted && light.brightSince && now - light.brightSince > BRIGHT_RELEASE_MS) {
      light.boosted = false
      session.setLowLightBoost?.(false).catch(() => {})
    }

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
          // Focus gate: phones hunt focus right after motion stops, and a
          // frame grabbed mid-hunt is smeared before OCR ever sees it. Wait
          // for sharpness near the rolling peak — briefly: a hard cap keeps
          // low-texture scenes from stalling the scanner.
          const focus = focusRef.current
          const focused = analysis.sharpness >= Math.max(FOCUS_FLOOR, focus.max * FOCUS_RATIO)
          if (!focused && !focus.blockedSince) focus.blockedSince = now
          if (focused || now - focus.blockedSince > FOCUS_WAIT_MAX_MS) {
            focus.blockedSince = 0
            attempt()
          }
        } else if (prev.status === 'searching' && sensing) {
          updates.status = 'locking'
        }
      } else {
        stillSinceRef.current = null
        focusRef.current.blockedSince = 0
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
      // Dark scene: average a short burst of frames — sensor noise is
      // independent per frame, so the stack recovers what no single-frame
      // processing can. The stillness gate already fired, so no ghosting.
      const capture =
        mode === 'card' && lightRef.current.luma < DARK_LUMA
          ? await captureFrameStacked(video, region)
          : captureFrame(video, region)
      // The stack awaited ~140ms — the scanner may have been stopped or the
      // video may have dropped out since. Hand the loop back to 'searching'
      // rather than stranding the chip on "Identifying…" (a teardown, which
      // sets its own status, wins the patch that follows anyway).
      if (!video.videoWidth || !sessionRef.current) {
        setBusy(false)
        if (sessionRef.current) patch({ status: 'searching' })
        return
      }
      const hash = frameHash(capture.canvas)
      const startedAt = performance.now()
      await job.run((signal) => identifyFrame(capture, hash, { ignoreMisses: manual, mode, signal }), {
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
    if (sessionRef.current) return
    if (!navigator.mediaDevices?.getUserMedia) {
      patch({ status: 'unsupported', detail: 'Camera requires HTTPS and a modern browser' })
      return
    }
    const video = videoRef.current
    if (!video) return
    wantsCameraRef.current = true
    // A start while another start's getUserMedia is still pending must not be
    // dropped: re-arming the flag above makes the in-flight one keep its
    // stream instead of discarding it (stop→start races, dev double-mount).
    if (startingRef.current) return
    startingRef.current = true
    failureRef.current = freshFailureState()
    // The OCR worker (re)initializes while the permission prompt / camera
    // warm-up runs, so the first frame doesn't pay for it.
    warmOcr()
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

  /** Pick scanning back up on a camera session that stayed alive. */
  const resumeScanning = useCallback(() => {
    const session = sessionRef.current
    if (!session?.isLive()) return false
    videoRef.current?.play().catch(() => {})
    warmOcr()
    failureRef.current = freshFailureState()
    patch({ status: 'searching', needsResume: false, detail: null, miss: null })
    cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(senseLoop)
    return true
  }, [patch, senseLoop])

  const toggleTorch = useCallback(async () => {
    const session = sessionRef.current
    if (!session?.setTorch) return
    const next = !stateRef.current.torchOn
    // Turning OFF a torch the scanner lit is an answer: don't auto-light it
    // again this session.
    if (!next && stateRef.current.autoTorch) lightRef.current.torchDeclined = true
    try {
      await session.setTorch(next)
      patch({ torchOn: next, autoTorch: next ? stateRef.current.autoTorch : false })
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
    focusRef.current.blockedSince = 0
    failureRef.current = freshFailureState()
    patch({ hit: null, miss: null, status: 'searching', detail: null })
  }, [patch])

  const scanNow = useCallback(() => {
    if (jobRef.current?.running || !sessionRef.current) return
    lastAttemptRef.current = 0
    stillSinceRef.current = null
    focusRef.current.blockedSince = 0
    failureRef.current = freshFailureState()
    attempt(true)
  }, [attempt])

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (sessionRef.current && wantsCameraRef.current) {
          // Stop the work, keep the camera: platforms that suspend capture
          // for hidden pages (iOS mutes the track, hardware off) hand the
          // same track back on return — no getUserMedia, and on iOS
          // Home-Screen apps no fresh permission prompt. A probe releases
          // the camera on platforms that keep capturing in the background.
          suspendWork()
          patch({ status: 'paused', sensing: false, needsResume: false })
          if (hiddenProbeRef.current) clearTimeout(hiddenProbeRef.current)
          hiddenProbeRef.current = setTimeout(() => {
            hiddenProbeRef.current = null
            const session = sessionRef.current
            if (document.hidden && session && !session.track.muted) releaseSession(false)
          }, HIDDEN_CAMERA_PROBE_MS)
        }
      } else {
        if (hiddenProbeRef.current) {
          clearTimeout(hiddenProbeRef.current)
          hiddenProbeRef.current = null
        }
        if (wantsCameraRef.current && !resumeScanning()) {
          releaseSession(false)
          start()
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [patch, releaseSession, resumeScanning, start, suspendWork])

  useEffect(() => stop, [stop])

  return { ...state, busy, videoRef, start, stop, toggleTorch, dismissHit, rescan, scanNow }
}
