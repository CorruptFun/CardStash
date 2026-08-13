import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, Empty, Modal, Seg, Stepper } from '../components/basics'
import { Icon } from '../components/Icon'
import { ShareActions, type SharePack } from '../components/ShareActions'
import { Sheet } from '../components/Sheet'
import { TradeSides } from '../components/TradeSides'
import { track } from '../lib/analytics'
import { db, removeFriend, saveTrade, upsertFriendFromProfile } from '../lib/db'
import { FINISH_LABEL, GAME_SHORT, GAMES } from '../lib/games'
import {
  buildTradePayload,
  encodeBlob,
  fetchSharedProfile,
  itemToSharedCard,
  myProfile,
  payloadFileText,
  sharedCardToCard,
  sharedRowValue,
  shareUrl,
  sideQty,
  sideValue,
} from '../lib/social'
import type { CollectionItem, Friend, Game, SharedCard, TradeRecord } from '../lib/types'
import { money, relativeAge, uid, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'

const NO_ITEMS: CollectionItem[] = []

function rowKey(row: SharedCard): string {
  return `${row.cardId}|${row.finish}|${row.condition}|${row.setCode ?? ''}|${row.number ?? ''}`
}

function matchesFilter(row: SharedCard, needle: string): boolean {
  if (!needle) return true
  return row.name.toLowerCase().includes(needle) || (row.setCode ?? '').toLowerCase().includes(needle)
}

export function FriendBinderView({ friendId }: { friendId: string }) {
  const friend = useLiveQuery(() => db.friends.get(friendId), [friendId])
  const myItems = useLiveQuery(() => db.collection.toArray(), []) ?? NO_ITEMS
  const openSheet = useUi((s) => s.openSheet)
  const toast = useUi((s) => s.toast)
  const [tab, setTab] = useState<'trade' | 'all' | null>(null)
  const [filterText, setFilterText] = useState('')
  const [gameFilter, setGameFilter] = useState<Game | 'all'>('all')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [composing, setComposing] = useState(false)

  const cards = friend?.cards ?? []
  const tradeRows = useMemo(() => cards.filter((row) => row.forTrade > 0), [cards])
  const hasBoth = friend?.scope === 'all' && tradeRows.length > 0 && tradeRows.length < cards.length
  const activeTab = tab ?? (tradeRows.length > 0 ? 'trade' : 'all')
  const games = useMemo(() => GAMES.filter((game) => cards.some((row) => row.game === game)), [cards])

  const shown = useMemo(() => {
    let rows = activeTab === 'trade' && hasBoth ? tradeRows : cards
    if (gameFilter !== 'all') rows = rows.filter((row) => row.game === gameFilter)
    const needle = filterText.trim().toLowerCase()
    if (needle) rows = rows.filter((row) => matchesFilter(row, needle))
    return [...rows].sort((a, b) => sharedRowValue(b) - sharedRowValue(a) || a.name.localeCompare(b.name))
  }, [cards, tradeRows, activeTab, hasBoth, gameFilter, filterText])

  const stats = useMemo(
    () => ({
      count: cards.reduce((sum, row) => sum + row.qty, 0),
      trade: tradeRows.reduce((sum, row) => sum + row.forTrade, 0),
      value: sideValue(cards),
    }),
    [cards, tradeRows],
  )

  if (friend === undefined) return <div className="screen safe-top" />
  if (!friend) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <a className="iconbtn" href="#/friends" aria-label="Back to friends">
            <Icon name="chevronLeft" size={20} />
          </a>
          <h1>Friend</h1>
        </header>
        <Empty icon="users" title="Not following this binder" body="It may have been removed on this device." />
      </div>
    )
  }

  const refresh = async () => {
    if (!friend.sourceUrl || refreshing) return
    setRefreshing(true)
    try {
      const payload = await fetchSharedProfile(friend.sourceUrl)
      if (payload.id !== friend.id) toast('That link now holds a different binder — adding it separately', 'info')
      const result = await guarded(() => upsertFriendFromProfile(payload, friend.sourceUrl), 'Refresh')
      if (result) {
        track('friend_added', { method: 'url', cards: payload.cards.length, update: true })
        toast(`Refreshed ${result.friend.name} — ${payload.cards.length} rows`, 'success')
        if (payload.id !== friend.id) location.hash = `#/friends/${payload.id}`
      }
    } catch (err: any) {
      toast(err?.message ?? 'Refresh failed', 'error')
    } finally {
      setRefreshing(false)
    }
  }

  const remove = async () => {
    await guarded(async () => (await removeFriend(friend.id), true), 'Remove')
    setConfirmRemove(false)
    toast(`Removed ${friend.name}`, 'success')
    location.hash = '#/friends'
  }

  return (
    <div className="screen safe-top">
      <header className="screenhead friendhead">
        <a className="iconbtn" href="#/friends" aria-label="Back to friends">
          <Icon name="chevronLeft" size={20} />
        </a>
        <div className="friendhead__id">
          <h1>{friend.name}</h1>
          <span className="friendhead__meta">
            {stats.count} cards · {stats.trade} for trade · {money(stats.value)}
          </span>
          <span className="friendhead__meta friendhead__meta--dim">
            snapshot from {relativeAge(friend.exportedAt)} ago
            {friend.sourceUrl ? ' · linked' : ''}
          </span>
          {friend.note && <span className="friendhead__note">“{friend.note}”</span>}
        </div>
      </header>
      <div className="friendacts">
        <button className="btn btn--primary" onClick={() => setComposing(true)} disabled={cards.length === 0}>
          <Icon name="swap" size={16} /> Propose a trade
        </button>
        {friend.sourceUrl && (
          <button className="btn btn--ghost" onClick={refresh} disabled={refreshing}>
            <Icon name="refresh" size={15} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
        )}
        <button className="btn btn--ghost" onClick={() => setConfirmRemove(true)}>
          <Icon name="trash" size={15} /> Remove
        </button>
      </div>
      {hasBoth && (
        <div className="friendtabs">
          <Seg
            ariaLabel="Which cards"
            size="sm"
            options={[
              { value: 'trade', label: `For trade (${tradeRows.length})` },
              { value: 'all', label: `Everything (${cards.length})` },
            ]}
            value={activeTab}
            onChange={(next) => setTab(next)}
          />
        </div>
      )}
      <div className="colltools">
        <div className="searchbox searchbox--slim">
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Filter…"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            aria-label="Filter this binder"
          />
        </div>
        {games.length > 1 && (
          <select
            className="select select--slim"
            value={gameFilter}
            onChange={(event) => setGameFilter(event.target.value as Game | 'all')}
            aria-label="Game"
          >
            <option value="all">All games</option>
            {games.map((game) => (
              <option key={game} value={game}>
                {GAME_SHORT[game]}
              </option>
            ))}
          </select>
        )}
      </div>
      {shown.length === 0 && (
        <Empty
          icon="search"
          title="Nothing here"
          body={filterText.trim() ? 'No cards match that filter.' : 'This binder has no cards on this tab.'}
        />
      )}
      <div className="cardgrid">
        {shown.map((row) => (
          <BinderCell
            key={rowKey(row)}
            row={row}
            onPick={() => openSheet({ card: sharedCardToCard(row, friend.exportedAt), origin: 'friend' })}
          />
        ))}
      </div>
      <Modal open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Stop following ${friend.name}?`}>
        <p className="setsec__note">
          Removes their binder snapshot from this device. Trades with them stay in your list.
        </p>
        <div className="modalactions">
          <button className="btn btn--ghost" onClick={() => setConfirmRemove(false)}>
            Cancel
          </button>
          <button className="btn btn--danger" onClick={remove}>
            Remove
          </button>
        </div>
      </Modal>
      <Sheet open={composing} onClose={() => setComposing(false)} tall>
        {composing && <TradeComposer friend={friend} myItems={myItems} />}
      </Sheet>
    </div>
  )
}

function BinderCell({ row, onPick }: { row: SharedCard; onPick: () => void }) {
  const card = useMemo(() => sharedCardToCard(row), [row])
  return (
    <button className="cardcell" onClick={onPick}>
      <CardImg card={card} />
      {row.qty > 1 && <span className="cardcell__qty">×{row.qty}</span>}
      {row.forTrade > 0 && (
        <span className="cardcell__trade">
          <Icon name="swap" size={11} />
          {row.forTrade < row.qty ? ` ${row.forTrade}` : ''}
        </span>
      )}
      {row.finish !== 'nonfoil' && <span className="cardcell__finish">{FINISH_LABEL[row.finish]}</span>}
      <span className="cardcell__price">{money(sharedRowValue(row))}</span>
      <span className="cardcell__name">{row.name}</span>
      <span className="cardcell__set">
        {row.setCode}
        {row.condition !== 'NM' ? ` · ${row.condition}` : ''}
      </span>
    </button>
  )
}

/* --- trade composer ------------------------------------------------------ */

type Step = 'want' | 'give' | 'review' | 'share'

function TradeComposer({ friend, myItems }: { friend: Friend; myItems: CollectionItem[] }) {
  const toast = useUi((s) => s.toast)
  const [step, setStep] = useState<Step>('want')
  const [want, setWant] = useState<Map<string, number>>(new Map())
  const [give, setGive] = useState<Map<string, number>>(new Map())
  const [note, setNote] = useState('')
  const [pack, setPack] = useState<SharePack | null>(null)
  const [tradeId, setTradeId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  /* Their side: for-trade rows first — asking for unlisted cards is allowed. */
  const theirRows = useMemo(
    () =>
      [...friend.cards].sort(
        (a, b) => Number(b.forTrade > 0) - Number(a.forTrade > 0) || sharedRowValue(b) - sharedRowValue(a),
      ),
    [friend.cards],
  )
  /* My side as shared rows (full qty; the stepper picks how many to offer). */
  const myRows = useMemo(
    () =>
      myItems
        .filter((item) => item.qty > 0 && item.opened !== true)
        .map((item) => ({ key: item.id, row: itemToSharedCard(item) }))
        .sort(
          (a, b) =>
            Number(b.row.forTrade > 0) - Number(a.row.forTrade > 0) ||
            sharedRowValue(b.row, 1) - sharedRowValue(a.row, 1),
        ),
    [myItems],
  )

  const wantRows = useMemo(
    () =>
      theirRows
        .filter((row) => want.has(rowKey(row)))
        .map((row) => {
          const qty = Math.min(want.get(rowKey(row))!, row.qty)
          return { ...row, qty, forTrade: Math.min(row.forTrade, qty) }
        }),
    [theirRows, want],
  )
  const giveRows = useMemo(
    () =>
      myRows
        .filter(({ key }) => give.has(key))
        .map(({ key, row }) => {
          const qty = Math.min(give.get(key)!, row.qty)
          return { ...row, qty, forTrade: 0 }
        }),
    [myRows, give],
  )

  const toggle = (map: Map<string, number>, set: (m: Map<string, number>) => void, key: string) => {
    const next = new Map(map)
    next.has(key) ? next.delete(key) : next.set(key, 1)
    set(next)
  }
  const setQty = (map: Map<string, number>, set: (m: Map<string, number>) => void, key: string, qty: number) => {
    const next = new Map(map)
    if (qty <= 0) next.delete(key)
    else next.set(key, qty)
    set(next)
  }

  const create = async () => {
    const me = myProfile()
    if (!me.name) {
      toast('Add your name on the Friends screen first — the offer carries it', 'error')
      return
    }
    const trade: TradeRecord = {
      id: uid(),
      friendId: friend.id,
      friendName: friend.name,
      direction: 'out',
      status: 'proposed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      note: note.trim() || undefined,
      give: giveRows,
      get: wantRows,
    }
    if (!(await guarded(async () => (await saveTrade(trade), true), 'Save trade'))) return
    const payload = buildTradePayload(trade, me)
    const blob = await encodeBlob(payload)
    setPack({
      url: shareUrl(blob),
      fileText: payloadFileText(payload),
      fileName: `cardstock-trade-${ymd()}.json`,
      title: `Trade offer from ${me.name}`,
      text: `${me.name} proposes a trade: ${sideQty(trade.give)} of theirs for ${sideQty(trade.get)} of yours`,
      kind: 'trade',
    })
    setTradeId(trade.id)
    track('trade_update', { action: 'proposed', give: giveRows.length, take: wantRows.length })
    setStep('share')
  }

  const needle = filter.trim().toLowerCase()
  const stepTitle =
    step === 'want'
      ? `Pick from ${friend.name}’s binder`
      : step === 'give'
        ? 'Offer from your collection'
        : step === 'review'
          ? 'Review the trade'
          : 'Send it over'

  return (
    <div className="composer">
      <header className="composer__head">
        {step !== 'want' && step !== 'share' && (
          <button
            className="iconbtn"
            onClick={() => setStep(step === 'review' ? 'give' : 'want')}
            aria-label="Previous step"
          >
            <Icon name="chevronLeft" size={18} />
          </button>
        )}
        <h2>{stepTitle}</h2>
      </header>

      {(step === 'want' || step === 'give') && (
        <>
          <div className="searchbox searchbox--slim composer__filter">
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder="Filter…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              aria-label="Filter cards"
            />
          </div>
          <div className="composer__list">
            {step === 'want' &&
              theirRows
                .filter((row) => matchesFilter(row, needle))
                .map((row) => {
                  const key = rowKey(row)
                  return (
                    <PickRow
                      key={key}
                      row={row}
                      picked={want.get(key)}
                      max={row.qty}
                      unlisted={row.forTrade === 0}
                      onToggle={() => toggle(want, setWant, key)}
                      onQty={(qty) => setQty(want, setWant, key, Math.min(qty, row.qty))}
                    />
                  )
                })}
            {step === 'give' &&
              myRows
                .filter(({ row }) => matchesFilter(row, needle))
                .map(({ key, row }) => (
                  <PickRow
                    key={key}
                    row={row}
                    picked={give.get(key)}
                    max={row.qty}
                    unlisted={false}
                    onToggle={() => toggle(give, setGive, key)}
                    onQty={(qty) => setQty(give, setGive, key, Math.min(qty, row.qty))}
                  />
                ))}
            {step === 'give' && myRows.length === 0 && (
              <p className="composer__empty">Your collection is empty — a one-sided ask is fine too.</p>
            )}
          </div>
        </>
      )}

      {step === 'review' && (
        <div className="composer__review">
          <TradeSides give={giveRows} get={wantRows} />
          <input
            className="input"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Note (optional — “shipping split? LGS Friday?”)"
            maxLength={280}
            aria-label="Trade note"
          />
        </div>
      )}

      {step === 'share' && pack && (
        <div className="composer__review">
          <p className="setsec__note">
            The offer is saved under Trades. Send this to {friend.name} — opening it shows them both sides and
            one-tap Accept/Decline links back to you.
          </p>
          <ShareActions pack={pack} />
          <a className="btn btn--ghost composer__done" href={`#/trades/${tradeId}`}>
            <Icon name="swap" size={15} /> View the trade
          </a>
        </div>
      )}

      {step !== 'share' && (
        <footer className="composer__foot">
          <span className="composer__sum">
            Get {sideQty(wantRows)} · {money(sideValue(wantRows))}
            <em>
              Give {sideQty(giveRows)} · {money(sideValue(giveRows))}
            </em>
          </span>
          {step === 'want' && (
            <button className="btn btn--primary" onClick={() => setStep('give')} disabled={wantRows.length === 0}>
              Next <Icon name="chevronRight" size={15} />
            </button>
          )}
          {step === 'give' && (
            <button className="btn btn--primary" onClick={() => setStep('review')}>
              Review <Icon name="chevronRight" size={15} />
            </button>
          )}
          {step === 'review' && (
            <button className="btn btn--primary" onClick={create} disabled={wantRows.length === 0 && giveRows.length === 0}>
              <Icon name="share" size={15} /> Create & share
            </button>
          )}
        </footer>
      )}
    </div>
  )
}

