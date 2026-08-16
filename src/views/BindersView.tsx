import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, Empty, Modal } from '../components/basics'
import { BinderLabel } from '../components/BinderLabel'
import { Icon } from '../components/Icon'
import { BINDER_NAME_MAX, BINDER_NOTE_MAX, byPage, pageLabel } from '../lib/binders'
import { createBinder, db, deleteBinder, setItemsBinder, updateBinder } from '../lib/db'
import { GAME_SHORT, isFoilFinish } from '../lib/games'
import { collectionValue, itemUnitPrice, totalQty } from '../lib/prices'
import type { Binder, CollectionItem } from '../lib/types'
import { money } from '../lib/util'
import { guarded, useUi } from '../store/ui'

/**
 * Binders — the physical shelf, in the app.
 *
 * A binder is a label, and this screen is where labels get made, printed and
 * thrown away. The one rule the whole screen is built around: a binder never
 * owns its cards. Deleting one unfiles 200 rows and deletes nothing, which is
 * what makes the delete button safe to put next to the rename button, and it
 * is said out loud in the confirm rather than left to be discovered.
 *
 * The cards are listed by PAGE, because the reason to open a binder in the app
 * while holding the physical one is to find out which page a card is on.
 */

const NO_ITEMS: CollectionItem[] = []

