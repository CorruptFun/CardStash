import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from './Icon'
import { CardImg } from './basics'
import { addToCollection, db, markScansAdded, removeScan, restoreScans } from '../lib/db'
import { FINISH_LABEL, GAME_SHORT } from '../lib/games'
import { itemUnitPrice, scannedFinish } from '../lib/prices'
import { gradeShort } from '../lib/slab'
import type { Card, Finish, ScanRecord } from '../lib/types'
import { money } from '../lib/util'
import { guarded, uiStore } from '../store/ui'

/**
 * Batch add — file a session's worth of scans in one pass.
 *
 * Scanning a shoebox one card at a time and tapping through the card sheet for
 * each is the flow this replaces: the tray already holds everything the camera
 * read, so the batch screen is that log with a tick beside every row. Nothing
 * is written until the confirm, and the same screen is where an obvious
 * misread gets thrown away instead of being carried into the collection.
 *
 * It shares the review shell with `BinderReview` on purpose — same layout,
 * same confirm, same promise that the list in front of you is exactly what is
 * about to be filed — but the two are not one component: a page row owns a
 * crop, a confidence and a re-read, while a tray row is an already-confirmed
 * hit the user watched land on the chip. That difference is the whole reason
 * this screen arrives fully ticked and the binder one does not.
 */

/** The finish to file: what the scanner read, else the printing's headline. */
export function scanRowFinish(scan: ScanRecord): Finish {
  return scan.finish ?? scannedFinish(scan.card, undefined)
}

function rowPrice(scan: ScanRecord): number | null {
  return itemUnitPrice({ finish: scanRowFinish(scan), condition: 'NM', qty: 1, card: scan.card })
}

function BatchRow({
  scan,
  picked,
  onToggle,
  onOpen,
  onDrop,
}: {
  scan: ScanRecord
  picked: boolean
  onToggle: () => void
  onOpen: () => void
  onDrop: () => void
}) {
  const finish = scanRowFinish(scan)
  const price = rowPrice(scan)
  return (
    <li className={`binderrow batchrow ${picked ? 'binderrow--on' : ''} ${scan.added ? 'batchrow--filed' : ''}`}>
      <button
        className="binderrow__tick"
        onClick={onToggle}
        role="checkbox"
        aria-checked={picked}
        aria-label={`Add ${scan.card.name}`}
      >
        {picked ? <Icon name="check" size={14} /> : null}
      </button>
      <CardImg card={scan.card} className="binderrow__thumb" />
      <div className="binderrow__body">
        <button className="binderrow__name" onClick={onOpen} aria-label={`Details for ${scan.card.name}`}>
          <span>{scan.card.name}</span>
          <Icon name="chevronRight" size={13} />
        </button>
        <span className="binderrow__meta">
          {scan.card.setCode ?? GAME_SHORT[scan.card.game]}
          {scan.card.number ? ` · ${scan.card.number}` : ''}
          {finish !== 'nonfoil' ? ` · ${FINISH_LABEL[finish]}` : ''}
          {scan.grade ? ` · ${gradeShort(scan.grade)}` : ''}
        </span>
        {/* Collect mode already filed this one. Say so rather than hiding the
          * row: a second copy is a perfectly ordinary thing to want, it just
          * must not be the default. */}
        {scan.added && <span className="batchrow__filed">Already added</span>}
      </div>
      <button className="binderrow__retry" onClick={onDrop} aria-label={`Remove ${scan.card.name} from scans`}>
        <Icon name="x" size={14} />
      </button>
      <span className="binderrow__price">{money(price)}</span>
    </li>
  )
}