function PickRow({
  row,
  picked,
  max,
  unlisted,
  onToggle,
  onQty,
}: {
  row: SharedCard
  picked: number | undefined
  max: number
  /** Their card that is not marked for trade — selectable, but flagged. */
  unlisted: boolean
  onToggle: () => void
  onQty: (qty: number) => void
}) {
  const card = useMemo(() => sharedCardToCard(row), [row])
  const on = picked != null
  const meta = [
    row.setCode,
    row.finish !== 'nonfoil' ? FINISH_LABEL[row.finish] : null,
    row.condition !== 'NM' ? row.condition : null,
    max > 1 ? `×${max}` : null,
    unlisted ? 'not listed for trade' : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className={`pickrow ${on ? 'pickrow--on' : ''}`}>
      <button className="pickrow__main" onClick={onToggle} aria-pressed={on}>
        <span className={`pickrow__check ${on ? 'pickrow__check--on' : ''}`}>{on && <Icon name="check" size={13} />}</span>
        <CardImg card={card} className="sharedrow__thumb" />
        <span className="sharedrow__body">
          <span className="sharedrow__name">{row.name}</span>
          <span className={`sharedrow__meta ${unlisted ? 'sharedrow__meta--unlisted' : ''}`}>{meta || '—'}</span>
        </span>
        <span className="sharedrow__price">{row.price != null ? money(sharedRowValue(row, 1)) : '—'}</span>
      </button>
      {on && max > 1 && <Stepper value={picked ?? 1} min={1} max={max} onChange={onQty} />}
    </div>
  )
}
