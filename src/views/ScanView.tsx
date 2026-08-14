import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from '../components/Icon'
import { BinderReview } from '../components/BinderReview'
import { CardImg, Seg } from '../components/basics'
import { ScanDebugPanel } from '../components/ScanDebug'
import { ACTIVE_SCAN_STATUSES, useScanner, type ScannerStatus } from '../hooks/useScanner'
import { track } from '../lib/analytics'
import {
  CAMERA_REPROMPTS_EACH_ACQUIRE,
  CAPTURE_MAX_EDGE,
  cameraPermissionState,
  decodeImage,
  IS_STANDALONE,
} from '../lib/camera'
import { addToCollection, clearScans, db, recordScan, removeCopies, removeScan, restoreScans } from '../lib/db'
import { FINISH_LABEL, finishOptions, GAME_SHORT } from '../lib/games'
import { isEntitled } from '../lib/entitlement'
import { identifyFrame, type IdentifyOutcome, type ScanMode } from '../lib/identify'
import { MAX_PAGE_CARDS, PAGE_MAX_EDGE, scanPage, type PageCard, type PageScanProgress } from '../lib/multiscan'
import { warmOcr } from '../lib/ocr'
import { itemUnitPrice, scannedFinish } from '../lib/prices'
import { warmSealedIndex } from '../lib/sealed'
import { settings, useSettings } from '../lib/settings'
import { warmCatalog } from '../lib/tcgcsv'
import type { Card, Finish, ScanRecord } from '../lib/types'
import { haptic, money } from '../lib/util'
import { frameHash } from '../lib/vision'
import { guarded, uiStore, useUi } from '../store/ui'

/**
 * The finish the physical copy most likely has: the scanner's foil reading
 * when it has one, otherwise the printing's headline finish (which also files
 * foil-only printings as foil rather than "Normal").
 */
function scanFinish(hit: Extract<IdentifyOutcome, { ok: true }>): Finish {
  return scannedFinish(hit.card, hit.identification.foil)
}

/**
 * iOS camera-permission reality, in two flavors:
 * - Safari tab: asks per visit BY DEFAULT, but aA → Website Settings →
 *   Camera → Allow persists the grant for good.
 * - Home Screen app: asks again on each fresh launch, and there is NO
 *   setting anywhere to persist it — an Apple limitation. Cardstock softens
 *   it by keeping the camera session alive across quick switches
 *   (see releaseCamera in lib/camera.ts), but a cold launch always re-asks.
 */
const IOS_BROWSER =
  typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent) && !IS_STANDALONE
const IOS_PWA = CAMERA_REPROMPTS_EACH_ACQUIRE

/** Collect mode: dedupe rapid re-scans of the same card. */
const REPEAT_WINDOW_MS = 2500

class CollectQueue {
  private recent: { cardId: string; at: number } | null = null

  async hit(card: Card, finish: Finish): Promise<void> {
    const last = this.recent
    if (last?.cardId === card.id && Date.now() - last.at < REPEAT_WINDOW_MS) {
      uiStore.getState().toast(`Skipped a repeat of ${card.name}`, 'info', {
        label: 'Add anyway',
        fn: () => {
          this.add(card, finish)
        },
      })
      return
    }
    await this.add(card, finish)
  }

  private async add(card: Card, finish: Finish): Promise<void> {
    const item = await guarded(() => addToCollection(card, { finish }), 'Add')
    if (!item) return
    // Marked only AFTER the write lands — a quota failure must not make the
    // retry read as "repeat" and get skipped.
    this.recent = { cardId: card.id, at: Date.now() }
    track('card_added', { game: card.game, source: 'scan' })
    // Price the copy that was actually filed (finish-specific).
    const probe = { finish, condition: 'NM' as const, qty: 1, card }
    const label = finish === 'nonfoil' ? '' : ` ${FINISH_LABEL[finish].toLowerCase()}`
    uiStore.getState().toast(`+1 ${card.name}${label} · ${money(itemUnitPrice(probe))}`, 'success', {
      label: 'Undo',
      fn: () => {
        guarded(() => removeCopies(item.id, 1), 'Undo')
      },
    })
  }
}

