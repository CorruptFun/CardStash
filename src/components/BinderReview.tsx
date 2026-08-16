import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from './Icon'
import { Modal } from './basics'
import { BINDER_NAME_MAX, byPage, cleanBinderName, pageLabel } from '../lib/binders'
import { addToCollection, createBinder, db } from '../lib/db'
import { FINISH_LABEL, GAME_SHORT, finishOptions } from '../lib/games'
import type { IdentifyOutcome } from '../lib/identify'
import { rescanPageCard, type PageCard } from '../lib/multiscan'
import { itemUnitPrice, scannedFinish } from '../lib/prices'
import type { Binder, Card, Finish } from '../lib/types'
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
 *
 * ## Why this screen spans a whole binder, not one page
 *
 * Somebody filing a binder shoots page after page, and the thing they want at
 * the end is "those 180 cards are in THIS binder". So the screen accumulates:
 * "Scan another page" hides it, keeps every tick the user has already made,
 * and the next page's rows arrive appended under their own heading. It is
 * never unmounted mid-session — remounting would silently reset the review
 * decisions taken on the pages before, which is exactly the kind of quiet
 * undo this screen exists to prevent.
 *
 * The binder is chosen ONCE, here, and rides onto every row that gets filed
 * along with the page it was read from. That is what a printed label points
 * at later.
 */

/**
 * Confidence at or above which a row arrives ticked. Same bar the scan harness
 * grades name similarity at, and above the 0.7 a collector-line-only
 * identification carries — those are strong evidence but the NAME never read,
 * so on a nine-card confirm they get looked at.
 */
const PRETICK_CONFIDENCE = 0.9

type Row = PageCard & { include: boolean; busy?: boolean }

/** Where the ticked cards are going: nowhere in particular, an existing binder, or a new one. */
type BinderPick = { kind: 'none' } | { kind: 'existing'; id: string } | { kind: 'new'; name: string }

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

/**
 * The label the whole session is filed under.
 *
 * Existing binders first, because the common case after the first session is
 * "more pages of the binder I already started". Naming one is optional and
 * always has been — a page scan that just adds cards must keep working — but
 * it is the only thing that makes a printed QR label possible, so the field
 * says so rather than sitting there unexplained.
 */
function BinderPicker({
  binders,
  pick,
  onPick,
  disabled,
}: {
  binders: Binder[]
  pick: BinderPick
  onPick: (pick: BinderPick) => void
  disabled: boolean
}) {
  const value = pick.kind === 'existing' ? pick.id : pick.kind
  return (
    <div className="binderpick">
      <Icon name="binder" size={15} />
      <select
        className="select select--slim"
        value={value}
        disabled={disabled}
        aria-label="File these cards in a binder"
        onChange={(event) => {
          const next = event.target.value
          if (next === 'none') onPick({ kind: 'none' })
          else if (next === 'new') onPick({ kind: 'new', name: '' })
          else onPick({ kind: 'existing', id: next })
        }}
      >
        <option value="none">No binder</option>
        {binders.map((binder) => (
          <option key={binder.id} value={binder.id}>
            {binder.name}
          </option>
        ))}
        <option value="new">New binder…</option>
      </select>
      {pick.kind === 'new' && (
        <input
          className="input input--inline"
          type="text"
          autoFocus
          maxLength={BINDER_NAME_MAX}
          placeholder="Name this binder"
          value={pick.name}
          disabled={disabled}
          aria-label="New binder name"
          onChange={(event) => onPick({ kind: 'new', name: event.target.value })}
        />
      )}
    </div>
  )
}