export function ScanBatch({
  onClose,
  onOpenCard,
  onAdded,
  onForget,
}: {
  onClose: () => void
  onOpenCard: (card: Card, finish: Finish, printingUnconfirmed: boolean) => void
  onAdded: (added: number, itemIds: string[], scanIds: string[]) => void
  /** Hold a dropped card back, the same way the tray's own × does. */
  onForget: (cardId: string) => void
}) {
  // The tray strip shows the most recent handful; this screen is the whole log
  // (SCAN_TRAY_LIMIT rows), because "add everything I just scanned" is exactly
  // the case where the ones that scrolled off matter.
  const scans = useLiveQuery(() => db.scans.orderBy('at').reverse().toArray(), [])
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [saving, setSaving] = useState(false)

  // Seeded once, from the first load: the camera is stopped while this screen
  // is up, so the only thing that changes the list underneath is the user's
  // own × — which must not re-tick rows they had just turned off.
  useEffect(() => {
    if (!scans || picked) return
    setPicked(new Set(scans.filter((scan) => !scan.added).map((scan) => scan.id)))
  }, [scans, picked])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !saving && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const rows = scans ?? []
  const chosen = useMemo(() => rows.filter((scan) => picked?.has(scan.id)), [rows, picked])
  const value = chosen.reduce((sum, scan) => sum + (rowPrice(scan) ?? 0), 0)
  const allOn = rows.length > 0 && chosen.length === rows.length

  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev ?? [])
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setPicked((prev) => {
      const on = rows.length > 0 && rows.every((scan) => prev?.has(scan.id))
      return on ? new Set() : new Set(rows.map((scan) => scan.id))
    })
  }, [rows])

  /**
   * Dropping a row here is the tray's own remove: it forgets a scan, it never
   * touches a copy already in the collection. Undoable, because the × sits one
   * row away from every other tap on this screen.
   */
  const drop = useCallback(async (scan: ScanRecord) => {
    const removed = await guarded(() => removeScan(scan.id), 'Remove scan')
    if (!removed) return
    // The camera is stopped up here, so nothing re-files while the screen is
    // open — but it restarts on close with the same card still under the lens,
    // which is exactly when a dropped row would put itself straight back.
    onForget(removed.card.id)
    uiStore.getState().toast(`Removed ${removed.card.name} from scans`, 'success', {
      label: 'Undo',
      fn: () => {
        void guarded(() => restoreScans([removed]), 'Undo')
      },
    })
  }, [onForget])

  const addAll = useCallback(async () => {
    if (!chosen.length || saving) return
    setSaving(true)
    const written: string[] = []
    const filed: string[] = []
    let stopped = false
    for (const scan of chosen) {
      // guarded() so a full quota surfaces as a toast rather than an unhandled
      // rejection — thirty rows in one confirm is exactly when storage runs
      // out mid-way.
      const item = await guarded(
        () => addToCollection(scan.card, { finish: scanRowFinish(scan), grade: scan.grade }),
        'Add',
      )
      if (!item) {
        stopped = true
        break
      }
      written.push(item.id)
      filed.push(scan.id)
    }
    await guarded(() => markScansAdded(filed), 'Save scan')
    setSaving(false)
    if (stopped) {
      // guarded() has already said what went wrong. Leave the screen open on
      // what did NOT land — the rows that did are now marked "Already added",
      // so the list itself shows how far it got.
      setPicked(new Set(chosen.filter((scan) => !filed.includes(scan.id)).map((scan) => scan.id)))
      return
    }
    onAdded(filed.length, written, filed)
  }, [chosen, onAdded, saving])

  return (
    <div className="binder" role="dialog" aria-modal="true" aria-label="Review scanned cards">
      <header className="binder__head safe-top">
        <button className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={18} />
        </button>
        <div className="binder__title">
          <h2>{rows.length} {rows.length === 1 ? 'scan' : 'scans'}</h2>
          <span>Tick what to add — nothing is filed until you confirm</span>
        </div>
        {rows.length > 1 && (
          <button className="binder__selectall" onClick={toggleAll}>
            {allOn ? 'None' : 'All'}
          </button>
        )}
      </header>
      {scans && !rows.length && (
        <p className="binder__empty">No scans left. Read a few cards and they'll queue up here.</p>
      )}
      <ul className="binder__list">
        {rows.map((scan) => (
          <BatchRow
            key={scan.id}
            scan={scan}
            picked={!!picked?.has(scan.id)}
            onToggle={() => toggle(scan.id)}
            onOpen={() => onOpenCard(scan.card, scanRowFinish(scan), scan.pinned === false)}
            onDrop={() => void drop(scan)}
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
