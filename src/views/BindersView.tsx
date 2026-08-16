import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, Empty, Modal, Seg, Stepper } from '../components/basics'
import { BinderLabel } from '../components/BinderLabel'
import { Icon } from '../components/Icon'
import { ShareActions, type SharePack } from '../components/ShareActions'
import { Sheet } from '../components/Sheet'
import {
  VISIBILITY_BLURB,
  VISIBILITY_LABEL,
  binderQty,
  binderSharedCards,
  byPage,
  pageLabel,
  binderValue,
  isDiscoverable,
  isPublished,
  resolveBinderRows,
  type BinderRow,
} from '../lib/binders'
import {
  addToBinder,
  createBinder,
  db,
  deleteBinder,
  removeFromBinder,
  setBinderCardQty,
  updateBinder,
} from '../lib/db'
import { isFoilFinish } from '../lib/games'
import { itemUnitPrice } from '../lib/prices'
import { settings } from '../lib/settings'
import { buildBinderPayload, encodeBlob, myProfile, payloadFileText, shareUrl } from '../lib/social'
import { socialConfigured, unpublishCustomBinder } from '../lib/socialcloud'
import type { BinderVisibility, CollectionItem } from '../lib/types'
import { money, relativeAge, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'

const NO_ITEMS: CollectionItem[] = []

/**
 * Binders the user builds by hand: the list, and one of them.
 *
 * These sit BESIDE the whole-collection binder on the Friends screen, they do
 * not replace it — see decision 26. Each carries its own audience, so a public
 * binder is possible while the collection behind it stays private, and every
 * one of them can be handed over as a link with no account at all.
 */
export function BindersView({ binderId }: { binderId: string | null }) {
  return binderId ? <BinderDetail key={binderId} binderId={binderId} /> : <BinderList />
}

/* ---------------------------------------------------------------- the list */

function BinderList() {
  const binders = useLiveQuery(() => db.binders.orderBy('updatedAt').reverse().toArray(), [])
  const rows = useLiveQuery(() => db.binderCards.toArray(), [])
  const items = useLiveQuery(() => db.collection.toArray(), []) ?? NO_ITEMS
  const [name, setName] = useState('')
  const toast = useUi((s) => s.toast)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const { row } of resolveBinderRows(rows ?? [], items)) {
      map.set(row.binderId, (map.get(row.binderId) ?? 0) + row.qty)
    }
    return map
  }, [rows, items])

  const create = async () => {
    const clean = name.trim()
    if (!clean) return
    const binder = await guarded(() => createBinder(clean), 'New binder')
    if (!binder) return
    setName('')
    toast(`Created “${binder.name}”`, 'success')
    location.hash = `#/binders/${binder.id}`
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <a className="iconbtn" href="#/friends" aria-label="Back to friends">
          <Icon name="chevronLeft" size={20} />
        </a>
        <h1>My binders</h1>
      </header>

      <section className="setsec">
        <div className="addfriend">
          <input
            className="input"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void create()}
            placeholder="New binder — “Vintage Charizards”"
            maxLength={60}
            aria-label="New binder name"
          />
          <button className="btn btn--primary" onClick={() => void create()} disabled={!name.trim()}>
            <Icon name="plus" size={16} /> Create
          </button>
        </div>
        <p className="setsec__note">
          A binder is a selection of copies you own, with its own audience. Every one starts <b>private</b> — nothing
          is uploaded until you say so, and you can hand someone a link either way.
        </p>
      </section>

      {binders && binders.length === 0 && (
        <Empty
          icon="cards"
          title="No binders yet"
          body="Make one for the cards you’re selling this weekend, or the run you’re proud of. Add cards from any card’s sheet, or from inside the binder."
        />
      )}

      <div className="social-list">
        {(binders ?? []).map((binder) => {
          const count = counts.get(binder.id) ?? 0
          return (
            <a className="social-row" key={binder.id} href={`#/binders/${binder.id}`}>
              <span className="social-row__avatar social-row__avatar--trade" aria-hidden="true">
                <Icon name="cards" size={16} />
              </span>
              <span className="social-row__body">
                {/* The name gets the whole line. A badge beside it competes
                    with the ellipsis and loses — "Vintage Charizards…" with
                    the badge clipped off is worse than either alone. */}
                <span className="social-row__name">{binder.name}</span>
                <span className="social-row__meta">
                  {count} {count === 1 ? 'card' : 'cards'}
                  {isDiscoverable(binder) ? ' · for trade' : ''} · updated {relativeAge(binder.updatedAt)} ago
                </span>
              </span>
              <span className={`vispill vispill--${binder.visibility}`}>{VISIBILITY_LABEL[binder.visibility]}</span>
              <Icon name="chevronRight" size={16} className="social-row__go" />
            </a>
          )
        })}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- one binder */