function ScanChip({
  status,
  hit,
  finish,
  foilAuto,
  onCycleFinish,
  onOpen,
  detail,
  onSearch,
  onRetry,
  onDetails,
}: {
  status: ScannerStatus
  hit: Extract<IdentifyOutcome, { ok: true }> | null
  finish: Finish | null
  /** The finish came from the on-device foil detector, not a manual tap. */
  foilAuto: boolean
  onCycleFinish: () => void
  onOpen: () => void
  detail: string | null
  onSearch: (() => void) | null
  onRetry: () => void
  onDetails: () => void
}) {
  if (status === 'found' && hit && finish) {
    const card = hit.card
    // Price the finish that's actually in frame — a scanned foil shows the
    // foil number, not the plain one.
    const probe = { finish, condition: 'NM' as const, qty: 1, card }
    const cyclable = !card.sealed && finishOptions(card).length > 1
    return (
      <>
        <button className="chip chip--found" onClick={onOpen}>
          <span className="chip__price">{money(itemUnitPrice(probe))}</span>
          <span className="chip__meta">
            <span className="chip__name">{card.name}</span>
            <span className="chip__set">
              {card.setCode}
              {card.number ? ` · ${card.number}` : ''}
            </span>
          </span>
          <Icon name="chevronRight" size={16} className="chip__go" />
        </button>
        {cyclable && (
          <button
            className={`finishpill ${finish !== 'nonfoil' ? 'finishpill--premium' : ''}`}
            onClick={onCycleFinish}
            aria-label="Change finish"
          >
            <Icon name="sparkle" size={12} />
            {FINISH_LABEL[finish]}
            {foilAuto && finish !== 'nonfoil' ? <em>auto</em> : null}
          </button>
        )}
      </>
    )
  }
  if (status === 'thinking') {
    return (
      <div className="chip chip--thinking">
        <span className="chip__spinner" />
        <span className="chip__label">Identifying…</span>
      </div>
    )
  }
  if (status === 'nomatch') {
    return (
      <div className="chip chip--nomatch">
        <span className="chip__missbody">
          <span className="chip__label">{detail ?? 'No match — try filling the frame'}</span>
          <span className="chip__missactions">
            <button className="chip__searchbtn" onClick={onRetry}>
              <Icon name="refresh" size={13} /> Try again
            </button>
            {onSearch && (
              <button className="chip__searchbtn" onClick={onSearch}>
                <Icon name="search" size={13} /> Search it instead
              </button>
            )}
            <button className="chip__searchbtn chip__searchbtn--icon" onClick={onDetails} aria-label="What did the scanner see?">
              <Icon name="eye" size={14} />
            </button>
          </span>
        </span>
      </div>
    )
  }
  return null
}

/**
 * Photo upload. Subtle on purpose — the camera is the primary path and this is
 * the fallback for a card already photographed, a page shot earlier, or a
 * phone whose camera the user won't grant.
 *
 * This is one of the two ENTRY POINTS the planned paid tier would gate (see
 * lib/entitlement.ts): the gate belongs here and on the page-scan path, never
 * on the detector underneath, which free single-card scanning also depends on.
 */
function UploadButton({ busy, onPick, wide = false }: { busy: boolean; onPick: () => void; wide?: boolean }) {
  if (!isEntitled('photo-upload')) return null
  if (wide) {
    return (
      <button className="btn btn--ghost" onClick={onPick} disabled={busy}>
        <Icon name="upload" size={16} /> {busy ? 'Reading…' : 'Upload a photo instead'}
      </button>
    )
  }
  return (
    <button className="iconbtn iconbtn--glass" onClick={onPick} disabled={busy} aria-label="Scan a photo from your library">
      {busy ? <span className="chip__spinner" /> : <Icon name="upload" size={18} />}
    </button>
  )
}

