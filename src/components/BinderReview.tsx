import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from './Icon'
import { addToCollection } from '../lib/db'
import { FINISH_LABEL, GAME_SHORT, finishOptions } from '../lib/games'
import type { IdentifyOutcome } from '../lib/identify'
import { rescanPageCard, type PageCard } from '../lib/multiscan'
import { itemUnitPrice, scannedFinish } from '../lib/prices'
import type { Card, Finish } from '../lib/types'
import { money } from '../lib/util'
import { guarded, uiStore } from '../store/ui'

/**
 * Review before add — the whole point of the multi-card path.
 *
 * A binder page files ~9 rows from ONE confirmation, so a silent wrong card is
 * nine times more expensive here than in single scanning, and nine times
 * harder to notice afterwards. Nothing is ever added without this screen.
 *
 * Pre-ticking is the only place that judgement is applied, and it is
 * deliberately conservative: a read has to be near-exact to arrive ticked.
 * Everything else arrives visible, flagged, and OFF — the user opts it in
 * after looking at the thumbnail beside the name, which is the one check no
 * threshold in the pipeline can make.
 */

/**
 * Confidence at or above which a row arrives ticked. Same bar the scan harness
 * grades name similarity at, and above the 0.7 a collector-line-only
 * identification carries — those are strong evidence but the NAME never read,
 * so on a nine-card confirm they get looked at.
 */
const PRETICK_CONFIDENCE = 0.9

type Row = PageCard & { include: boolean; busy?: boolean }

function rowFinish(hit: Extract<IdentifyOutcome, { ok: true }>): Finish {
  return scannedFinish(hit.card, hit.identification.foil)
}

function preTicked(outcome: IdentifyOutcome): boolean {
  return outcome.ok && outcome.identification.confidence >= PRETICK_CONFIDENCE
}

function ReviewRow({
  row,
  index,
  onToggle,
  onOpen,
  onRetry,
}: {
  row: Row
  index: number
  onToggle: () => void
  onOpen: (card: Card, finish: Finish) => void
  onRetry: () => void
}) {
  const hit = row.outcome.ok ? row.outcome : null
  const finish = hit ? rowFinish(hit) : null
  const flagged = !preTicked(row.outcome)
  const read = !row.outcome.ok ? row.outcome.readName : null
  return (
    <li className={`binderrow ${row.include ? 'binderrow--on' : ''} ${flagged ? 'binderrow--flagged' : ''}`}>
      <button
        className="binderrow__tick"
        onClick={onToggle}
        role="checkbox"
        aria-checked={row.include}
        aria-label={hit ? `Add ${hit.card.name}` : `Add card ${index + 1}`}
        disabled={!hit}
      >
        {row.include ? <Icon name="check" size={14} /> : null}
      </button>
      {/* The kept JPEG is a full-resolution crop (it is also the input a retry
        * re-reads), so give the decoder the display size and let it downsample:
        * twelve megapixel-class bitmaps behind 46px slots is ~47MB of live
        * backing store on the device least able to spare it. */}
      <img className="binderrow__thumb" src={row.image} alt="" width={46} height={64} decoding="async" loading="lazy" />
      <div className="binderrow__body">
        {hit && finish ? (
          <>
            <button
              className="binderrow__name"
              onClick={() => onOpen(hit.card, finish)}
              aria-label={`Details for ${hit.card.name}`}
            >
              <span>{hit.card.name}</span>
              <Icon name="chevronRight" size={13} />
            </button>
            <span className="binderrow__meta">
              {hit.card.setCode ?? GAME_SHORT[hit.card.game]}
              {hit.card.number ? ` · ${hit.card.number}` : ''}
              {finish !== 'nonfoil' ? ` · ${FINISH_LABEL[finish]}` : ''}
              {finishOptions(hit.card).length > 1 && hit.identification.foil === true ? ' · auto' : ''}
            </span>
            {flagged && (
              <span className="binderrow__warn">
                <Icon name="alert" size={12} /> Check this one
              </span>
            )}
          </>
        ) : (
          <>
            <span className="binderrow__name binderrow__name--miss">
              {read ? `Read “${read}” — no match` : 'Not identified'}
            </span>
            <span className="binderrow__meta">{row.outcome.ok ? '' : row.outcome.message}</span>
          </>
        )}
      </div>
      <button className="binderrow__retry" onClick={onRetry} disabled={row.busy} aria-label={`Read card ${index + 1} again`}>
        {row.busy ? <span className="chip__spinner" /> : <Icon name="refresh" size={14} />}
      </button>
      <span className="binderrow__price">{hit && finish ? money(itemUnitPrice({ finish, condition: 'NM', qty: 1, card: hit.card })) : '—'}</span>
    </li>
  )
}

