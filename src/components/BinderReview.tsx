import { useCallback, useMemo, useState } from 'react'
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
  onToggle,
  onOpen,
  onRetry,
}: {
  row: Row
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
        aria-label={hit ? `Add ${hit.card.name}` : 'Add this card'}
        disabled={!hit}
      >
        {row.include ? <Icon name="check" size={14} /> : null}
      </button>
      <img className="binderrow__thumb" src={row.image} alt="" />
      <div className="binderrow__body">
        {hit && finish ? (
          <>
            <button
              className="binderrow__name"
              onClick={() => onOpen(hit.card, finish)}
              aria-label={`Details for ${hit.card.name}`}
            >
              {hit.card.name}
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
                <Icon name="alert" size={12} /> Low-confidence read — check it
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
      <button className="binderrow__retry" onClick={onRetry} disabled={row.busy} aria-label="Read this card again">
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
  onAdded: (added: number) => void
}) {
  const [rows, setRows] = useState<Row[]>(() => cards.map((c) => ({ ...c, include: preTicked(c.outcome) })))
  const [saving, setSaving] = useState(false)

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
      patchRow(row.id, { busy: true })
      const outcome = await rescanPageCard(row)
      patchRow(row.id, { busy: false, outcome, include: preTicked(outcome) })
      if (!outcome.ok) uiStore.getState().toast('Still no match on that one', 'info')
    },
    [patchRow],
  )

  const addAll = useCallback(async () => {
    if (!chosen.length || saving) return
    setSaving(true)
    let added = 0
    for (const row of chosen) {
      const hit = row.outcome as Extract<IdentifyOutcome, { ok: true }>
      // Every write goes through guarded() so a full quota surfaces as a toast
      // rather than an unhandled rejection — and a page of nine is exactly
      // when storage runs out.
      const item = await guarded(() => addToCollection(hit.card, { finish: rowFinish(hit) }), 'Add')
      if (!item) break
      added++
    }
    setSaving(false)
    onAdded(added)
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
      <ul className="binder__list">
        {rows.map((row) => (
          <ReviewRow
            key={row.id}
            row={row}
            onToggle={() => patchRow(row.id, { include: !row.include })}
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
