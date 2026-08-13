import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from '../components/Icon'
import { CardImg, Seg } from '../components/basics'
import { ScanDebugPanel } from '../components/ScanDebug'
import { ACTIVE_SCAN_STATUSES, useScanner, type ScannerStatus } from '../hooks/useScanner'
import { track } from '../lib/analytics'
import { CAMERA_REPROMPTS_EACH_ACQUIRE, cameraPermissionState, IS_STANDALONE } from '../lib/camera'
import { addToCollection, db, recordScan, removeCopies } from '../lib/db'
import { FINISH_LABEL, finishOptions, GAMES, GAME_SHORT } from '../lib/games'
import type { IdentifyOutcome, ScanMode } from '../lib/identify'
import { warmOcr } from '../lib/ocr'
import { headlineFinish, itemUnitPrice } from '../lib/prices'
import { warmSealedIndex } from '../lib/sealed'
import { settings, useSettings } from '../lib/settings'
import { warmCatalog } from '../lib/tcgcsv'
import type { Card, Finish } from '../lib/types'
import { haptic, money } from '../lib/util'
import { guarded, uiStore, useUi } from '../store/ui'

/**
 * The finish the physical copy most likely has: the scanner's foil reading
 * when it has one, otherwise the printing's headline finish (which also files
 * foil-only printings as foil rather than "Normal").
 */
function scanFinish(hit: Extract<IdentifyOutcome, { ok: true }>): Finish {
  if (hit.card.sealed) return 'nonfoil'
  const options = finishOptions(hit.card)
  const foil = hit.identification.foil
  if (foil === true) {
    const premium = options.find((f) => f !== 'nonfoil')
    if (premium) return premium
  }
  if (foil === false && options.includes('nonfoil')) return 'nonfoil'
  return headlineFinish(hit.card.prices, options)
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

  useEffect(() => {
    if (visible && started && scanner.status === 'idle') scanner.start()
    if (!visible && scanner.status !== 'idle') scanner.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, started, scanner.status])

  useEffect(() => {
    if (visible) warmOcr()
  }, [visible])

  // The game filter names intent: preload that game's catalog (Riftbound &
  // co. have no search API, so the first match otherwise downloads it all),
  // and in pack mode the set indexes sealed scans match against.
  useEffect(() => {
    if (!visible) return
    if (config.gameFilter !== 'auto') warmCatalog(config.gameFilter)
    if (scanMode === 'sealed') warmSealedIndex(config.gameFilter === 'auto' ? undefined : [config.gameFilter])
  }, [visible, config.gameFilter, scanMode])

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
  const hint =
    scanner.status === 'locking' || scanner.sensing
      ? 'Hold steady…'
      : scanMode === 'sealed'
        ? 'Fill the frame with the pack or box front'
        : 'Fill the frame with a card'
  const tapRescan = () => {
    if (!scanner.busy && scanning) {
      haptic(config.haptics ? 8 : 0)
      scanner.scanNow()
    }
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
          <Seg
            ariaLabel="Game filter"
            size="sm"
            scroll
            options={[
              { value: 'auto' as const, label: 'Auto' },
              ...GAMES.map((game) => ({ value: game, label: GAME_SHORT[game] })),
            ]}
            value={config.gameFilter}
            onChange={(gameFilter) => config.set({ gameFilter })}
          />
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
      {debugOpen && <ScanDebugPanel onClose={() => setDebugOpen(false)} />}
      {(tray?.length ?? 0) > 0 && (
        <div className="tray">
          {tray!.map((scan) => (
            <button key={scan.id} className="tray__item" onClick={() => openSheet({ card: scan.card, origin: 'scan' })}>
              <span className="tray__thumb">
                <CardImg card={scan.card} className="tray__img" />
                <span className="tray__price">{money(scan.card.prices.best ?? scan.card.prices.bestFoil)}</span>
              </span>
              <span className="tray__set">{scan.card.setCode ?? GAME_SHORT[scan.card.game]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
