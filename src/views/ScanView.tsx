import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from '../components/Icon'
import { CardImg, Seg } from '../components/basics'
import { ACTIVE_SCAN_STATUSES, useScanner, type ScannerStatus } from '../hooks/useScanner'
import { track } from '../lib/analytics'
import { addToCollection, db, recordScan, removeCopies } from '../lib/db'
import { FINISH_LABEL, finishOptions, GAMES, GAME_SHORT } from '../lib/games'
import { usingOcrBecauseKeyRejected, type IdentifyOutcome } from '../lib/identify'
import { warmOcr } from '../lib/ocr'
import { headlineFinish, itemCurrency, itemUnitPrice, priceCurrency } from '../lib/prices'
import { useSettings } from '../lib/settings'
import type { Card, Finish } from '../lib/types'
import { haptic, money } from '../lib/util'
import { guarded, uiStore, useUi } from '../store/ui'

/**
 * The finish the physical copy most likely has: the scanner's foil reading
 * when it has one, otherwise the printing's headline finish (which also files
 * foil-only printings as foil rather than "Normal").
 */
function scanFinish(hit: Extract<IdentifyOutcome, { ok: true }>): Finish {
  const options = finishOptions(hit.card)
  const foil = hit.identification.foil
  if (foil === true) {
    const premium = options.find((f) => f !== 'nonfoil')
    if (premium) return premium
  }
  if (foil === false && options.includes('nonfoil')) return 'nonfoil'
  return headlineFinish(hit.card.prices, options)
}

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
    this.recent = { cardId: card.id, at: Date.now() }
    const item = await guarded(() => addToCollection(card, { finish }), 'Add')
    if (!item) return
    track('card_added', { game: card.game, source: 'scan' })
    // Price the copy that was actually filed (finish-specific).
    const probe = { finish, condition: 'NM' as const, qty: 1, card }
    const label = finish === 'nonfoil' ? '' : ` ${FINISH_LABEL[finish].toLowerCase()}`
    uiStore.getState().toast(`+1 ${card.name}${label} · ${money(itemUnitPrice(probe), itemCurrency(probe))}`, 'success', {
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
  onOpen,
  detail,
  onSearch,
}: {
  status: ScannerStatus
  hit: Extract<IdentifyOutcome, { ok: true }> | null
  onOpen: () => void
  detail: string | null
  onSearch: (() => void) | null
}) {
  if (status === 'found' && hit) {
    const card = hit.card
    // Price the finish that's actually in frame — a scanned foil shows the
    // foil number, not the plain one.
    const finish = scanFinish(hit)
    const probe = { finish, condition: 'NM' as const, qty: 1, card }
    return (
      <button className="chip chip--found" onClick={onOpen}>
        <span className="chip__price">{money(itemUnitPrice(probe), itemCurrency(probe))}</span>
        <span className="chip__meta">
          <span className="chip__name">{card.name}</span>
          <span className="chip__set">
            {card.setCode}
            {card.number ? ` · ${card.number}` : ''}
            {finish === 'nonfoil' ? '' : ` · ${FINISH_LABEL[finish]}`}
          </span>
        </span>
        <Icon name="chevronRight" size={16} className="chip__go" />
      </button>
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
  if (status === 'locking') {
    return (
      <div className="chip chip--locking">
        <span className="chip__dot" />
        <span className="chip__label">Hold steady</span>
      </div>
    )
  }
  if (status === 'nomatch') {
    return (
      <div className="chip chip--nomatch">
        <span className="chip__missbody">
          <span className="chip__label">{detail ?? 'No match — try filling the frame'}</span>
          {onSearch && (
            <button className="chip__searchbtn" onClick={onSearch}>
              <Icon name="search" size={13} /> Search it instead
            </button>
          )}
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
  const [started, setStarted] = useState(false)
  const warnedKeyRef = useRef(false)

  const onHit = useCallback(
    (hit: Extract<IdentifyOutcome, { ok: true }>) => {
      guarded(() => recordScan(hit.card), 'Save scan')
      haptic(config.haptics ? [14, 60, 14] : 0)
      if (config.collectMode) collectRef.current!.hit(hit.card, scanFinish(hit))
      if (usingOcrBecauseKeyRejected() && !warnedKeyRef.current) {
        warnedKeyRef.current = true
        toast('Gemini rejected your API key, so scans run on-device for now — fix the key in Settings when you can.', 'info')
      }
    },
    [config.collectMode, config.haptics, toast],
  )
  const scanner = useScanner(onHit)
  const tray = useLiveQuery(() => db.scans.orderBy('at').reverse().limit(12).toArray(), [])
  const visible = active && !sheetOpen

  useEffect(() => {
    if (visible && started && scanner.status === 'idle') scanner.start()
    if (!visible && scanner.status !== 'idle') scanner.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, started, scanner.status])

  useEffect(() => {
    if (config.ocrFallback && started && visible && (!config.geminiKey || usingOcrBecauseKeyRejected())) warmOcr()
  }, [config.geminiKey, config.ocrFallback, started, visible])

  const searchInstead = () => {
    const miss = scanner.miss
    setSearchPrefill({ query: miss?.readName ?? '', game: miss?.readGame })
    location.hash = '#/search'
  }

  const scanning = ACTIVE_SCAN_STATUSES.includes(scanner.status)
  const gated =
    !started ||
    scanner.status === 'denied' ||
    scanner.status === 'unsupported' ||
    scanner.status === 'error' ||
    (scanner.status === 'paused' && scanner.needsResume)
  const hint =
    scanner.status === 'thinking'
      ? 'Reading…'
      : scanner.status === 'locking' || scanner.sensing
        ? 'Hold steady…'
        : 'Fill the frame with a card'

  return (
    <div className="scan">
      <video ref={scanner.videoRef} className="scan__video" playsInline muted />
      <div className="scan__vignette" />
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
              setStarted(true)
            }}
          >
            <Icon name="scan" size={18} /> Start scanning
          </button>
          <p className="scan__gatehint">
            {config.geminiKey ? 'Gemini vision is on' : 'No API key needed — on-device text recognition will identify cards'}
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
            {scanner.status !== 'found' && scanner.status !== 'nomatch' && <span className="reticle__hint">{hint}</span>}
          </div>
          {(scanner.status === 'thinking' || scanner.status === 'found' || scanner.status === 'nomatch') && (
            <div className="chipslot">
              <ScanChip
                status={scanner.status}
                hit={scanner.hit}
                onOpen={() =>
                  scanner.hit && openSheet({ card: scanner.hit.card, origin: 'scan', finish: scanFinish(scanner.hit) })
                }
                detail={scanner.detail}
                onSearch={scanner.miss?.readName ? searchInstead : null}
              />
            </div>
          )}
        </>
      )}
      {started && scanning && (
        <div className={`shutterbar ${(tray?.length ?? 0) > 0 ? 'shutterbar--tray' : ''}`}>
          <button
            className={`shutter ${scanner.busy ? 'shutter--busy' : ''}`}
            onClick={() => {
              if (!scanner.busy) {
                haptic(config.haptics ? 8 : 0)
                scanner.scanNow()
              }
            }}
            disabled={scanner.busy}
            aria-label="Scan now"
          >
            <span className="shutter__ring" />
            <span className="shutter__core" />
          </button>
        </div>
      )}
      {(tray?.length ?? 0) > 0 && (
        <div className="tray">
          {tray!.map((scan) => (
            <button key={scan.id} className="tray__item" onClick={() => openSheet({ card: scan.card, origin: 'scan' })}>
              <span className="tray__thumb">
                <CardImg card={scan.card} className="tray__img" />
                <span className="tray__price">
                  {money(
                    scan.card.prices.best ?? scan.card.prices.bestFoil,
                    priceCurrency(scan.card.prices, scan.card.prices.best == null ? 'foil' : 'best'),
                  )}
                </span>
              </span>
              <span className="tray__set">{scan.card.setCode ?? GAME_SHORT[scan.card.game]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
