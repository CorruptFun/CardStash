import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, ManaCost, Seg, Stepper } from '../components/basics'
import { DeckPicker } from '../components/DeckPicker'
import { Icon } from '../components/Icon'
import { Sheet } from '../components/Sheet'
import { track } from '../lib/analytics'
import { refreshCard } from '../lib/cardsearch'
import {
  addCardToDeck,
  addToCollection,
  applyCardUpdate,
  db,
  priceHistory,
  removeCopies,
  setItemQty,
  updateDeck,
  updateItem,
} from '../lib/db'
import { addedToBoardToast, boardForCard } from '../lib/deckstats'
import { CONDITIONS, FINISH_LABEL, GAME_FINISHES, GAME_LABEL, SOURCE_LABEL } from '../lib/games'
import { cardTrend } from '../lib/portfolio'
import {
  collectionValue,
  groupComps,
  headlineFinish,
  itemUnitPrice,
  netProceeds,
  parseMoney,
  FEE_PCT,
  type CompRow,
  type Priceable,
} from '../lib/prices'
import { useSettings } from '../lib/settings'
import type { Card, CollectionItem, Condition, Deck, Finish, Game, PricePoint } from '../lib/types'
import { dateTime, haptic, money } from '../lib/util'
import { guarded, useUi } from '../store/ui'

const PRINTINGS_PREVIEW = 12
const PRICE_STALE_MS = 6 * 3_600_000

export function CardSheetHost() {
  const sheet = useUi((s) => s.sheet)
  const close = useUi((s) => s.closeSheet)
  return (
    <Sheet open={sheet != null} onClose={close} tall>
      {sheet && <CardSheet key={sheet.card.id} />}
    </Sheet>
  )
}

function premiumLabel(card: Card): string {
  const entry = card.prices.entries.find((e) => e.finish !== 'nonfoil' && e.value === card.prices.bestFoil)
  return entry ? FINISH_LABEL[entry.finish] : 'Foil'
}

function addLabelPrice(card: Card, finish: Finish, condition: Condition): number | null {
  const probe: Priceable = { finish, condition, qty: 1, card }
  return itemUnitPrice(probe)
}

function deckAddLabel(qty: number, deckName?: string): string {
  const count = qty > 1 ? `${qty}× ` : ''
  return deckName ? `Add ${count}to ${deckName}` : `Add ${count}to deck`
}

function sortCopies(rows: CollectionItem[]): CollectionItem[] {
  return [...rows].sort(
    (a, b) =>
      (itemUnitPrice(b) ?? 0) * b.qty - (itemUnitPrice(a) ?? 0) * a.qty ||
      a.finish.localeCompare(b.finish) ||
      a.condition.localeCompare(b.condition),
  )
}

function priceRange(comps: CompRow[], finish: Finish): { low: number; high: number } | null {
  let low: number | null = null
  let high: number | null = null
  for (const row of comps) {
    if (row.finish !== finish) continue
    const rowHigh = row.high ?? row.avg30
    if (row.low != null && (low == null || row.low < low)) low = row.low
    if (rowHigh != null && (high == null || rowHigh > high)) high = rowHigh
  }
  return low != null && high != null && high > low ? { low, high } : null
}

function moneyInput(raw: string): string {
  return raw.replace(/[^\d.,]/g, '')
}