function BinderDetail({ binderId }: { binderId: string }) {
  /**
   * `?? null` is load-bearing: Dexie resolves a missing row to `undefined`,
   * which is the same value `useLiveQuery` reports while it is still running.
   * Without it the "No such binder" state below is unreachable and the screen
   * stays blank for ever — which stopped being a hand-typed-URL curiosity the
   * moment binders started carrying printed labels that outlive the device
   * that made them.
   */
  const binder = useLiveQuery(async () => (await db.binders.get(binderId)) ?? null, [binderId])
  const cardRows = useLiveQuery(() => db.binderCards.where('binderId').equals(binderId).toArray(), [binderId])
  const items = useLiveQuery(() => db.collection.toArray(), []) ?? NO_ITEMS
  const toast = useUi((s) => s.toast)
  const openSheet = useUi((s) => s.openSheet)
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [labelOpen, setLabelOpen] = useState(false)
  const [pack, setPack] = useState<SharePack | null>(null)

  const rows = useMemo(() => resolveBinderRows(cardRows ?? [], items), [cardRows, items])
  const qty = binderQty(rows)
  const value = binderValue(rows)

  if (binder === undefined) return <div className="screen safe-top" />
  if (!binder) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <a className="iconbtn" href="#/binders" aria-label="Back to binders">
            <Icon name="chevronLeft" size={20} />
          </a>
          <h1>Binder</h1>
        </header>
        <Empty icon="cards" title="No such binder" body="It may have been deleted on this device." />
      </div>
    )
  }

  /**
   * Changing the audience is written straight through, and taking a binder
   * DOWN is pushed immediately rather than waiting for the next poll — the
   * 25-second gap is fine for publishing something and is not fine for
   * un-publishing it.
   */
  const setVisibility = async (visibility: BinderVisibility) => {
    const wasPublished = isPublished(binder)
    await guarded(async () => (await updateBinder(binder.id, { visibility }), true), 'Binder')
    if (wasPublished && visibility === 'private' && socialConfigured()) {
      await unpublishCustomBinder(binder.id).catch(() => {
        toast('Saved here — it will come down from the server on the next sync', 'info')
      })
    }
  }

  const share = async () => {
    const payload = buildBinderPayload(binder, binderSharedCards(rows, binder.tradeable), myProfile())
    if (!payload.cards.length) {
      toast('Add some cards to this binder first', 'error')
      return
    }
    const blob = await encodeBlob(payload)
    setPack({
      url: shareUrl(blob),
      fileText: payloadFileText(payload),
      fileName: `cardstock-binder-${ymd()}.json`,
      title: `${binder.name} — ${settings().profileName || 'a Cardstock collector'}`,
      text: `${binder.name} — ${payload.cards.length} cards in Cardstock`,
      kind: 'profile',
    })
  }

  const remove = async () => {
    await guarded(async () => (await deleteBinder(binder.id), true), 'Delete binder')
    setConfirmDelete(false)
    toast(`Deleted “${binder.name}”`, 'success')
    location.hash = '#/binders'
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead friendhead">
        <a className="iconbtn" href="#/binders" aria-label="Back to binders">
          <Icon name="chevronLeft" size={20} />
        </a>
        <div className="friendhead__id">
          <h1>{binder.name}</h1>
          <span className="friendhead__meta">
            {qty} {qty === 1 ? 'card' : 'cards'} · {money(value)}
          </span>
        </div>
      </header>

      <section className="setsec">
        <input
          className="input"
          type="text"
          value={binder.name}
          onChange={(event) => void updateBinder(binder.id, { name: event.target.value })}
          maxLength={60}
          aria-label="Binder name"
        />
        <input
          className="input"
          type="text"
          value={binder.note ?? ''}
          onChange={(event) => void updateBinder(binder.id, { note: event.target.value })}
          placeholder="What’s in it, or what you want for it"
          maxLength={140}
          aria-label="Binder note"
        />
      </section>

      <section className="setsec">
        <h3>Who can see it</h3>
        <Seg
          ariaLabel="Who can see this binder"
          size="sm"
          options={[
            { value: 'private', label: 'Private' },
            { value: 'friends', label: 'Friends' },
            { value: 'public', label: 'Public' },
          ]}
          value={binder.visibility}
          onChange={(next) => void setVisibility(next as BinderVisibility)}
        />
        {/* The audience is named, never described in the abstract — the same
            standard the SocialPanel banner is held to. Anyone flipping this
            must know which thing they just did. */}
        <div className={`audience audience--${binder.visibility === 'public' ? 'open' : 'friends'}`}>
          <Icon
            name={binder.visibility === 'private' ? 'eye' : binder.visibility === 'public' ? 'eye' : 'users'}
            size={15}
          />
          <span>{VISIBILITY_BLURB[binder.visibility]}</span>
        </div>
        {!socialConfigured() && binder.visibility !== 'private' && (
          <p className="setsec__note">
            Claim a handle on the Friends screen and this goes up automatically. Until then it stays on this device —
            the link below still works for anyone you send it to.
          </p>
        )}
        <div className="setrow">
          <div className="setrow__text">
            <span>Offer these for trade</span>
            <em>
              {binder.visibility === 'public'
                ? 'Collectors hunting these cards find you, and can message you about them.'
                : 'Takes effect when this binder is public — a friends-only binder is never globally matchable.'}
            </em>
          </div>
          <button
            className={`btn btn--sm ${binder.tradeable ? 'btn--primary' : 'btn--ghost'}`}
            onClick={() => void updateBinder(binder.id, { tradeable: !binder.tradeable })}
          >
            {binder.tradeable ? 'On' : 'Off'}
          </button>
        </div>
      </section>

      <section className="setsec">
        <div className="friendacts">
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add cards
          </button>
          <button className="btn btn--ghost" onClick={share} disabled={!rows.length}>
            <Icon name="share" size={15} /> Share
          </button>
          {/* The physical half of a binder. Nothing about it touches the
            * network or the binder's audience: the QR is a link to this app's
            * own route, and it carries no cards. */}
          <button className="btn btn--ghost" onClick={() => setLabelOpen(true)}>
            <Icon name="qr" size={15} /> Print label
          </button>
          <button className="btn btn--ghost" onClick={() => setConfirmDelete(true)}>
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>
        {pack && <ShareActions pack={pack} />}
        <p className="setsec__note">
          A link works with no account on either side — it carries this binder only, and lands under your name on
          their Friends tab without touching anything else they have of yours.
        </p>
      </section>

      {rows.length === 0 && (
        <Empty
          icon="cards"
          title="Nothing in this binder yet"
          body="Add cards you own — the finish, condition and grade come from the copy in your collection, so what you show is what you have."
        />
      )}

      {/* Grouped by the page they were scanned off, so the app and the object
        * on the shelf read the same way round. Headings appear only once pages
        * exist to tell apart — a lone "UNPAGED" labels nothing. */}
      {byPage(rows, ({ row }) => row.page).map((group) => (
        <section className="binderpage" key={group.page ?? 'unpaged'}>
          {group.page != null && (
            <h2 className="binderpage__head">
              <span>{pageLabel(group.page)}</span>
              <em>
                {group.rows.length} {group.rows.length === 1 ? 'card' : 'cards'}
              </em>
            </h2>
          )}
          <div className="cardgrid">
            {group.rows.map(({ row, item }) => (
              <div className="bindercell" key={row.id}>
                <button
                  className="cardcell"
                  onClick={() => openSheet({ card: item.card, item, origin: 'collection' })}
                  aria-label={item.name}
                >
                  <CardImg card={item.card} foil={isFoilFinish(item.finish)} />
                  <span className="cardcell__price">{money((itemUnitPrice(item) ?? 0) * row.qty)}</span>
                  <span className="cardcell__name">{item.name}</span>
                  <span className="cardcell__set">
                    {item.setCode ?? item.card.setCode}
                    {item.condition !== 'NM' ? ` · ${item.condition}` : ''}
                  </span>
                </button>
                <div className="bindercell__qty">
                  <Stepper
                    value={row.qty}
                    min={0}
                    max={item.qty}
                    onChange={(next) => void setBinderCardQty(row.id, next)}
                  />
                  <button
                    className="bindercell__x"
                    aria-label={`Remove ${item.name} from this binder`}
                    onClick={() => void removeFromBinder(row.id)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {labelOpen && <BinderLabel binder={binder} count={qty} onClose={() => setLabelOpen(false)} />}

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete “${binder.name}”?`}>
        <p className="setsec__note">
          The binder goes, and it comes down from the server if it was up. <b>Your cards are not touched</b> — a binder
          is an arrangement of copies you own, never the copies themselves.
        </p>
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={remove}>
            Delete
          </button>
        </div>
      </Modal>

      <Sheet open={adding} onClose={() => setAdding(false)} tall>
        {adding && <AddCards binderId={binder.id} items={items} rows={rows} />}
      </Sheet>
    </div>
  )
}

/**
 * Fill a binder from the collection.
 *
 * The bulk path, and the one that matters: building a thirty-card binder one
 * card sheet at a time is how a feature gets tried once. Rows already in the
 * binder stay listed with a tick rather than disappearing, so tapping twice is
 * "two copies" instead of a card vanishing out from under the finger.
 */
function AddCards({ binderId, items, rows }: { binderId: string; items: CollectionItem[]; rows: BinderRow[] }) {
  const [filter, setFilter] = useState('')
  const inBinder = useMemo(() => new Map(rows.map(({ row }) => [row.itemId, row.qty])), [rows])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return items
      .filter((item) => item.qty > 0 && item.opened !== true)
      .filter(
        (item) =>
          !needle ||
          item.name.toLowerCase().includes(needle) ||
          (item.setCode ?? item.card.setCode ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => (itemUnitPrice(b) ?? 0) - (itemUnitPrice(a) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, 300)
  }, [items, filter])

  return (
    <div className="sheetbody">
      <h2 className="sheettitle">Add cards</h2>
      <div className="searchbox searchbox--slim">
        <Icon name="search" size={16} />
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter your collection…"
          aria-label="Filter your collection"
        />
      </div>
      {shown.length === 0 && <p className="deckpicker__empty">Nothing in your collection matches that.</p>}
      <div className="social-list">
        {shown.map((item) => {
          const have = inBinder.get(item.id) ?? 0
          return (
            <button
              key={item.id}
              className="social-row social-row--static"
              onClick={() => void addToBinder(binderId, item.id)}
              disabled={have >= item.qty}
            >
              <span className="pickcell">
                <CardImg card={item.card} foil={isFoilFinish(item.finish)} />
              </span>
              <span className="social-row__body">
                <span className="social-row__name">{item.name}</span>
                <span className="social-row__meta">
                  {[item.setCode ?? item.card.setCode, item.condition, `×${item.qty} owned`]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {have > 0 ? (
                <span className="deckpicker__have">
                  <Icon name="check" size={12} /> ×{have}
                </span>
              ) : (
                <span className="deckpicker__add">
                  <Icon name="plus" size={15} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