/** New / rename, one form. Both write through db.ts so `updatedAt` moves. */
function BinderEditor({
  binder,
  onClose,
  onSaved,
}: {
  binder: Binder | null
  onClose: () => void
  onSaved: (binder: Binder | null) => void
}) {
  const [name, setName] = useState(binder?.name ?? '')
  const [note, setNote] = useState(binder?.note ?? '')
  const save = async () => {
    if (!name.trim()) return
    if (binder) {
      const ok = await guarded(async () => (await updateBinder(binder.id, { name, note }), true), 'Binder')
      if (ok) onSaved({ ...binder, name, note })
      return
    }
    const created = await guarded(() => createBinder(name, note), 'Binder')
    if (created) onSaved(created)
  }
  return (
    <Modal open onClose={onClose} title={binder ? 'Rename binder' : 'New binder'}>
      <div className="form">
        <input
          className="input"
          autoFocus
          maxLength={BINDER_NAME_MAX}
          placeholder="Binder name"
          aria-label="Binder name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void save()}
        />
        <input
          className="input"
          maxLength={BINDER_NOTE_MAX}
          placeholder="Where it lives — “shelf 2, left” (optional)"
          aria-label="Where the binder lives"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!name.trim()} onClick={() => void save()}>
            {binder ? 'Save' : 'Create binder'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

function BinderRow({ binder, items, onOpen }: { binder: Binder; items: CollectionItem[]; onOpen: () => void }) {
  const count = totalQty(items)
  const value = collectionValue(items)
  return (
    <button className="binderitem" onClick={onOpen}>
      <span className="binderitem__icon">
        <Icon name="binder" size={20} />
      </span>
      <span className="binderitem__body">
        <strong>{binder.name}</strong>
        <span className="binderitem__meta">
          {count} {count === 1 ? 'card' : 'cards'}
          {binder.note ? ` · ${binder.note}` : ''}
        </span>
      </span>
      <span className="binderitem__value">{money(value)}</span>
      <Icon name="chevronRight" size={15} />
    </button>
  )
}

function BinderList({ navigate }: { navigate: (hash: string) => void }) {
  const binders = useLiveQuery(() => db.binders.orderBy('updatedAt').reverse().toArray(), [])
  const filed = useLiveQuery(() => db.collection.filter((item) => !!item.binderId).toArray(), []) ?? NO_ITEMS
  const [creating, setCreating] = useState(false)
  const byBinder = useMemo(() => {
    const map = new Map<string, CollectionItem[]>()
    for (const item of filed) {
      if (!item.binderId) continue
      map.set(item.binderId, [...(map.get(item.binderId) ?? []), item])
    }
    return map
  }, [filed])

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Binders</h1>
        <button className="btn btn--ghost btn--sm" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> New
        </button>
      </header>
      {binders && binders.length === 0 ? (
        <Empty
          icon="binder"
          title="No binders yet"
          body="A binder is a label for a real one on your shelf. Make one, file cards into it — scan a page in Page mode, or select rows in your collection — then print its QR code and stick it on the cover."
          action={
            <div className="empty__btns">
              <button className="btn btn--primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> New binder
              </button>
              <a className="btn btn--ghost" href="#/scan">
                <Icon name="scan" size={16} /> Scan a page
              </a>
            </div>
          }
        />
      ) : (
        <div className="binderlist">
          {(binders ?? []).map((binder) => (
            <BinderRow
              key={binder.id}
              binder={binder}
              items={byBinder.get(binder.id) ?? NO_ITEMS}
              onOpen={() => navigate(`#/binders/${binder.id}`)}
            />
          ))}
        </div>
      )}
      {creating && (
        <BinderEditor
          binder={null}
          onClose={() => setCreating(false)}
          onSaved={(binder) => {
            setCreating(false)
            if (binder) navigate(`#/binders/${binder.id}`)
          }}
        />
      )}
    </div>
  )
}

function BinderDetail({ binderId, navigate }: { binderId: string; navigate: (hash: string) => void }) {
  /**
   * `?? null` is load-bearing: Dexie resolves a missing row to `undefined`,
   * which is the same value `useLiveQuery` reports while it is still running.
   * Without it, a QR pointing at a binder this device has never had renders a
   * blank screen for ever instead of saying so.
   */
  const binder = useLiveQuery(async () => (await db.binders.get(binderId)) ?? null, [binderId])
  const items = useLiveQuery(() => db.collection.where('binderId').equals(binderId).toArray(), [binderId]) ?? NO_ITEMS
  const openSheet = useUi((s) => s.openSheet)
  const toast = useUi((s) => s.toast)
  const [labelOpen, setLabelOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const pages = useMemo(
    () => byPage([...items].sort((a, b) => a.name.localeCompare(b.name))),
    [items],
  )
  const count = totalQty(items)
  const value = collectionValue(items)

  // A binder that was deleted on another device, or a QR pointing at one this
  // device has never had. Say which, rather than showing an empty binder that
  // looks like a bug.
  if (binder === undefined) return null
  if (binder === null) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <a className="iconbtn" href="#/binders" aria-label="All binders">
            <Icon name="chevronLeft" size={20} />
          </a>
          <h1>Binder</h1>
        </header>
        <Empty
          icon="binder"
          title="No such binder on this device"
          body="That label was made in another install, or it has since been deleted. Binders live on the device that made them — restore a backup, or turn on the cloud vault to bring them across."
          action={
            <a className="btn btn--ghost" href="#/binders">
              All binders
            </a>
          }
        />
      </div>
    )
  }

  const removeBinder = async () => {
    const unfiled = await guarded(() => deleteBinder(binder.id), 'Delete binder')
    setConfirmDelete(false)
    if (unfiled == null) return
    toast(`Deleted ${binder.name} · ${unfiled} ${unfiled === 1 ? 'card kept' : 'cards kept'}`, 'success')
    navigate('#/binders')
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead binderhead">
        <a className="iconbtn" href="#/binders" aria-label="All binders">
          <Icon name="chevronLeft" size={20} />
        </a>
        <div className="binderhead__id">
          <h1>{binder.name}</h1>
          <span className="binderhead__meta">
            {count} {count === 1 ? 'card' : 'cards'} · {money(value)}
            {binder.note ? ` · ${binder.note}` : ''}
          </span>
        </div>
      </header>
      <div className="colltools">
        <button className="btn btn--primary btn--sm" onClick={() => setLabelOpen(true)}>
          <Icon name="qr" size={15} /> Print label
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setRenaming(true)}>
          <Icon name="pencil" size={15} /> Rename
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>
      {!items.length && (
        <Empty
          icon="cards"
          title="Nothing filed here yet"
          body="Scan a page in Page mode and pick this binder on the review screen — or select rows in your collection and tap Binder."
          action={
            <a className="btn btn--primary" href="#/scan">
              <Icon name="scan" size={16} /> Scan a page
            </a>
          }
        />
      )}
      {pages.map((group) => (
        <section key={group.page ?? 'unpaged'} className="binderpage">
          {/* One unpaged pile is just "the binder" — a lone "UNPAGED" heading
            * labels nothing. Headings appear once pages exist to tell apart. */}
          {(pages.length > 1 || group.page != null) && (
            <h2 className="binderpage__head">
              <span>{pageLabel(group.page)}</span>
              <em>
                {group.rows.length} {group.rows.length === 1 ? 'card' : 'cards'}
              </em>
            </h2>
          )}
          <div className="cardgrid">
            {group.rows.map((item) => (
              <button
                key={item.id}
                className="cardcell"
                onClick={() => openSheet({ card: item.card, item, origin: 'collection' })}
              >
                <CardImg card={item.card} foil={isFoilFinish(item.finish)} />
                {item.qty > 1 && <span className="cardcell__qty">×{item.qty}</span>}
                <span className="cardcell__price">{money((itemUnitPrice(item) ?? 0) * item.qty)}</span>
                <span className="cardcell__name">{item.name}</span>
                <span className="cardcell__set">{item.setCode ?? GAME_SHORT[item.game]}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {labelOpen && <BinderLabel binder={binder} count={count} onClose={() => setLabelOpen(false)} />}
      {renaming && (
        <BinderEditor binder={binder} onClose={() => setRenaming(false)} onSaved={() => setRenaming(false)} />
      )}
      {confirmDelete && (
        <Modal open onClose={() => setConfirmDelete(false)} title={`Delete ${binder.name}?`}>
          <p className="setsec__note">
            The label goes; the {count} {count === 1 ? 'card' : 'cards'} stay in your collection, unfiled. Any printed
            QR code for this binder stops working.
          </p>
          <div className="modalactions">
            <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
            <button className="btn btn--danger" onClick={() => void removeBinder()}>
              Delete binder
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export function BindersView({ binderId, navigate }: { binderId: string | null; navigate: (hash: string) => void }) {
  return binderId ? <BinderDetail binderId={binderId} navigate={navigate} /> : <BinderList navigate={navigate} />
}

/**
 * Move a selection of collection rows into a binder — the manual half of
 * filing, for the cards that were already in the app before their binder was.
 * Lives here so the picker and the screen it files into never drift apart.
 */
export function BinderPickerModal({
  open,
  ids,
  onClose,
}: {
  open: boolean
  ids: string[]
  onClose: () => void
}) {
  const binders = useLiveQuery(() => db.binders.orderBy('updatedAt').reverse().toArray(), [])
  const toast = useUi((s) => s.toast)
  const [creating, setCreating] = useState(false)
  if (!open) return null

  const file = async (binder: Binder | null) => {
    const ok = await guarded(async () => (await setItemsBinder(ids, binder?.id ?? null), true), 'Binder')
    if (!ok) return
    const noun = `${ids.length} ${ids.length === 1 ? 'row' : 'rows'}`
    toast(binder ? `Filed ${noun} in ${binder.name}` : `Unfiled ${noun}`, 'success')
    onClose()
  }

  if (creating) {
    return (
      <BinderEditor
        binder={null}
        onClose={() => setCreating(false)}
        onSaved={(binder) => {
          setCreating(false)
          if (binder) void file(binder)
        }}
      />
    )
  }

  return (
    <Modal open onClose={onClose} title={`File ${ids.length} ${ids.length === 1 ? 'row' : 'rows'}`}>
      <div className="binderlist binderlist--picker">
        {(binders ?? []).map((binder) => (
          <button key={binder.id} className="binderitem" onClick={() => void file(binder)}>
            <span className="binderitem__icon">
              <Icon name="binder" size={18} />
            </span>
            <span className="binderitem__body">
              <strong>{binder.name}</strong>
              {binder.note && <span className="binderitem__meta">{binder.note}</span>}
            </span>
          </button>
        ))}
      </div>
      <div className="modalactions">
        <button className="btn btn--ghost" onClick={() => void file(null)}>
          Take out of binder
        </button>
        <button className="btn btn--primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> New binder
        </button>
      </div>
    </Modal>
  )
}