function costBasisEcho(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** deckId → copies of this card in that deck (all boards summed). */
function useDeckMembership(cardId: string) {
  const deckRows = useLiveQuery(() => db.deckCards.where('cardId').equals(cardId).toArray(), [cardId])
  return useMemo(() => {
    const byDeck = new Map<string, number>()
    for (const row of deckRows ?? []) byDeck.set(row.deckId, (byDeck.get(row.deckId) ?? 0) + row.qty)
    return byDeck
  }, [deckRows])
}

function CardSheet() {
  const sheet = useUi((s) => s.sheet)!
  const toast = useUi((s) => s.toast)
  const setBuilderSeeds = useUi((s) => s.setBuilderSeeds)
  const pokemonKey = useSettings((s) => s.pokemonKey)
  const [card, setCard] = useState(sheet.card)
  const [finish, setFinish] = useState<Finish>(sheet.item?.finish ?? headlineFinish(sheet.card.prices, GAME_FINISHES[sheet.card.game]))
  const [condition, setCondition] = useState<Condition>(sheet.item?.condition ?? 'NM')
  const [qty, setQty] = useState(1)
  const [paid, setPaid] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [didAdd, setDidAdd] = useState(false)
  const [deckPickOpen, setDeckPickOpen] = useState(false)
  const [allPrintings, setAllPrintings] = useState(false)

  const best = card.prices.best
  const bestFoil = card.prices.bestFoil
  const history = useLiveQuery(() => priceHistory(card.id), [card.id])
  const copies = useLiveQuery(() => db.collection.where('cardId').equals(card.id).toArray(), [card.id])
  const gameDecks = useLiveQuery(() => db.decks.where('game').equals(card.game).toArray(), [card.game])
  const targetDeck = useLiveQuery(async () => (sheet.deckId ? db.decks.get(sheet.deckId) : undefined), [sheet.deckId])
  const membership = useDeckMembership(card.id)
  const memberDecks = useMemo(
    () => (gameDecks ?? []).filter((deck) => (membership.get(deck.id) ?? 0) > 0),
    [gameDecks, membership],
  )

  useEffect(() => {
    if (Date.now() - card.prices.updatedAt < PRICE_STALE_MS) return
    let cancelled = false
    refreshCard(card, { pokemonKey }).then((fresh) => {
      if (fresh && !cancelled) {
        setCard(fresh)
        guarded(async () => (await applyCardUpdate(fresh), true), 'Price update')
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const comps = useMemo(() => groupComps(card.prices.entries), [card.prices.entries])
  const sortedCopies = useMemo(() => sortCopies(copies ?? []), [copies])
  const copiesValue = useMemo(() => collectionValue(sortedCopies), [sortedCopies])
  const copiesCount = sortedCopies.reduce((sum, row) => sum + row.qty, 0)
  const trend = useMemo(() => cardTrend(history ?? []), [history])
  const paidValue = parseMoney(paid)
  const paidOk = paidValue != null

  const refreshPrices = async () => {
    setRefreshing(true)
    const startedAt = performance.now()
    const fresh = await refreshCard(card, { pokemonKey })
    track('price_refresh', { ok: !!fresh, ms: Math.round(performance.now() - startedAt), batch: 1 })
    setRefreshing(false)
    if (!fresh) {
      toast('Could not refresh prices', 'error')
      return
    }
    setCard(fresh)
    if (await guarded(async () => (await applyCardUpdate(fresh), true), 'Price update')) toast('Prices updated', 'success')
  }

  const flashAdded = () => {
    setDidAdd(true)
    setTimeout(() => setDidAdd(false), 1400)
  }

  const add = async () => {
    const deckId = sheet.deckId
    if (deckId) {
      if (!(await guarded(async () => (await addCardToDeck(deckId, card, qty), true), 'Add to deck'))) return
      track('card_added', { game: card.game, source: 'deck' })
      haptic(12)
      toast(`Added ${qty}× ${card.name} to ${targetDeck?.name ?? 'the deck'}`, 'success')
    } else {
      const item = await guarded(
        () => addToCollection(card, { finish, condition, qty, purchasePrice: paidValue ?? undefined }),
        'Add',
      )
      if (!item) return
      track('card_added', { game: card.game, source: sheet.origin ?? 'search' })
      haptic(12)
      toast(`Added ${qty}× ${card.name}`, 'success', {
        label: 'Undo',
        fn: () => {
          guarded(async () => (await removeCopies(item.id, qty), true), 'Undo')
        },
      })
    }
    flashAdded()
  }

  /* Self-assign: put this card into a deck the user already built. */
  const assignToDeck = async (deck: Deck) => {
    const board = boardForCard(deck.game, card.supertype, 'main')
    const done = await guarded(async () => {
      await addCardToDeck(deck.id, card, qty, board)
      if (!deck.coverCardId) await updateDeck(deck.id, { coverCardId: card.id })
      return true
    }, 'Add to deck')
    if (!done) return
    track('card_added', { game: card.game, source: 'assign' })
    haptic(12)
    setDeckPickOpen(false)
    toast(
      qty === 1 && board === 'main'
        ? `Added to ${deck.name}`
        : `${addedToBoardToast(card.name, board).replace('+1', `+${qty}`)} · ${deck.name}`,
      'success',
    )
    flashAdded()
  }

  /* Hand the card to the AI builder as a seed. */
  const buildAround = () => {
    setBuilderSeeds([card])
    setDeckPickOpen(false)
    location.hash = '#/builder'
  }

  const displayFinish = headlineFinish(card.prices)
  const headline = best ?? bestFoil
  const range = useMemo(() => priceRange(comps, displayFinish), [comps, displayFinish])
  const addPrice = addLabelPrice(card, finish, condition)

  return (
    <div className="cardsheet">
      <header className="cardsheet__head">
        <CardImg card={card} size="large" className="cardsheet__img" />
        <div className="cardsheet__title">
          <div className="cardsheet__gamerow">
            <span className={`gamechip gamechip--${card.game}`}>{GAME_LABEL[card.game]}</span>
            {card.rarity && <span className="raritychip">{card.rarity}</span>}
          </div>
          <h2>{card.name}</h2>
          <p className="cardsheet__set">
            {card.setName ?? card.setCode}
            {card.number ? ` · #${card.number}` : ''}
          </p>
          {card.manaCost ? <ManaCost cost={card.manaCost} /> : card.typeLine && <p className="cardsheet__type">{card.typeLine}</p>}
          {(copiesCount > 0 || memberDecks.length > 0) && (
            <span className="cardsheet__chips">
              {copiesCount > 0 && (
                <span className="ownedchip">
                  <Icon name="check" size={13} /> {copiesCount} in collection
                </span>
              )}
              {memberDecks.length > 0 && (
                <button className="ownedchip ownedchip--deck" onClick={() => setDeckPickOpen(true)}>
                  <Icon name="decks" size={13} /> in {memberDecks.length === 1 ? memberDecks[0].name : `${memberDecks.length} decks`}
                </button>
              )}
            </span>
          )}
        </div>
      </header>
      <section className="pricehero">
        <div className="pricehero__main">
          <span className="pricehero__label">{FINISH_LABEL[displayFinish]}</span>
          <div className="pricehero__figure">
            <span className="pricehero__value">{money(headline)}</span>
            {trend && (
              <span className={`pricehero__delta pricehero__delta--${trend.abs >= 0 ? 'up' : 'down'}`}>
                {trend.abs >= 0 ? '▲' : '▼'} {money(Math.abs(trend.abs))}
                <em>{trend.days}d</em>
              </span>
            )}
          </div>
          {range && (
            <span className="pricehero__range">
              {money(range.low)} – {money(range.high)}
            </span>
          )}
        </div>
        {bestFoil != null && best != null && bestFoil !== best && (
          <div className="pricehero__alt">
            <span className="pricehero__label">{premiumLabel(card)}</span>
            <span className="pricehero__value pricehero__value--alt">{money(bestFoil)}</span>
          </div>
        )}
        {headline != null && headline > 0 && (
          <div className="netline netline--hero">
            <span className="netline__label">Net if sold</span>
            <span className="netline__val">{money(netProceeds(headline))}</span>
            <em className="netline__note">after ~{Math.round(FEE_PCT * 100)}% fees, estimated</em>
          </div>
        )}
        <div className="pricehero__meta">
          <span className="pricehero__updated">Updated {dateTime(card.prices.updatedAt)}</span>
          <button className="iconbtn pricehero__refresh" onClick={refreshPrices} disabled={refreshing} aria-label="Refresh prices">
            <Icon name="refresh" size={18} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </section>
      {sortedCopies.length > 0 && (
        <section className="copies">
          <div className="copies__head">
            <span className="copies__legend">Your copies</span>
            <span className="copies__count">
              ×{copiesCount}
              {copiesValue > 0 && <> · {money(copiesValue)}</>}
            </span>
          </div>
          {sortedCopies.map((row) => (
            <CopyRow key={row.id} row={row} game={card.game} />
          ))}
        </section>
      )}
      {memberDecks.length > 0 && (
        <section className="sheetsec">
          <h3>
            <Icon name="decks" size={15} /> In decks
          </h3>
          <div className="sheetdecks">
            {memberDecks.map((deck) => (
              <a key={deck.id} className="sheetdecks__row" href={`#/decks/${deck.id}`}>
                <span className="sheetdecks__name">{deck.name}</span>
                <em className="sheetdecks__meta">
                  {deck.format ? `${deck.format} · ` : ''}×{membership.get(deck.id)}
                </em>
                <Icon name="chevronRight" size={15} className="sheetdecks__go" />
              </a>
            ))}
          </div>
        </section>
      )}
      <section className="sheetsec">
        <h3>
          <Icon name="history" size={15} /> Price history
        </h3>
        <Sparkline points={history ?? []} />
      </section>
      {comps.length > 0 && (
        <section className="sheetsec">
          <h3>
            <Icon name="tag" size={15} /> Prices & comps
          </h3>
          <div className="compsscroll">
            <div className="compstable" role="table">
              <div className="compstable__row compstable__row--head" role="row">
                <span>Source</span>
                <span>Finish</span>
                <span className="num">Low</span>
                <span className="num">Market</span>
                <span className="num">High</span>
              </div>
              {comps.map((row, i) => (
                <div key={i} className="compstable__row" role="row">
                  <span>{SOURCE_LABEL[row.source]}</span>
                  <span className="dim">{FINISH_LABEL[row.finish]}</span>
                  <span className="num dim">{money(row.low ?? null)}</span>
                  <span className="num strong">{money(row.market ?? row.trend ?? row.mid ?? null)}</span>
                  <span className="num dim">{money(row.high ?? row.avg30 ?? null)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="compslinks">
            <a className="btn btn--ghost" href={card.links.ebaySold} target="_blank" rel="noreferrer">
              <Icon name="external" size={15} /> eBay solds
            </a>
            {card.links.tcgplayer && (
              <a className="btn btn--ghost" href={card.links.tcgplayer} target="_blank" rel="noreferrer">
                <Icon name="cart" size={15} /> TCGplayer
              </a>
            )}
          </div>
        </section>
      )}
      {card.printings && card.printings.length > 1 && (
        <section className="sheetsec">
          <h3>
            <Icon name="cards" size={15} /> Printings
          </h3>
          <div className="printings">
            {(allPrintings ? card.printings : card.printings.slice(0, PRINTINGS_PREVIEW)).map((printing, i) => (
              <div key={i} className="printings__row">
                <span className="printings__set">{printing.setName}</span>
                <span className="dim">{printing.setCode}</span>
                <span className="dim">{printing.rarity}</span>
                <span className="num strong">{printing.price ? money(printing.price) : '—'}</span>
              </div>
            ))}
            {card.printings.length > PRINTINGS_PREVIEW && (
              <button className="printings__more" onClick={() => setAllPrintings(!allPrintings)}>
                {allPrintings ? 'Show fewer' : `Show all ${card.printings.length} printings`}
                <Icon name="chevronDown" size={14} className={allPrintings ? 'flip' : ''} />
              </button>
            )}
          </div>
        </section>
      )}
      {card.subtext && (
        <section className="sheetsec">
          <p className="oracle">{card.subtext}</p>
        </section>
      )}
      <section className="addbar">
        {!sheet.deckId && (
          <div className="addbar__opts">
            <Seg
              ariaLabel="Finish"
              size="sm"
              options={GAME_FINISHES[card.game].map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
              value={finish}
              onChange={setFinish}
            />
            <div className="addbar__row2">
              <select className="select" value={condition} onChange={(e) => setCondition(e.target.value as Condition)} aria-label="Condition">
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <Stepper value={qty} onChange={setQty} min={1} />
              <input
                className="input addbar__paid"
                type="text"
                inputMode="decimal"
                value={paid}
                onChange={(e) => setPaid(moneyInput(e.target.value))}
                placeholder="Paid $ (optional)"
                aria-label="Paid per card"
              />
            </div>
            {paid.trim().length > 0 && (
              <span className={`addbar__paidecho ${paidOk ? '' : 'addbar__paidecho--bad'}`}>
                {paidOk ? `Cost basis ${costBasisEcho(paidValue)} each` : 'Enter an amount like 12.50'}
              </span>
            )}
          </div>
        )}
        {sheet.deckId && (
          <div className="addbar__deckopts">
            <span className="addbar__decklabel">{targetDeck ? `Adding to ${targetDeck.name}` : 'Adding to this deck'}</span>
            <Stepper value={qty} onChange={setQty} min={1} />
          </div>
        )}
        <div className="addbar__actions">
          <button className={`btn btn--primary addbar__add ${didAdd ? 'btn--did' : ''}`} onClick={add}>
            {didAdd ? <Icon name="check" size={18} /> : <Icon name="plus" size={18} />}
            <span className="addbar__addlabel">
              {sheet.deckId
                ? deckAddLabel(qty, targetDeck?.name)
                : `Add ${qty > 1 ? `${qty}× ` : ''}· ${money(addPrice)}`}
            </span>
          </button>
          {!sheet.deckId && (
            <button className="btn btn--ghost" onClick={() => setDeckPickOpen(true)}>
              <Icon name="decks" size={16} /> Deck
            </button>
          )}
        </div>
      </section>
      <DeckPicker
        open={deckPickOpen}
        onClose={() => setDeckPickOpen(false)}
        title={qty > 1 ? `Add ${qty}× ${card.name} to a deck` : `Add ${card.name} to a deck`}
        game={card.game}
        membership={membership}
        onPick={(deck) => {
          assignToDeck(deck)
        }}
        onBuildNew={buildAround}
        buildLabel="Build a deck around this card"
        emptyHint={`No ${GAME_LABEL[card.game]} decks yet — let the AI builder design one around this card, or create one on the Decks tab.`}
      />
    </div>
  )
}

function CopyRow({ row, game }: { row: CollectionItem; game: Game }) {
  const toast = useUi((s) => s.toast)
  const [editing, setEditing] = useState(false)
  const [finish, setFinish] = useState<Finish>(row.finish)
  const [condition, setCondition] = useState<Condition>(row.condition)
  const [paid, setPaid] = useState(row.purchasePrice != null ? String(row.purchasePrice) : '')
  const [note, setNote] = useState(row.note ?? '')
  const [saving, setSaving] = useState(false)
  const unit = itemUnitPrice(row)
  const paidValue = parseMoney(paid)
  const hasPaid = paid.trim().length > 0

  const toggleEdit = () => {
    if (!editing) {
      setFinish(row.finish)
      setCondition(row.condition)
      setPaid(row.purchasePrice != null ? String(row.purchasePrice) : '')
      setNote(row.note ?? '')
    }
    setEditing(!editing)
  }

  const save = async () => {
    setSaving(true)
    const result = await guarded(
      () =>
        updateItem(row.id, {
          finish,
          condition,
          purchasePrice: hasPaid ? (paidValue ?? row.purchasePrice) : undefined,
          note: note.trim() || undefined,
        }),
      'Save',
    )
    setSaving(false)
    if (result !== undefined) {
      setEditing(false)
      if (result === null) {
        toast('That copy is no longer in your collection', 'info')
        return
      }
      toast(mergeToast(row, result), 'success')
    }
  }

  return (
    <div className={`copyrow ${editing ? 'copyrow--open' : ''}`}>
      <div className="copyrow__main">
        <span className="copyrow__id">
          <span className="copyrow__finish">{FINISH_LABEL[row.finish]}</span>
          <span className="copyrow__cond">{row.condition}</span>
        </span>
        <span className="copyrow__unit">{money(unit)}</span>
        <Stepper
          value={row.qty}
          onChange={(qty) => {
            guarded(async () => (await setItemQty(row.id, qty), true), 'Quantity')
          }}
        />
        <button
          className={`iconbtn ${editing ? 'iconbtn--on' : ''}`}
          onClick={toggleEdit}
          aria-expanded={editing}
          aria-label={`Edit ${FINISH_LABEL[row.finish]} ${row.condition} copies`}
        >
          <Icon name="pencil" size={16} />
        </button>
      </div>
      {editing && (
        <div className="copyedit">
          <Seg
            ariaLabel="Finish"
            size="sm"
            options={GAME_FINISHES[game].map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
            value={finish}
            onChange={setFinish}
          />
          <div className="copyedit__row">
            <select className="select" value={condition} onChange={(e) => setCondition(e.target.value as Condition)} aria-label="Condition">
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={paid}
              onChange={(e) => setPaid(moneyInput(e.target.value))}
              placeholder="Paid $ each"
              aria-label="Paid per card"
            />
          </div>
          <input
            className="input"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (binder, trade, grade…)"
            aria-label="Note"
          />
          {hasPaid && (
            <span className={`copyedit__echo ${paidValue != null ? '' : 'copyedit__echo--bad'}`}>
              {paidValue != null ? `Cost basis ${costBasisEcho(paidValue)} each` : 'Enter an amount like 12.50'}
            </span>
          )}
          <div className="copyedit__actions">
            <button className="btn btn--ghost btn--sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn btn--primary btn--sm"
              onClick={() => {
                save()
              }}
              disabled={saving}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function mergeToast(before: CollectionItem, after: CollectionItem): string {
  if (after.id === before.id) return 'Copy updated'
  const finish = after.finish === 'nonfoil' ? '' : ` ${FINISH_LABEL[after.finish].toLowerCase()}`
  return `Merged into your ${after.condition}${finish} copies`
}

/* Price-history sparkline */

const SPARK_W = 320
const SPARK_H = 84
const SPARK_PAD = { top: 10, right: 8, bottom: 6, left: 8 }
const SPARK_LINE = '#8b7cff'

function Sparkline({ points }: { points: PricePoint[] }) {
  const priced = useMemo(() => points.filter((point) => point.best != null), [points])
  const [hover, setHover] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const geom = useMemo(() => {
    if (priced.length < 2) return null
    const values = priced.map((point) => point.best!)
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || max * 0.1 || 1
    const x = (i: number) => SPARK_PAD.left + (i / (priced.length - 1)) * (SPARK_W - SPARK_PAD.left - SPARK_PAD.right)
    const y = (value: number) => SPARK_PAD.top + (1 - (value - min) / span) * (SPARK_H - SPARK_PAD.top - SPARK_PAD.bottom)
    const line = priced.map((point, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(point.best!).toFixed(1)}`).join('')
    const area = `${line}L${x(priced.length - 1).toFixed(1)},${SPARK_H - SPARK_PAD.bottom}L${SPARK_PAD.left},${SPARK_H - SPARK_PAD.bottom}Z`
    return { x, y, line, area }
  }, [priced])
  if (!geom || priced.length < 2) {
    return <div className="spark spark--empty">Price history builds as you scan — check back tomorrow.</div>
  }
  const lastIndex = priced.length - 1
  const shownIndex = hover ?? lastIndex
  const shown = priced[shownIndex]
  const first = priced[0].best!
  const last = priced[lastIndex].best!
  const delta = last - first
  const deltaPct = first > 0 ? (delta / first) * 100 : 0
  const pick = (clientX: number) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const t = (((clientX - rect.left) / rect.width) * SPARK_W - SPARK_PAD.left) / (SPARK_W - SPARK_PAD.left - SPARK_PAD.right)
    setHover(Math.round(Math.min(1, Math.max(0, t)) * lastIndex))
  }
  return (
    <div className="spark">
      <div className="spark__readout">
        <span className="spark__val">{money(shown.best)}</span>
        <span className="spark__date">
          {new Date(shown.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
        <span className={`spark__delta ${delta >= 0 ? 'spark__delta--up' : 'spark__delta--down'}`}>
          {delta >= 0 ? '▲' : '▼'} {money(Math.abs(delta))} ({Math.abs(deltaPct).toFixed(1)}%)
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        className="spark__svg"
        role="img"
        aria-label={`Price history, ${priced.length} days, from ${money(first)} to ${money(last)}`}
        onPointerMove={(event) => pick(event.clientX)}
        onPointerLeave={() => setHover(null)}
        onTouchMove={(event) => pick(event.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        <defs>
          <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={SPARK_LINE} stopOpacity="0.28" />
            <stop offset="1" stopColor={SPARK_LINE} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1={SPARK_PAD.left}
          x2={SPARK_W - SPARK_PAD.right}
          y1={SPARK_H - SPARK_PAD.bottom}
          y2={SPARK_H - SPARK_PAD.bottom}
          className="spark__baseline"
        />
        <path d={geom.area} fill="url(#sparkfill)" />
        <path d={geom.line} fill="none" stroke={SPARK_LINE} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover != null && (
          <line x1={geom.x(shownIndex)} x2={geom.x(shownIndex)} y1={SPARK_PAD.top - 4} y2={SPARK_H - SPARK_PAD.bottom} className="spark__crosshair" />
        )}
        <circle cx={geom.x(shownIndex)} cy={geom.y(shown.best!)} r="3.5" fill={SPARK_LINE} stroke="var(--bg-elev)" strokeWidth="2" />
      </svg>
    </div>
  )
}