export function ScanView({ active }: { active: boolean }) {
  const openSheet = useUi((s) => s.openSheet)
  const toast = useUi((s) => s.toast)
  const setSearchPrefill = useUi((s) => s.setSearchPrefill)
  const sheetOpen = useUi((s) => s.sheet != null)
  const config = useSettings()
  const collectRef = useRef<CollectQueue | null>(null)
  collectRef.current ??= new CollectQueue()
  /** Skip the start gate on launches after the camera was approved once. */
  const [started, setStarted] = useState(() => settings().cameraApproved)
  /** True only when the user tapped Start this session (vs a silent auto-start). */
  const manualStartRef = useRef(false)
  /** Cards vs sealed products (packs, boxes, bundles). */
  const [scanMode, setScanMode] = useState<ScanMode>('card')
  /** Manual finish pick on the chip, per identified card. */
  const [finishPick, setFinishPick] = useState<{ id: string; finish: Finish } | null>(null)
  /** The "what did the scanner see" diagnostics overlay. */
  const [debugOpen, setDebugOpen] = useState(false)
  /**
   * Page mode: one tap reads EVERY card in the frame instead of the one in the
   * reticle. Explicitly a mode rather than something the scanner infers,
   * because a page scan costs ~9 identifications and must never fire on its
   * own — see runPageScan.
   */
  const [pageMode, setPageMode] = useState(false)
  /** Non-null while a page scan is running: {done, total} for the overlay. */
  const [pageProgress, setPageProgress] = useState<PageScanProgress | null>(null)
  /** The finished page, waiting on the review screen. Nothing is added until then. */
  const [pageCards, setPageCards] = useState<PageCard[] | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const pageAbortRef = useRef<AbortController | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const onHit = useCallback(
    (hit: Extract<IdentifyOutcome, { ok: true }>) => {
      guarded(() => recordScan(hit.card), 'Save scan')
      haptic(config.haptics ? [14, 60, 14] : 0)
      if (config.collectMode) collectRef.current!.hit(hit.card, scanFinish(hit))
    },
    [config.collectMode, config.haptics],
  )
  const scanner = useScanner(onHit, scanMode)
  const tray = useLiveQuery(() => db.scans.orderBy('at').reverse().limit(12).toArray(), [])
  const visible = active && !sheetOpen

  /**
   * Scans are a log of what the camera thought it saw, not a collection — so
   * dropping one only clears the tray. A card collect mode already filed stays
   * filed, and is removed in Collection; saying so in the toast is what keeps
   * the two from being confused.
   */
  const dropScan = useCallback(
    async (scan: ScanRecord) => {
      const removed = await guarded(() => removeScan(scan.id), 'Remove scan')
      if (!removed) return
      haptic(settings().haptics ? 10 : 0)
      toast(`Removed ${removed.card.name} from scans`, 'success', {
        label: 'Undo',
        fn: () => {
          guarded(() => restoreScans([removed]), 'Undo')
        },
      })
    },
    [toast],
  )

  const clearTray = useCallback(async () => {
    const removed = await guarded(() => clearScans(), 'Clear scans')
    if (!removed?.length) return
    haptic(settings().haptics ? 10 : 0)
    toast(`Cleared ${removed.length} ${removed.length === 1 ? 'scan' : 'scans'}`, 'success', {
      label: 'Undo',
      fn: () => {
        guarded(() => restoreScans(removed), 'Undo')
      },
    })
  }, [toast])

  /**
   * Read every card in one image.
   *
   * Sequential, bounded, and never automatic. Nine identifications is a
   * different cost profile from one — the budgets in identify.ts were tuned
   * for a single card, so each card here runs on the smaller PAGE_SCAN_BUDGET
   * — and it is the heaviest sustained work this app does on a phone. So it
   * only ever runs from a deliberate tap, the sensing loop is parked for the
   * duration (the live preview is behind the progress overlay anyway), and the
   * user can abandon it mid-way.
   */
  const runPageScan = useCallback(
    async (source: HTMLCanvasElement) => {
      const ctrl = new AbortController()
      pageAbortRef.current = ctrl
      setPageProgress({ done: 0, total: 0 })
      try {
        const cards = await scanPage(source, {
          signal: ctrl.signal,
          maxCards: MAX_PAGE_CARDS,
          onProgress: setPageProgress,
        })
        if (ctrl.signal.aborted) {
          // scanPage returns what it finished before the abort. Cancelling is
          // "stop, I have enough", not "discard the seven you already read".
          if (cards.length) setPageCards(cards)
          return
        }
        track('scan_attempt', {
          engine: 'ocr',
          outcome: cards.some((c) => c.outcome.ok) ? 'hit' : 'miss',
          mode: 'card',
          manual: true,
        })
        if (!cards.length) {
          toast('No cards found — fill the frame with the page', 'info')
          return
        }
        setPageCards(cards)
      } catch (err: any) {
        if (!ctrl.signal.aborted) toast(err?.message?.slice(0, 90) ?? 'Page scan failed', 'error')
      } finally {
        source.width = 0
        source.height = 0
        pageAbortRef.current = null
        setPageProgress(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toast],
  )

  const cancelPageScan = useCallback(() => {
    pageAbortRef.current?.abort(new DOMException('Cancelled', 'AbortError'))
  }, [])

  /** One card from a picked photo, through the same pipeline a capture uses. */
  const identifyOne = useCallback(
    async (canvas: HTMLCanvasElement) => {
      const outcome = await identifyFrame({ canvas }, frameHash(canvas), { ignoreMisses: true, mode: 'card' })
      if (outcome.ok) {
        onHit(outcome)
        openSheet({ card: outcome.card, origin: 'scan', finish: scanFinish(outcome) })
        return
      }
      toast(
        outcome.readName ? `Read “${outcome.readName}” but couldn't match it` : outcome.message,
        'info',
        outcome.readName
          ? {
              label: 'Search it',
              fn: () => {
                setSearchPrefill({ query: outcome.readName ?? '', game: outcome.readGame })
                location.hash = '#/search'
              },
            }
          : undefined,
      )
    },
    [onHit, openSheet, setSearchPrefill, toast],
  )

  /**
   * A photo from the library. The scan pipeline never sees a file — it sees a
   * canvas at the resolution a live capture would have produced, so an upload
   * is the same input a scan is, minus the shake.
   */
  const onPickFile = useCallback(
    async (file: File) => {
      if (!isEntitled('photo-upload')) return
      setUploadBusy(true)
      // Park the live scanner for the read: otherwise it keeps auto-attempting
      // on the camera while the user waits for their photo, contending for the
      // same two OCR workers and — in Collect mode — filing a camera card the
      // user never asked for.
      scanner.pauseSensing(true)
      try {
        // A page needs more pixels than a card: a 3x3 grid cut out of a
        // single-card frame leaves each crop too small to read a collector
        // line off. Decoding at the larger cap either way lets the detector
        // answer "is this a page?" before that choice is locked in.
        const canvas = await decodeImage(file, pageMode ? PAGE_MAX_EDGE : CAPTURE_MAX_EDGE)
        if (pageMode) {
          if (!isEntitled('page-scan')) return
          await runPageScan(canvas)
          return
        }
        // No "looks like several cards, try Page mode?" nudge here on purpose.
        // Measured on the committed photos, the detector returns 3-11 boxes for
        // a SINGLE card on a cluttered desk — a card held in a hand has a
        // yellow border against skin, which is a strong colour edge and a weak
        // luma one, and the sweep reads luma. A count that wrong is worse than
        // no hint at all; the Page toggle is in the top bar either way.
        await identifyOne(canvas)
        canvas.width = 0
        canvas.height = 0
      } catch (err: any) {
        toast(err?.message?.slice(0, 90) ?? "Couldn't read that image", 'error')
      } finally {
        setUploadBusy(false)
        scanner.pauseSensing(pageMode)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [identifyOne, pageMode, runPageScan, toast],
  )

  /** Page mode's shutter: the whole frame, not the reticle window. */
  const scanLivePage = useCallback(() => {
    if (!isEntitled('page-scan')) return
    const frame = scanner.grabFrame(PAGE_MAX_EDGE)
    if (!frame) return
    haptic(settings().haptics ? 10 : 0)
    void runPageScan(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runPageScan, scanner.grabFrame])

  /**
   * Page mode parks the automatic single-card scanner for as long as it is on.
   *
   * Not a tidiness question. The auto-attempt loop keeps identifying whatever
   * sits in the reticle while the user is lining up a binder page, and with
   * Collect mode on — a PERSISTED setting, easily left on from a previous
   * session — every one of those hits files a card with no review at all.
   * That is precisely the silent add the review screen exists to prevent,
   * arriving through the side door. In page mode the shutter is the tap.
   */
  useEffect(() => {
    scanner.pauseSensing(pageMode || pageProgress != null)
    // `scanner.status` is load-bearing, not incidental: start() and
    // resumeScanning() restart the rAF loop without pageMode or pageProgress
    // changing, and this is the only thing that re-parks it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageMode, pageProgress, scanner.status])

  // The review screen owns the screen while it is up: keeping a camera and a
  // Sobel loop alive behind it costs battery for a preview nobody can see.
  const reviewOpen = pageCards != null
  useEffect(() => {
    if (visible && !reviewOpen && started && scanner.status === 'idle') scanner.start()
    if ((!visible || reviewOpen) && scanner.status !== 'idle') scanner.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reviewOpen, started, scanner.status])

  // Navigating away mid-scan stops it. The view is only hidden, not unmounted,
  // so without this the remaining identifications keep running behind another
  // screen and the review ambushes the user when they come back.
  useEffect(() => {
    if (!active && pageAbortRef.current) cancelPageScan()
  }, [active, cancelPageScan])

  useEffect(() => {
    if (visible) warmOcr()
  }, [visible])

  /* The scanner lit the torch itself (sustained dark scene) — say so, once
   * per lighting, so the sudden light isn't a mystery. */
  const autoTorchAnnounced = useRef(false)
  useEffect(() => {
    if (scanner.autoTorch && !autoTorchAnnounced.current) {
      autoTorchAnnounced.current = true
      toast('Dark scene — flash is on (tap ⚡ to turn it off)', 'info')
    }
    if (!scanner.autoTorch) autoTorchAnnounced.current = false
  }, [scanner.autoTorch, toast])

  // The game filter names intent: preload that game's catalog (Riftbound &
  // co. have no search API, so the first match otherwise downloads it all),
  // and in pack mode the set indexes sealed scans match against. A lone
  // enabled game counts as intent too — identification hints it the same way.
  useEffect(() => {
    if (!visible) return
    const hinted =
      config.gameFilter !== 'auto' ? config.gameFilter : config.enabledGames.length === 1 ? config.enabledGames[0] : null
    if (hinted) warmCatalog(hinted)
    if (scanMode === 'sealed') warmSealedIndex(hinted ? [hinted] : config.enabledGames)
  }, [visible, config.gameFilter, config.enabledGames, scanMode])

  /* Camera memory: approving once is enough. If the persisted flag was lost
   * but the browser still remembers the grant, skip the gate anyway. */
  useEffect(() => {
    if (started) return
    let live = true
    cameraPermissionState().then((state) => {
      if (live && state === 'granted') setStarted(true)
    })
    return () => {
      live = false
    }
  }, [started])

  useEffect(() => {
    if (ACTIVE_SCAN_STATUSES.includes(scanner.status) && !config.cameraApproved) {
      config.set({ cameraApproved: true })
    }
    if (scanner.status === 'denied') {
      if (config.cameraApproved) config.set({ cameraApproved: false })
      // A silent auto-start the browser refused shouldn't strand the user on
      // the "Camera blocked" screen — fall back to the normal start gate.
      if (!manualStartRef.current) {
        scanner.stop()
        setStarted(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanner.status])

  const searchInstead = () => {
    const miss = scanner.miss
    setSearchPrefill({ query: miss?.readName ?? '', game: miss?.readGame })
    location.hash = '#/search'
  }

  const hit = scanner.hit
  const hitFinish = hit ? (finishPick?.id === hit.card.id ? finishPick.finish : scanFinish(hit)) : null
  const foilAuto = !!hit && finishPick?.id !== hit.card.id && hit.identification.foil === true
  const cycleFinish = () => {
    if (!hit || !hitFinish) return
    const options = finishOptions(hit.card)
    const next = options[(options.indexOf(hitFinish) + 1) % options.length] ?? hitFinish
    setFinishPick({ id: hit.card.id, finish: next })
    haptic(config.haptics ? 6 : 0)
  }

  const scanning = ACTIVE_SCAN_STATUSES.includes(scanner.status)
  const gated =
    !started ||
    scanner.status === 'denied' ||
    scanner.status === 'unsupported' ||
    scanner.status === 'error' ||
    (scanner.status === 'paused' && scanner.needsResume)
  // One voice: while the chip is up (thinking/found/nomatch) it does the
  // talking — the reticle hint only fills the chip-less states.
  const hint = scanner.lowLight
    ? scanner.torchAvailable && !scanner.torchOn
      ? 'Dark — tap the flash'
      : 'Dark — more light helps'
    : scanner.status === 'locking' || scanner.sensing
      ? 'Hold steady…'
      : pageMode
        ? 'Fit the whole page in frame, then tap'
        : scanMode === 'sealed'
          ? 'Fill the frame with the pack or box front'
          : 'Fill the frame with a card'
  const tapRescan = () => {
    if (scanner.busy || !scanning || pageProgress) return
    if (pageMode) {
      scanLivePage()
      return
    }
    haptic(config.haptics ? 8 : 0)
    scanner.scanNow()
  }
  /* iOS re-asks for the camera BY DESIGN — per Safari visit unless the user
   * allows the site permanently, per launch (unfixably) for Home-Screen
   * apps. Say so once, with whatever recourse the context actually has. */
  const iosHint = scanning && (IOS_BROWSER || IOS_PWA) && !config.iosCameraHintShown

  return (
    <div className="scan">
      <video ref={scanner.videoRef} className="scan__video" playsInline muted />
      <div className="scan__vignette" />
      {started && scanning && (
        /* The whole viewfinder is the shutter now: tap to force a fresh
         * attempt that skips the same-frame miss cache and retry backoff. */
        <button className="scan__tap" onClick={tapRescan} aria-label="Scan now" />
      )}
      {!gated && (
        <div className="scan__top safe-top">
          {config.enabledGames.length > 1 && (
            <Seg
              ariaLabel="Game filter"
              size="sm"
              scroll
              options={[
                { value: 'auto' as const, label: 'Auto' },
                ...config.enabledGames.map((game) => ({ value: game, label: GAME_SHORT[game] })),
              ]}
              value={config.gameFilter}
              onChange={(gameFilter) => config.set({ gameFilter })}
            />
          )}
          <div className="scan__topbtns">
            <button
              className={`collectpill ${scanMode === 'sealed' ? 'collectpill--on' : ''}`}
              onClick={() => {
                const next: ScanMode = scanMode === 'sealed' ? 'card' : 'sealed'
                setScanMode(next)
                scanner.rescan()
                toast(next === 'sealed' ? 'Pack mode: scan boosters, boxes and bundles' : 'Card mode', 'info')
              }}
              aria-pressed={scanMode === 'sealed'}
              aria-label="Scan sealed packs"
            >
              <Icon name="grid" size={14} />
              <span className="collectpill__label">Packs</span>
            </button>
            <button
              className={`collectpill ${pageMode ? 'collectpill--on' : ''}`}
              onClick={() => {
                const next = !pageMode
                setPageMode(next)
                if (next && scanMode === 'sealed') setScanMode('card')
                scanner.rescan()
                toast(
                  next ? 'Page mode: tap to read every card in frame' : 'Single card mode',
                  'info',
                )
              }}
              aria-pressed={pageMode}
              aria-label="Scan a whole page of cards"
            >
              <Icon name="cards" size={14} />
              <span className="collectpill__label">Page</span>
            </button>
            <button
              className={`collectpill ${config.collectMode ? 'collectpill--on' : ''}`}
              onClick={() => {
                config.set({ collectMode: !config.collectMode })
                toast(config.collectMode ? 'Collect mode off' : 'Collect mode: scans add to collection', 'info')
              }}
              aria-pressed={config.collectMode}
              aria-label="Collect mode"
            >
              <Icon name={config.collectMode ? 'check' : 'plus'} size={14} />
              <span className="collectpill__label">Collect</span>
            </button>
            <UploadButton busy={uploadBusy} onPick={() => fileRef.current?.click()} />
            {scanner.torchAvailable && (
              <button
                className={`iconbtn iconbtn--glass ${scanner.torchOn ? 'iconbtn--on' : ''}`}
                onClick={() => {
                  scanner.toggleTorch()
                }}
                aria-label="Toggle flashlight"
              >
                <Icon name="flash" size={18} filled={scanner.torchOn} />
              </button>
            )}
          </div>
        </div>
      )}
      {!started && (
        <div className="scan__gate">
          <div className="scan__gateicon">
            <Icon name="camera" size={34} />
          </div>
          <span className="wordmark scan__wordmark">Cardstock</span>
          <h2>Point. Price. Collect.</h2>
          <p>Hover the camera over any card — Magic, Pokémon, Yu-Gi-Oh, Riftbound, Lorcana and more — and its price pops up live.</p>
          <button
            className="btn btn--primary btn--big"
            onClick={() => {
              manualStartRef.current = true
              setStarted(true)
            }}
          >
            <Icon name="scan" size={18} /> Start scanning
          </button>
          <UploadButton busy={uploadBusy} onPick={() => fileRef.current?.click()} wide />
          <p className="scan__gatehint">
            Everything runs on this device — the card name, its collector number, even foil sheen. No account, no API.
          </p>
          <p className="scan__gatehint">
            {IOS_PWA
              ? 'iOS asks Home-Screen apps for the camera again on each launch — an Apple limitation, not Cardstock forgetting. Cardstock holds the camera through quick app switches so it asks as rarely as iOS allows.'
              : "You'll be asked for the camera once; after that Cardstock opens it automatically."}
            {IOS_BROWSER
              ? ' iPhone tip: in Safari tap aA → Website Settings → Camera → Allow so Safari stops asking on every visit.'
              : ''}
          </p>
        </div>
      )}
      {started && scanner.status === 'paused' && scanner.needsResume && (
        <div className="scan__gate">
          <div className="scan__gateicon">
            <Icon name="camera" size={30} />
          </div>
          <h2>Camera stopped</h2>
          <p>{scanner.detail ?? 'Another app may have taken the camera.'}</p>
          <button
            className="btn btn--primary"
            onClick={() => {
              scanner.start()
            }}
          >
            Resume scanning
          </button>
        </div>
      )}
      {started && (scanner.status === 'denied' || scanner.status === 'unsupported' || scanner.status === 'error') && (
        <div className="scan__gate">
          <div className="scan__gateicon scan__gateicon--warn">
            <Icon name="alert" size={30} />
          </div>
          <h2>{scanner.status === 'denied' ? 'Camera blocked' : 'Camera unavailable'}</h2>
          <p>{scanner.detail ?? 'Check permissions and try again.'}</p>
          {scanner.status === 'denied' && IOS_BROWSER && (
            <p className="scan__gatehint">
              iPhone: in Safari tap aA → Website Settings → Camera → Allow and the permission is remembered.
            </p>
          )}
          {scanner.status === 'denied' && IOS_PWA && (
            <p className="scan__gatehint">
              iOS doesn't keep camera answers for Home-Screen apps — close and reopen Cardstock and it will ask again.
            </p>
          )}
          <button
            className="btn btn--primary"
            onClick={() => {
              scanner.start()
            }}
          >
            Try again
          </button>
          {/* A blocked camera is exactly when a photo from the library is the
            * only way in — don't strand the user on a dead end. */}
          <UploadButton busy={uploadBusy} onPick={() => fileRef.current?.click()} wide />
        </div>
      )}
      {started && scanning && (
        <>
          <div
            className={`reticle ${scanner.sensing ? 'reticle--sensing' : ''} ${scanner.status === 'found' ? 'reticle--locked' : ''}`}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
            <i />
            {scanner.status !== 'found' && scanner.status !== 'nomatch' && scanner.status !== 'thinking' && (
              <span className="reticle__hint">{hint}</span>
            )}
          </div>
          {(scanner.status === 'thinking' || scanner.status === 'found' || scanner.status === 'nomatch') && (
            <div className="chipslot">
              <ScanChip
                status={scanner.status}
                hit={hit}
                finish={hitFinish}
                foilAuto={foilAuto}
                onCycleFinish={cycleFinish}
                onOpen={() => hit && hitFinish && openSheet({ card: hit.card, origin: 'scan', finish: hitFinish })}
                detail={scanner.detail}
                onSearch={scanner.miss?.readName ? searchInstead : null}
                onRetry={tapRescan}
                onDetails={() => setDebugOpen(true)}
              />
            </div>
          )}
          {iosHint && (
            <div className="scan__ioshint">
              {IOS_PWA ? (
                <p>
                  iOS asks Home-Screen apps for the camera again each time they're reopened — an Apple limitation, not
                  Cardstock forgetting. Cardstock holds the camera through quick app switches so it asks as rarely as
                  iOS allows.
                </p>
              ) : (
                <p>
                  iPhone asks for the camera on every Safari visit — that's Safari, not Cardstock. Tap
                  <b> aA → Website Settings → Camera → Allow</b> and Safari stops asking for good.
                </p>
              )}
              <button
                className="chip__searchbtn"
                onClick={() => {
                  config.set({ iosCameraHintShown: true })
                }}
              >
                Got it
              </button>
            </div>
          )}
        </>
      )}
      {pageProgress && (
        <div className="pagescan" role="status" aria-live="polite">
          <span className="chip__spinner" />
          <strong>
            {pageProgress.total
              ? `Reading card ${Math.min(pageProgress.done + 1, pageProgress.total)} of ${pageProgress.total}`
              : 'Finding the cards…'}
          </strong>
          <span className="pagescan__hint">Nothing is added until you review them</span>
          <button className="chip__searchbtn" onClick={cancelPageScan}>
            Cancel
          </button>
        </div>
      )}
      {pageCards && (
        <BinderReview
          cards={pageCards}
          onClose={() => setPageCards(null)}
          onOpenCard={(card, finish) => openSheet({ card, origin: 'scan', finish })}
          onAdded={(added, itemIds) => {
            setPageCards(null)
            if (!added) return
            haptic(config.haptics ? [14, 60, 14] : 0)
            // Undo, like every other add path here — and most of all here,
            // where one tap files nine rows and a mistake is hardest to spot
            // afterwards.
            toast(`Added ${added} ${added === 1 ? 'card' : 'cards'} to your collection`, 'success', {
              label: 'Undo',
              fn: () => {
                void guarded(async () => {
                  for (const id of itemIds) await removeCopies(id, 1)
                }, 'Undo')
              },
            })
          }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset first: picking the SAME file twice must fire onChange again.
          event.target.value = ''
          if (file) void onPickFile(file)
        }}
      />
      {debugOpen && <ScanDebugPanel onClose={() => setDebugOpen(false)} />}
      {(tray?.length ?? 0) > 0 && (
        <div className="tray">
          {tray!.map((scan) => (
            <div key={scan.id} className="tray__item">
              <button className="tray__open" onClick={() => openSheet({ card: scan.card, origin: 'scan' })}>
                <span className="tray__thumb">
                  <CardImg card={scan.card} className="tray__img" />
                  <span className="tray__price">{money(scan.card.prices.best ?? scan.card.prices.bestFoil)}</span>
                </span>
                <span className="tray__set">{scan.card.setCode ?? GAME_SHORT[scan.card.game]}</span>
              </button>
              {/* A misread lands here looking exactly as certain as a good
                * scan, so getting rid of it has to be one tap away — and
                * undoable, since the × sits on a small tile beside a
                * scrolling gesture. */}
              <button
                className="tray__remove"
                aria-label={`Remove ${scan.card.name} from scans`}
                onClick={() => dropScan(scan)}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
          {(tray?.length ?? 0) > 1 && (
            <button className="tray__clear" onClick={clearTray}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}
