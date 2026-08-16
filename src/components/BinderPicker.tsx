import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from './Icon'
import { Modal } from './basics'
import { VISIBILITY_LABEL } from '../lib/binders'
import { addToBinder, createBinder, db } from '../lib/db'
import { guarded, useUi } from '../store/ui'

/**
 * "Which binder?" — the `DeckPicker` of binders, with one difference that
 * matters: it takes a **collection row**, not a card.
 *
 * A binder holds copies you own, so the thing being filed has a finish, a
 * condition and possibly a grade, and those come from the row rather than from
 * the card. That is also why this offers no path from a card you do not own:
 * the honest answer there is "add it to your collection first", which the
 * sheet's own Add button already is.
 */
export function BinderPicker({
  open,
  onClose,
  itemId,
  cardName,
}: {
  open: boolean
  onClose: () => void
  itemId: string
  cardName: string
}) {
  const binders = useLiveQuery(() => db.binders.orderBy('updatedAt').reverse().toArray(), [])
  const rows = useLiveQuery(() => db.binderCards.where('itemId').equals(itemId).toArray(), [itemId])
  const [name, setName] = useState('')
  const toast = useUi((s) => s.toast)

  const held = new Map((rows ?? []).map((row) => [row.binderId, row.qty]))

  const add = async (binderId: string, binderName: string) => {
    const ok = await guarded(async () => (await addToBinder(binderId, itemId), true), 'Binder')
    if (ok) toast(`Added to “${binderName}”`, 'success')
  }

  const createAndAdd = async () => {
    const clean = name.trim()
    if (!clean) return
    const binder = await guarded(() => createBinder(clean), 'New binder')
    if (!binder) return
    setName('')
    await add(binder.id, binder.name)
  }

  return (
    <Modal open={open} onClose={onClose} title={`Add ${cardName} to a binder`}>
      <div className="deckpicker">
        {binders && binders.length === 0 && (
          <p className="deckpicker__empty">
            No binders yet. Name one below — it starts private, and nothing is uploaded until you say so.
          </p>
        )}
        {(binders ?? []).map((binder) => {
          const have = held.get(binder.id) ?? 0
          return (
            <button key={binder.id} className="deckpicker__row" onClick={() => void add(binder.id, binder.name)}>
              <span className="deckpicker__text">
                <span className="deckpicker__name">{binder.name}</span>
                <em>
                  {VISIBILITY_LABEL[binder.visibility]}
                  {binder.tradeable && binder.visibility !== 'private' ? ' · for trade' : ''}
                </em>
              </span>
              {have > 0 ? (
                <span className="deckpicker__have">
                  <Icon name="check" size={12} /> ×{have} in binder
                </span>
              ) : (
                <span className="deckpicker__add">
                  <Icon name="plus" size={15} />
                </span>
              )}
            </button>
          )
        })}
        <div className="addfriend">
          <input
            className="input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void createAndAdd()}
            placeholder="New binder…"
            maxLength={60}
            aria-label="New binder name"
          />
          <button className="btn btn--ghost" onClick={() => void createAndAdd()} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </Modal>
  )
}
