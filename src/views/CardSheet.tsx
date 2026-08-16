import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, ManaCost, Seg, Stepper, Toggle } from '../components/basics'
import { BinderPicker } from '../components/BinderPicker'
import { DeckPicker } from '../components/DeckPicker'
import { Icon } from '../components/Icon'
import { PriceCheck } from '../components/PriceCheck'
import { Sheet } from '../components/Sheet'
import { amountBucket, track } from '../lib/analytics'
import { canBuyFrom, marketReady, startCheckout } from '../lib/marketplace'
import { messagingReady } from '../lib/messaging'
import { printingVariants, refreshCard } from '../lib/cardsearch'
import { isCustomCard, needsImage } from '../lib/cardpatch'
import {
  addCardToDeck,
  addToCollection,
  applyCardUpdate,
  db,
  priceHistory,
  removeCopies,
  setItemQty,
  toggleWant,
  updateDeck,
  updateItem,
} from '../lib/db'
import { wantKeyFor } from '../lib/social'
import { addedToBoardToast, boardForCard } from '../lib/deckstats'
import { CONDITIONS, FINISH_LABEL, finishOptions, GAME_FINISHES, GAME_LABEL, isFoilFinish, SOURCE_LABEL } from '../lib/games'
import { gradeShort } from '../lib/slab'
import { SPORT_LABEL } from '../lib/sports'
import { cardTrend } from '../lib/portfolio'
import { sealedSetContents, setListLink } from '../lib/sealed'
import {
  collectionValue,
  conditionFactor,
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

const VARIANTS_PREVIEW = 8
const PULLS_PREVIEW = 10
const PRICE_STALE_MS = 6 * 3_600_000

/** One printing's identity — YGO variants share a card id but differ in set/rarity. */
function printingKey(card: Card): string {
  return `${card.id}|${card.setCode ?? ''}|${card.number ?? ''}|${card.rarity ?? ''}`
}

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
  const openEditor = useUi((s) => s.openEditor)
  const setBuilderSeeds = useUi((s) => s.setBuilderSeeds)
  const setMessageDraft = useUi((s) => s.setMessageDraft)
  const closeSheet = useUi((s) => s.closeSheet)
  const pokemonKey = useSettings((s) => s.pokemonKey)
  const [card, setCard] = useState(sheet.card)
  const [finish, setFinish] = useState<Finish>(
    sheet.item?.finish ?? sheet.finish ?? headlineFinish(sheet.card.prices, finishOptions(sheet.card)),
  )
  const [condition, setCondition] = useState<Condition>(sheet.item?.condition ?? 'NM')
  const [qty, setQty] = useState(1)
  const [paid, setPaid] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [didAdd, setDidAdd] = useState(false)
  const [deckPickOpen, setDeckPickOpen] = useState(false)
  const [binderPickOpen, setBinderPickOpen] = useState(false)
  const [allPrintings, setAllPrintings] = useState(false)
  const printingsRef = useRef<HTMLElement | null>(null)
  const [variants, setVariants] = useState<Card[] | null>(null)
  const sealed = !!card.sealed
  /** Sealed only: everything that could be pulled from this product's set. */
  const [pulls, setPulls] = useState<{ cards: Card[]; setName: string } | 'error' | null>(null)
  const [allPulls, setAllPulls] = useState(false)

  const best = card.prices.best
  const bestFoil = card.prices.bestFoil
  const history = useLiveQuery(() => priceHistory(card.id), [card.id])
  const copies = useLiveQuery(() => db.collection.where('cardId').equals(card.id).toArray(), [card.id])
  const wanted = useLiveQuery(() => db.wants.get(wantKeyFor(card.game, card.name)), [card.game, card.name])

  const toggleWanted = async () => {
    const on = await guarded(() => toggleWant(card), 'Want list')
    if (on === undefined) return
    track('want_update', { game: card.game, on })
    haptic(6)
    toast(on ? `${card.name} added to your want list` : `${card.name} removed from wants`, 'success')
  }
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

  /* Every printing of this card (sets, promos, rarities) for the picker. */
  useEffect(() => {
    let cancelled = false
    printingVariants(sheet.card, { pokemonKey }).then(
      (cards) => {
        if (!cancelled) setVariants(cards)
      },
      () => {
        if (!cancelled) setVariants(null)
      },
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* Switch the whole sheet to another printing: image, set, rarity, prices. */
  const pickVariant = (variant: Card) => {
    if (printingKey(variant) === printingKey(card)) return
    setCard(variant)
    const options = finishOptions(variant)
    if (!options.includes(finish)) setFinish(headlineFinish(variant.prices, options))
    track('variant_selected', { game: variant.game })
    haptic(6)
  }

  /* Sealed: what could be inside — every card in the product's set. */
  useEffect(() => {
    if (!sheet.card.sealed) return
    let cancelled = false
    sealedSetContents(sheet.card).then(
      (contents) => {
        if (!cancelled) setPulls(contents ? { cards: contents.cards, setName: contents.group.name } : 'error')
      },
      () => {
        if (!cancelled) setPulls('error')
      },
    )
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
        () =>
          addToCollection(
            card,
            sealed
              ? { qty, purchasePrice: paidValue ?? undefined, opened: false }
              : { finish, condition, qty, purchasePrice: paidValue ?? undefined },
          ),
        'Add',
      )
      if (!item) return
      track('card_added', { game: card.game, source: sheet.origin ?? 'search' })
      haptic(12)
      toast(sealed ? `Added ${qty}× ${card.name} (sealed)` : `Added ${qty}× ${card.name}`, 'success', {
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
  /**
   * Buying is offered only when the sheet was opened from a friend's binder AND
   * that friend can actually be paid — `can_sell()` answers both the friendship
   * and the Stripe-verification halves without telling us anything else about
   * them. Asked once per sheet rather than cached, because a seller finishing
   * verification is exactly the kind of thing that changes between two openings.
   */
  const seller = sheet.seller
  const [canBuy, setCanBuy] = useState(false)
  const [buying, setBuying] = useState(false)

  useEffect(() => {
    let live = true
    if (!seller?.userId || !marketReady()) {
      setCanBuy(false)
      return
    }
    void canBuyFrom(seller.userId).then((ok) => {
      if (live) setCanBuy(ok)
    })
    return () => {
      live = false
    }
  }, [seller?.userId])

  /**
   * The price is the seller's published market unit for the finish they listed,
   * with their condition applied -- the same number the binder already shows
   * them and shows you, so nobody is surprised at the checkout. It is sent to
   * the server and then recomputed there; `open_order()` refuses anything that
   * does not clear the floor or leaves the seller nothing.
   */
  const buy = async () => {
    if (!seller || buying) return
    const unit = Math.round((seller.row.price ?? 0) * conditionFactor(seller.row.condition) * 100)
    setBuying(true)
    try {
      const { url } = await startCheckout({
        sellerId: seller.userId,
        cardId: seller.row.cardId,
        cardName: seller.row.name,
        qty: 1,
        itemCents: unit,
        shippingCents: 0,
      })
      track('card_added', { game: card.game, source: 'buy', band: amountBucket(unit / 100) })
      location.href = url
    } catch (err: any) {
      toast(err?.message ?? 'Could not start checkout', 'error')
      setBuying(false)
    }
  }

  const addPrice = addLabelPrice(card, finish, condition)
  /* Finishes this printing exists in — plus the current pick, so the control
   * never strands the user (their physical copy beats incomplete API data). */
  const addFinishOptions = useMemo(() => {
    const options = finishOptions(card)
    return options.includes(finish) ? options : [...options, finish]
  }, [card, finish])

  return (
    <div className="cardsheet">
      <header className="cardsheet__head">
        <CardImg card={card} size="large" className="cardsheet__img" foil={isFoilFinish(finish)} />
        <div className="cardsheet__title">
          <div className="cardsheet__gamerow">
            <span className={`gamechip gamechip--${card.game}`}>{GAME_LABEL[card.game]}</span>
            {isCustomCard(card) && <span className="raritychip raritychip--own">Added by you</span>}
            {sealed ? (
              <span className="raritychip">{card.sealed?.kind ?? 'Sealed'}</span>
            ) : (
              card.rarity && <span className="raritychip">{card.rarity}</span>
            )}
            <SportsFacts card={card} />
          </div>
          <h2>{card.name}</h2>
          <p className="cardsheet__set">
            {card.setName ?? card.setCode}
            {card.number ? ` · #${card.number}` : ''}
            {card.releasedAt ? ` · ${card.releasedAt.slice(0, 4)}` : ''}
          </p>
          {/*
            The scan read the card but not its printed code, so this edition is
            the source's default — for Yu-Gi-Oh, an arbitrary reprint out of a
            dozen whose prices span two orders of magnitude. Saying so is the
            difference between a guess and a claim, and the picker is one tap
            away. Only shown when there is something to pick.
          */}
          {sheet.printingUnconfirmed && (variants?.length ?? 0) > 1 && (
            <button
              className="unpinnedchip"
              onClick={() => printingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <Icon name="alert" size={13} />
              Edition not read — check it’s yours
            </button>
          )}
          {card.manaCost ? <ManaCost cost={card.manaCost} /> : card.typeLine && <p className="cardsheet__type">{card.typeLine}</p>}
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
            {!sealed && (
              <button
                className={`ownedchip ownedchip--want ${wanted ? 'ownedchip--wanton' : ''}`}
                onClick={toggleWanted}
                aria-pressed={!!wanted}
              >
                <Icon name="heart" size={13} filled={!!wanted} /> {wanted ? 'On your want list' : 'Want'}
              </button>
            )}
            {/* The card has no art anywhere, so offer the one thing that fixes
                it. Phrased as help rather than as an error: nothing is broken,
                the catalog simply never had a picture. */}
            <button className="ownedchip ownedchip--fix" onClick={() => openEditor({ card })}>
              <Icon name="camera" size={13} /> {needsImage(card) ? 'Add a picture' : 'Fix this card'}
            </button>
          </span>
        </div>
      </header>
      <section className="pricehero">
        <div className="pricehero__main">
          <span className="pricehero__label">{sealed ? 'Sealed' : FINISH_LABEL[displayFinish]}</span>
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
      {(comps.length > 0 || card.game === 'sports') && (
        <section className="sheetsec">
          <h3>
            <Icon name="tag" size={15} /> Prices & comps
          </h3>
          {/* Sports has no comp table to show — no catalog prices these cards
              (decision 17) — so its section is the eBay link plus a lookup the
              user asks for. The section used to be gated on price rows, which a
              sports card can never have, so the sold-comps link `sports.ts`
              builds for every one of them rendered nowhere at all. */}
          {card.game === 'sports' && (
            <>
              <p className="printpick__hint">
                No catalog prices sports cards. Check what copies are listed for, then set what yours is worth.
              </p>
              <PriceCheck card={card} />
            </>
          )}
          {comps.length > 0 && (
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
          )}
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
      {(variants?.length ?? 0) > 1 && (
        <section className="sheetsec" ref={printingsRef}>
          <h3>
            <Icon name="cards" size={15} /> {sealed ? 'Products from this set' : 'Printings & variants'}
            <em className="sheetsec__count">{variants!.length}</em>
          </h3>
          <p className="printpick__hint">
            {sealed
              ? 'Scanned a box but holding a pack? Pick the exact product.'
              : 'Not the copy in your hand? Pick its edition — set, number, rarity and prices follow.'}
          </p>
          <div className="printpick">
            {(allPrintings ? variants! : variants!.slice(0, VARIANTS_PREVIEW)).map((variant, i) => {
              const selected = printingKey(variant) === printingKey(card)
              const price = variant.prices.best ?? variant.prices.bestFoil
              return (
                <button
                  key={`${printingKey(variant)}|${i}`}
                  className={`printpick__row ${selected ? 'printpick__row--on' : ''}`}
                  onClick={() => pickVariant(variant)}
                  aria-pressed={selected}
                >
                  <CardImg card={variant} className="printpick__thumb" />
                  <span className="printpick__body">
                    <span className="printpick__set">
                      {sealed ? variant.name : (variant.setName ?? variant.setCode ?? 'Unknown set')}
                    </span>
                    <span className="printpick__meta">
                      {(sealed
                        ? [variant.sealed?.kind, variant.releasedAt?.slice(0, 4)]
                        : [
                            variant.setCode,
                            variant.number ? `#${variant.number}` : null,
                            variant.rarity,
                            variant.releasedAt?.slice(0, 4),
                          ]
                      )
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="printpick__side">
                    <span className="printpick__price">{money(price)}</span>
                    {selected && (
                      <span className="printpick__on">
                        <Icon name="check" size={12} /> selected
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
            {variants!.length > VARIANTS_PREVIEW && (
              <button className="printpick__more" onClick={() => setAllPrintings(!allPrintings)}>
                {allPrintings ? 'Show fewer' : `Show all ${variants!.length} ${sealed ? 'products' : 'printings'}`}
                <Icon name="chevronDown" size={14} className={allPrintings ? 'flip' : ''} />
              </button>
            )}
          </div>
        </section>
      )}
      {sealed && (
        <section className="sheetsec">
          <h3>
            <Icon name="search" size={15} /> What could be inside
            {pulls && pulls !== 'error' && <em className="sheetsec__count">{pulls.cards.length} cards</em>}
          </h3>
          {pulls === null && <p className="printpick__hint">Loading the set list…</p>}
          {pulls === 'error' && <p className="printpick__hint">Couldn’t load the set list — check the link below.</p>}
          {pulls && pulls !== 'error' && (
            <>
              <p className="printpick__hint">
                Every card in {pulls.setName || 'this set'} — the priciest pulls first.
              </p>
              <div className="printpick">
                {(allPulls ? pulls.cards : pulls.cards.slice(0, PULLS_PREVIEW)).map((single) => (
                  <div key={single.id} className="printpick__row printpick__row--static">
                    <CardImg card={single} className="printpick__thumb" />
                    <span className="printpick__body">
                      <span className="printpick__set">{single.name}</span>
                      <span className="printpick__meta">
                        {[single.number ? `#${single.number}` : null, single.rarity].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <span className="printpick__price">{money(single.prices.best ?? single.prices.bestFoil)}</span>
                  </div>
                ))}
                {pulls.cards.length > PULLS_PREVIEW && (
                  <button className="printpick__more" onClick={() => setAllPulls(!allPulls)}>
                    {allPulls ? 'Show fewer' : `Show all ${pulls.cards.length} cards`}
                    <Icon name="chevronDown" size={14} className={allPulls ? 'flip' : ''} />
                  </button>
                )}
              </div>
            </>
          )}
          <div className="compslinks">
            <a className="btn btn--ghost" href={setListLink(card)} target="_blank" rel="noreferrer">
              <Icon name="external" size={15} /> Full set list
            </a>
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
            {!sealed && (
              <Seg
                ariaLabel="Finish"
                size="sm"
                options={addFinishOptions.map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
                value={finish}
                onChange={setFinish}
              />
            )}
            <div className="addbar__row2">
              {!sealed && (
                <select className="select" value={condition} onChange={(e) => setCondition(e.target.value as Condition)} aria-label="Condition">
                  {CONDITIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
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
            {sealed && <span className="addbar__paidecho">Adds as sealed — mark it Opened later under “Your copies”.</span>}
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
          {!sheet.deckId && !sealed && (
            <button className="btn btn--ghost" onClick={() => setDeckPickOpen(true)}>
              <Icon name="decks" size={16} /> Deck
            </button>
          )}
          {/* Only for a copy the user actually owns: a binder is an arrangement
              of physical cards, and the row is what carries the finish, the
              condition and the grade. From a search result the honest answer
              is the Add button beside this one. */}
          {!sheet.deckId && sheet.item && (
            <button className="btn btn--ghost" onClick={() => setBinderPickOpen(true)}>
              <Icon name="cards" size={16} /> Binder
            </button>
          )}
          {canBuy && seller && (
            <button className="btn btn--ghost addbar__buy" onClick={buy} disabled={buying}>
              <Icon name="cart" size={16} />{' '}
              {buying ? 'Opening…' : `Buy · ${money((seller.row.price ?? 0) * conditionFactor(seller.row.condition))}`}
            </button>
          )}
          {/* Asking is offered on a WIDER gate than buying: `canBuy` needs the
              marketplace switched on and the seller through Stripe
              verification, where a conversation needs neither. Most of what
              happens between two collectors is agreeing a swap, and that must
              not be gated behind a payments feature that ships off. */}
          {seller && messagingReady() && (
            <button
              className="btn btn--ghost"
              onClick={() => {
                setMessageDraft({
                  userId: seller.userId,
                  name: seller.name,
                  about: seller.row,
                  body: `Hi — are you still trading your ${seller.row.name}?`,
                })
                closeSheet()
                location.hash = `#/messages/${seller.userId}`
              }}
            >
              <Icon name="message" size={16} /> Ask
            </button>
          )}
        </div>
      </section>
      {sheet.item && (
        <BinderPicker
          open={binderPickOpen}
          onClose={() => setBinderPickOpen(false)}
          itemId={sheet.item.id}
          cardName={card.name}
        />
      )}
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

/**
 * The marks a sports collector reads first. A serial number and a rookie flag
 * change what a card is worth by more than its condition does, and unlike a
 * TCG's rarity they are not one tidy field — so they get chips of their own
 * rather than being buried in the type line.
 */
function SportsFacts({ card }: { card: Card }) {
  const info = card.sports
  if (!info) return null
  return (
    <>
      <span className="factchip">{SPORT_LABEL[info.sport]}</span>
      {info.serial && (
        <span className="serialchip">
          {info.serial.num}/{info.serial.of}
        </span>
      )}
      {info.rookie && <span className="factchip factchip--rookie">RC</span>}
      {info.auto && <span className="factchip">Auto</span>}
      {info.relic && <span className="factchip">Relic</span>}
    </>
  )
}

function CopyRow({ row, game }: { row: CollectionItem; game: Game }) {
  const toast = useUi((s) => s.toast)
  const sealed = row.opened != null || !!row.card.sealed
  const [editing, setEditing] = useState(false)
  const [finish, setFinish] = useState<Finish>(row.finish)
  const [condition, setCondition] = useState<Condition>(row.condition)
  const [opened, setOpened] = useState(row.opened ?? false)
  const [forTrade, setForTrade] = useState(row.forTrade ?? 0)
  const [paid, setPaid] = useState(row.purchasePrice != null ? String(row.purchasePrice) : '')
  const [value, setValue] = useState(row.marketValue != null ? String(row.marketValue) : '')
  const [note, setNote] = useState(row.note ?? '')
  const [saving, setSaving] = useState(false)
  const unit = itemUnitPrice(row)
  const paidValue = parseMoney(paid)
  const hasPaid = paid.trim().length > 0
  const marketValue = parseMoney(value)
  const hasValue = value.trim().length > 0

  const toggleEdit = () => {
    if (!editing) {
      setFinish(row.finish)
      setCondition(row.condition)
      setOpened(row.opened ?? false)
      setForTrade(row.forTrade ?? 0)
      setPaid(row.purchasePrice != null ? String(row.purchasePrice) : '')
      setValue(row.marketValue != null ? String(row.marketValue) : '')
      setNote(row.note ?? '')
    }
    setEditing(!editing)
  }

  const save = async () => {
    setSaving(true)
    const result = await guarded(
      () =>
        updateItem(row.id, {
          ...(sealed ? { opened } : { finish, condition }),
          // An opened box isn't the sealed product anymore — nothing to trade.
          forTrade: sealed && opened ? 0 : forTrade,
          purchasePrice: hasPaid ? (paidValue ?? row.purchasePrice) : undefined,
          // Clearing the field clears the override, putting the row back on
          // whatever the price feed says (nothing at all, for sports).
          marketValue: hasValue ? (marketValue ?? row.marketValue) : undefined,
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
          {sealed ? (
            <span className="copyrow__finish">{row.opened ? 'Opened' : 'Sealed'}</span>
          ) : (
            <>
              <span className="copyrow__finish">{FINISH_LABEL[row.finish]}</span>
              <span className="copyrow__cond">{row.condition}</span>
            </>
          )}
          {row.grade && <span className="gradechip">{gradeShort(row.grade)}</span>}
          {(row.forTrade ?? 0) > 0 && (
            <span className="tradechip">
              <Icon name="swap" size={11} /> {row.forTrade}
            </span>
          )}
        </span>
        <span className="copyrow__unit">{sealed && row.opened ? 'opened' : money(unit)}</span>
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
          aria-label={sealed ? 'Edit sealed copies' : `Edit ${FINISH_LABEL[row.finish]} ${row.condition} copies`}
        >
          <Icon name="pencil" size={16} />
        </button>
      </div>
      {editing && (
        <div className="copyedit">
          {sealed ? (
            <div className="copyedit__opened">
              <span className="copyedit__openedtext">
                <strong>Opened</strong>
                <em>Opened packs stop counting at the sealed price — scan the pulls in as singles</em>
              </span>
              <Toggle on={opened} onChange={setOpened} label="Opened" />
            </div>
          ) : (
            <Seg
              ariaLabel="Finish"
              size="sm"
              options={GAME_FINISHES[game].map((f) => ({ value: f, label: FINISH_LABEL[f] }))}
              value={finish}
              onChange={setFinish}
            />
          )}
          <div className="copyedit__row">
            {!sealed && (
              <select className="select" value={condition} onChange={(e) => setCondition(e.target.value as Condition)} aria-label="Condition">
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={paid}
              onChange={(e) => setPaid(moneyInput(e.target.value))}
              placeholder="Paid $ each"
              aria-label="Paid per card"
            />
            <input
              className="input"
              type="text"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(moneyInput(e.target.value))}
              placeholder="Worth $ each"
              aria-label="Market value per card"
            />
          </div>
          {hasValue && (
            <span className={`copyedit__echo ${marketValue != null ? '' : 'copyedit__echo--bad'}`}>
              {marketValue != null
                ? 'Your value — used as-is, not adjusted for condition'
                : 'Enter an amount like 12.50'}
            </span>
          )}
          {/* Grade-aware on purpose: a PSA 10 and a raw copy are different
              markets, and the grade lives on the COPY (decision 18), which is
              why the check belongs here rather than only up in the comp
              section. Accepting a figure fills the field — it does not save;
              the user still presses Save, and can still type over it. */}
          <PriceCheck card={row.card} grade={row.grade} onUse={(amount) => setValue(amount.toFixed(2))} />
          {!(sealed && opened) && (
            <div className="copyedit__trade">
              <span className="copyedit__tradetext">
                <strong>For trade</strong>
                <em>Flagged copies show up in your shared binder — friends can ask for them</em>
              </span>
              <Stepper value={Math.min(forTrade, row.qty)} onChange={setForTrade} min={0} max={row.qty} />
            </div>
          )}
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
  if (after.opened != null) return `Merged into your ${after.opened ? 'opened' : 'sealed'} copies`
  const finish = after.finish === 'nonfoil' ? '' : ` ${FINISH_LABEL[after.finish].toLowerCase()}`
  return `Merged into your ${after.condition}${finish} copies`
}

/* Price-history sparkline */

const SPARK_W = 320
const SPARK_H = 84
const SPARK_PAD = { top: 10, right: 8, bottom: 6, left: 8 }
/** Mirrors `--silver` in styles.css — keep in step if the accent moves. */
const SPARK_LINE = '#c3ccd9'

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