export function BinderReview({
  cards,
  hidden = false,
  onClose,
  onScanMore,
  onOpenCard,
  onAdded,
}: {
  cards: PageCard[]
  /** Parked while the camera takes the next page. Never unmounted — see above. */
  hidden?: boolean
  onClose: () => void
  onScanMore?: () => void
  onOpenCard: (card: Card, finish: Finish) => void
  onAdded: (added: number, itemIds: string[], binder: Binder | null) => void
}) {
  const [rows, setRows] = useState<Row[]>(() => cards.map((c) => ({ ...c, include: preTicked(c.outcome) })))
  const [saving, setSaving] = useState(false)
  const [pick, setPick] = useState<BinderPick>({ kind: 'none' })
  const [confirmClose, setConfirmClose] = useState(false)
  const binders = useLiveQuery(() => db.binders.orderBy('updatedAt').reverse().toArray(), [])

  /**
   * Rows already taken from `cards`. A set rather than a look at `rows`,
   * because a partial save REMOVES the rows it filed — matching on the
   * current list would read those as new pages and put them straight back.
   */
  const seen = useRef(new Set(cards.map((card) => card.id)))
  useEffect(() => {
    const fresh = cards.filter((card) => !seen.current.has(card.id))
    if (!fresh.length) return
    for (const card of fresh) seen.current.add(card.id)
    setRows((prev) => [...prev, ...fresh.map((card) => ({ ...card, include: preTicked(card.outcome) }))])
  }, [cards])

  // Escape closes it, the way Modal and Sheet do — a full-screen takeover with
  // no keyboard way out is a trap on desktop.
  /**
   * Closing throws away everything read so far — up to a whole binder of pages,
   * from crops that were released the moment they were read. So the X asks
   * first, and Escape goes through the same door rather than around it.
   */
  const close = useCallback(() => {
    if (rows.length) setConfirmClose(true)
    else onClose()
  }, [onClose, rows.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !saving && !hidden && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, hidden, saving])

  const chosen = useMemo(() => rows.filter((r) => r.include && r.outcome.ok), [rows])
  const found = rows.filter((r) => r.outcome.ok).length
  const pages = useMemo(() => byPage(rows.map((row) => ({ ...row, binderPage: row.page }))), [rows])
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

  /**
   * Resolve the picked binder to a row in the table, creating it if the user
   * typed a new name. Returns `undefined` when the user meant to name one and
   * left it blank — filing 180 cards into "Untitled binder" is not what they
   * asked for, so nothing is written at all.
   */
  const resolveBinder = useCallback(async (): Promise<Binder | null | undefined> => {
    if (pick.kind === 'none') return null
    if (pick.kind === 'existing') return binders?.find((binder) => binder.id === pick.id) ?? null
    const name = cleanBinderName(pick.name)
    if (!name) {
      uiStore.getState().toast('Name the binder, or pick “No binder”', 'info')
      return undefined
    }
    return (await guarded(() => createBinder(name), 'Binder')) ?? undefined
  }, [binders, pick])

  const addAll = useCallback(async () => {
    if (!chosen.length || saving) return
    setSaving(true)
    const binder = await resolveBinder()
    if (binder === undefined) {
      setSaving(false)
      return
    }
    const filed = new Set<string>()
    const written: string[] = []
    let stopped = false
    for (const row of chosen) {
      const hit = row.outcome as Extract<IdentifyOutcome, { ok: true }>
      // Every write goes through guarded() so a full quota surfaces as a toast
      // rather than an unhandled rejection — and a page of nine is exactly
      // when storage runs out.
      const item = await guarded(
        () =>
          addToCollection(hit.card, {
            finish: rowFinish(hit),
            binderId: binder?.id,
            // The page it was read from, so the card can be found in the
            // physical binder and not just in the app.
            binderPage: binder ? row.page : undefined,
          }),
        'Add',
      )
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
    onAdded(filed.size, written, binder)
  }, [chosen, onAdded, resolveBinder, saving])

  const multiPage = pages.length > 1
  return (
    <div
      className={`binder ${hidden ? 'binder--parked' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Review scanned cards"
      aria-hidden={hidden || undefined}
      inert={hidden}
    >
      <header className="binder__head safe-top">
        <button className="iconbtn" onClick={close} aria-label="Cancel" disabled={saving}>
          <Icon name="x" size={18} />
        </button>
        <div className="binder__title">
          <h2>
            {found} of {rows.length} identified
          </h2>
          <span>
            {multiPage ? `${pages.length} pages · ` : ''}Tick what to add — nothing is filed until you confirm
          </span>
        </div>
      </header>
      <BinderPicker binders={binders ?? []} pick={pick} onPick={setPick} disabled={saving} />
      {!found && (
        <p className="binder__empty">
          Nothing on this page could be read. Fill the frame with the page, hold still, and try again — or read a
          card on its own.
        </p>
      )}
      <ul className="binder__list">
        {pages.map((group) => (
          <li key={group.page ?? 'unpaged'} className="binder__page">
            {multiPage && (
              <h3 className="binder__pagehead">
                <span>{pageLabel(group.page)}</span>
                <em>{group.rows.filter((row) => row.include).length} of {group.rows.length} ticked</em>
              </h3>
            )}
            <ul>
              {group.rows.map((row, index) => (
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
          </li>
        ))}
      </ul>
      <footer className="binder__foot safe-bottom">
        <div className="binder__sum">
          <strong>{chosen.length} selected</strong>
          <span>{money(value)}</span>
        </div>
        {onScanMore && (
          <button className="btn btn--ghost" onClick={onScanMore} disabled={saving}>
            <Icon name="camera" size={15} /> Next page
          </button>
        )}
        <button className="btn btn--primary" disabled={!chosen.length || saving} onClick={() => void addAll()}>
          {saving ? 'Adding…' : `Add ${chosen.length} ${chosen.length === 1 ? 'card' : 'cards'}`}
        </button>
      </footer>
      {confirmClose && (
        <Modal open onClose={() => setConfirmClose(false)} title="Discard these scans?">
          <p className="setsec__note">
            {rows.length} {rows.length === 1 ? 'card' : 'cards'}
            {pages.length > 1 ? ` from ${pages.length} pages` : ''} would be thrown away. They are not saved anywhere
            yet, and the photos they were read from are already gone.
          </p>
          <div className="modalactions">
            <button className="btn btn--ghost" onClick={() => setConfirmClose(false)}>
              Keep reviewing
            </button>
            <button
              className="btn btn--danger"
              onClick={() => {
                setConfirmClose(false)
                onClose()
              }}
            >
              Discard
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