export function BinderReview({
  cards,
  onClose,
  onOpenCard,
  onAdded,
}: {
  cards: PageCard[]
  onClose: () => void
  onOpenCard: (card: Card, finish: Finish) => void
  onAdded: (added: number, itemIds: string[]) => void
}) {
  const [rows, setRows] = useState<Row[]>(() => cards.map((c) => ({ ...c, include: preTicked(c.outcome) })))
  const [saving, setSaving] = useState(false)

  // Escape closes it, the way Modal and Sheet do — a full-screen takeover with
  // no keyboard way out is a trap on desktop.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const chosen = useMemo(() => rows.filter((r) => r.include && r.outcome.ok), [rows])
  const found = rows.filter((r) => r.outcome.ok).length
  const value = chosen.reduce((sum, r) => {
    const hit = r.outcome as Extract<IdentifyOutcome, { ok: true }>
    return sum + (itemUnitPrice({ finish: rowFinish(hit), condition: 'NM', qty: 1, card: hit.card }) ?? 0)
  }, 0)

  const patchRow = useCallback((id: string, patch: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const retry = useCallback(
    async (row: Row) => {
      const wasNamed = row.outcome.ok ? row.outcome.card.name : null
      patchRow(row.id, { busy: true })
      const outcome = await rescanPageCard(row)
      patchRow(row.id, {
        busy: false,
        outcome,
        // A tick the user made by hand is an answer; a re-read may not quietly
        // undo it. Only ever tick MORE, never less.
        include: row.include || preTicked(outcome),
      })
      if (!outcome.ok) uiStore.getState().toast('Still no match on that one', 'info')
      else if (wasNamed && wasNamed !== outcome.card.name) {
        // Swapping one card for a different one is the single thing on this
        // screen the user most needs to notice.
        uiStore.getState().toast(`Now reads “${outcome.card.name}”`, 'info')
      }
    },
    [patchRow],
  )

  const addAll = useCallback(async () => {
    if (!chosen.length || saving) return
    setSaving(true)
    const filed = new Set<string>()
    const written: string[] = []
    let stopped = false
    for (const row of chosen) {
      const hit = row.outcome as Extract<IdentifyOutcome, { ok: true }>
      // Every write goes through guarded() so a full quota surfaces as a toast
      // rather than an unhandled rejection — and a page of nine is exactly
      // when storage runs out.
      const item = await guarded(() => addToCollection(hit.card, { finish: rowFinish(hit) }), 'Add')
      if (!item) {
        stopped = true
        break
      }
      filed.add(row.id)
      written.push(item.id)
    }
    setSaving(false)
    if (stopped) {
      // guarded() has already said what went wrong. Do NOT also claim success
      // and close: the rows that were not filed are only recoverable from this
      // screen — the source image is long released — so drop the ones that
      // landed and leave the rest in front of the user.
      setRows((prev) => prev.filter((r) => !filed.has(r.id)))
      return
    }
    onAdded(filed.size, written)
  }, [chosen, onAdded, saving])

  return (
    <div className="binder" role="dialog" aria-modal="true" aria-label="Review scanned cards">
      <header className="binder__head safe-top">
        <button className="iconbtn" onClick={onClose} aria-label="Cancel">
          <Icon name="x" size={18} />
        </button>
        <div className="binder__title">
          <h2>{found} of {rows.length} identified</h2>
          <span>Tick what to add — nothing is filed until you confirm</span>
        </div>
      </header>
      {!found && (
        <p className="binder__empty">
          Nothing on this page could be read. Fill the frame with the page, hold still, and try again — or read a
          card on its own.
        </p>
      )}
      <ul className="binder__list">
        {rows.map((row, index) => (
          <ReviewRow
            key={row.id}
            row={row}
            index={index}
            onToggle={() => setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, include: !r.include } : r)))}
            onOpen={onOpenCard}
            onRetry={() => void retry(row)}
          />
        ))}
      </ul>
      <footer className="binder__foot safe-bottom">
        <div className="binder__sum">
          <strong>{chosen.length} selected</strong>
          <span>{money(value)}</span>
        </div>
        <button className="btn btn--primary" disabled={!chosen.length || saving} onClick={() => void addAll()}>
          {saving ? 'Adding…' : `Add ${chosen.length} ${chosen.length === 1 ? 'card' : 'cards'}`}
        </button>
      </footer>
    </div>
  )
}
