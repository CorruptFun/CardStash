import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, Empty, Modal, Seg, Stepper } from '../components/basics'
import { Icon } from '../components/Icon'
import { ManaCost } from '../components/basics'
import { track } from '../lib/analytics'
import { searchGame } from '../lib/cardsearch'
import {
  addCardToDeck,
  createDeck,
  db,
  deleteDeck,
  ownedNameCounts,
  setDeckCardQty,
  updateDeck,
} from '../lib/db'
import {
  BOARD_LABEL,
  BOARD_SHORT,
  GAME_BOARDS,
  addedToBoardToast,
  boardForCard,
  deckCoverCard,
  deckRowUnitPrice,
  deckStats,
  groupBoards,
  decklistText,
  type DeckStats,
} from '../lib/deckstats'
import { isAbort } from '../lib/fetchJson'
import { GAME_LABEL, GAME_SHORT } from '../lib/games'
import { useSettings } from '../lib/settings'
import type { Card, Deck, DeckBoard, Game } from '../lib/types'
import { money } from '../lib/util'
import { guarded, useUi } from '../store/ui'

function ownedLine(stats: DeckStats): { count: string; toGet: string | null; cost: string | null } {
  return {
    count: `${stats.owned}/${stats.total}`,
    toGet: stats.missing.qty > 0 ? `${stats.missing.qty} to get` : null,
    cost: stats.missing.usd > 0 ? money(stats.missing.usd) : null,
  }
}

const COLLECTION_FILTER_LIMIT = 100

function filterOwned<T extends { name: string }>(rows: T[], filter: string, limit = COLLECTION_FILTER_LIMIT) {
  const needle = filter.trim().toLowerCase()
  const matched = needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows
  const shown = matched.slice(0, limit)
  return { rows: shown, matched: matched.length, hidden: matched.length - shown.length }
}

export function DecksView({ deckId, navigate }: { deckId: string | null; navigate: (hash: string) => void }) {
  return deckId ? <DeckDetail deckId={deckId} navigate={navigate} /> : <DeckList navigate={navigate} />
}

function DeckList({ navigate }: { navigate: (hash: string) => void }) {
  const decks = useLiveQuery(() => db.decks.orderBy('updatedAt').reverse().toArray(), [])
  const deckCards = useLiveQuery(() => db.deckCards.toArray(), [])
  const [creating, setCreating] = useState(false)
  const byDeck = useMemo(() => {
    const map = new Map<string, typeof deckCards & {}>()
    for (const row of deckCards ?? []) {
      const list = map.get(row.deckId) ?? []
      list.push(row)
      map.set(row.deckId, list)
    }
    return map
  }, [deckCards])

  return (
    <div className="screen safe-top">
      <header className="screenhead">
        <h1>Decks</h1>
        <div className="screenhead__btns">
          <button className="btn btn--ghost btn--sm" onClick={() => navigate('#/builder')}>
            <Icon name="sparkle" size={15} /> AI builder
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} /> New
          </button>
        </div>
      </header>
      {decks && decks.length === 0 && (
        <Empty
          icon="decks"
          title="No decks yet"
          body="Build one by hand, or let the AI builder research the current meta and propose decks from your collection."
          action={
            <div className="empty__btns">
              <button className="btn btn--primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={16} /> New deck
              </button>
              <button className="btn btn--holo" onClick={() => navigate('#/builder')}>
                <Icon name="sparkle" size={16} /> AI builder
              </button>
            </div>
          }
        />
      )}
      <div className="decklist">
        {(decks ?? []).map((deck) => {
          const rows = byDeck.get(deck.id) ?? []
          const stats = deckStats(deck.game, rows)
          const cover = deckCoverCard(rows, deck.coverCardId)
          return (
            <button key={deck.id} className="decktile" onClick={() => navigate(`#/decks/${deck.id}`)}>
              <div className="decktile__art">
                {cover ? (
                  <CardImg card={cover} rounded={false} />
                ) : (
                  <div className="decktile__blank">
                    <Icon name="decks" size={26} />
                  </div>
                )}
              </div>
              <div className="decktile__info">
                <h3>{deck.name}</h3>
                <p>
                  {GAME_LABEL[deck.game]}
                  {deck.format ? ` · ${deck.format}` : ''}
                </p>
                <p className="decktile__meta">
                  <span>{stats.total} cards</span>
                  <span className="decktile__val">{money(stats.value)}</span>
                </p>
              </div>
              <Icon name="chevronRight" size={18} className="decktile__go" />
            </button>
          )
        })}
      </div>
      <NewDeckModal open={creating} onClose={() => setCreating(false)} onCreated={(deck) => navigate(`#/decks/${deck.id}`)} />
    </div>
  )
}

function NewDeckModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (deck: Deck) => void
}) {
  const games = useSettings((s) => s.enabledGames)
  const [name, setName] = useState('')
  const [game, setGame] = useState<Game>(() => (games.includes('mtg') ? 'mtg' : games[0]))
  const [format, setFormat] = useState('')
  const create = async () => {
    if (!name.trim()) return
    const deck = await guarded(() => createDeck(game, name.trim(), format.trim() || undefined), 'Create deck')
    if (deck) {
      track('deck_created', { game, source: 'manual' })
      onClose()
      setName('')
      onCreated(deck)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="New deck">
      <div className="form">
        <input className="input" placeholder="Deck name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <select className="select" value={game} onChange={(e) => setGame(e.target.value as Game)} aria-label="Game">
          {games.map((g) => (
            <option key={g} value={g}>
              {GAME_LABEL[g]}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder={game === 'mtg' ? 'Format (Standard, Modern, Commander…)' : 'Format (optional)'}
          value={format}
          onChange={(e) => setFormat(e.target.value)}
        />
        <button
          className="btn btn--primary"
          onClick={() => {
            create()
          }}
          disabled={!name.trim()}
        >
          Create deck
        </button>
      </div>
    </Modal>
  )
}

function DeckDetail({ deckId, navigate }: { deckId: string; navigate: (hash: string) => void }) {
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const rows = useLiveQuery(() => db.deckCards.where('deckId').equals(deckId).toArray(), [deckId])
  const owned = useLiveQuery(async () => (deck ? ownedNameCounts(deck.game) : new Map<string, number>()), [deck?.game])
  const openSheet = useUi((s) => s.openSheet)
  const toast = useUi((s) => s.toast)
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [statsOpen, setStatsOpen] = useState(true)
  const [qtyOpenId, setQtyOpenId] = useState<string | null>(null)

  if (!deck) return <div className="screen safe-top" />

  const stats = deckStats(deck.game, rows ?? [], owned)
  const boards = groupBoards(rows ?? [])
  const ownership = ownedLine(stats)

  const copyList = async () => {
    try {
      await navigator.clipboard.writeText(decklistText(rows ?? []))
      toast('Deck list copied', 'success')
    } catch {
      toast('Could not access the clipboard', 'error')
    }
  }

  const remove = async () => {
    if (!confirm(`Delete “${deck.name}”?`)) return
    if (!(await guarded(async () => (await deleteDeck(deck.id), true), 'Delete deck'))) return
    toast('Deck deleted', 'success')
    navigate('#/decks')
  }

  return (
    <div className="screen safe-top screen--docked">
      <header className="deckhead">
        <button className="iconbtn" onClick={() => navigate('#/decks')} aria-label="Back">
          <Icon name="chevronLeft" size={20} />
        </button>
        <div className="deckhead__title">
          <h1>
            <button className="deckhead__rename" onClick={() => setRenaming(true)} aria-label={`Rename ${deck.name}`}>
              <span className="deckhead__name">{deck.name}</span>
              <Icon name="pencil" size={13} className="deckhead__pencil" />
            </button>
          </h1>
          <p>
            <span>{GAME_SHORT[deck.game]}</span>
            {deck.format && <span>{deck.format}</span>}
            <span>{stats.total} cards</span>
            <span className="deckhead__val">{money(stats.value)}</span>
          </p>
        </div>
        <button
          className="iconbtn"
          onClick={() => {
            copyList()
          }}
          aria-label="Copy deck list"
        >
          <Icon name="copy" size={18} />
        </button>
        <button
          className="iconbtn"
          onClick={() => {
            remove()
          }}
          aria-label="Delete deck"
        >
          <Icon name="trash" size={18} />
        </button>
      </header>
      {stats.total > 0 && (
        <div className="ownedline">
          <div className="ownedline__top">
            <span>Owned</span>
            <span className="ownedline__count">
              {ownership.count}
              {ownership.toGet && ` · ${ownership.toGet}`}
              {ownership.cost && (
                <b className="ownedline__cost"> · {ownership.cost}</b>
              )}
            </span>
          </div>
          <div className="ownedline__track">
            <div className="ownedline__fill" style={{ width: `${stats.total ? (stats.owned / stats.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}
      {stats.warnings.length > 0 && (
        <div className="deckwarnings">
          {stats.warnings.map((warning) => (
            <span key={warning}>
              <Icon name="alert" size={13} /> {warning}
            </span>
          ))}
        </div>
      )}
      {stats.total > 0 && (
        <section className="deckstats">
          <button className="deckstats__toggle" onClick={() => setStatsOpen(!statsOpen)}>
            Stats <Icon name="chevronDown" size={15} className={statsOpen ? 'flip' : ''} />
          </button>
          {statsOpen && (
            <div className="deckstats__body">
              {deck.game === 'mtg' && stats.curve.some((n) => n > 0) && (
                <div className="deckstats__block">
                  <h4>Mana curve</h4>
                  <ManaCurve curve={stats.curve} />
                </div>
              )}
              {deck.game === 'mtg' && <ColorBar colors={stats.colors} />}
              <div className="deckstats__block">
                <h4>Card types</h4>
                <TypeBars types={stats.types} />
              </div>
            </div>
          )}
        </section>
      )}
      {stats.total === 0 && (
        <Empty
          icon="cards"
          title="Empty deck"
          body="Add cards from search or your collection."
          action={
            <button className="btn btn--primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Add cards
            </button>
          }
        />
      )}
      {boards.map(({ board, groups }) => (
        <section key={board} className="deckboard">
          {(boards.length > 1 || board !== 'main') && (
            <h3 className="deckboard__title">
              {BOARD_LABEL[board]} · {groups.reduce((sum, group) => sum + group.cards.reduce((s, row) => s + row.qty, 0), 0)}
            </h3>
          )}
          {groups.map((group) => (
            <div key={group.type} className="deckgroup">
              <h4>
                {group.type} · {group.cards.reduce((sum, row) => sum + row.qty, 0)}
              </h4>
              {group.cards.map((row) => {
                const ownedCopies = owned?.get(row.card.name.toLowerCase()) ?? 0
                return (
                  <div key={row.id} className="deckrow">
                    <button className="deckrow__main" onClick={() => openSheet({ card: row.card, deckId: deck.id, origin: 'deck' })}>
                      <CardImg card={row.card} className="deckrow__img" />
                      <div className="deckrow__text">
                        <span className="deckrow__name">{row.card.name}</span>
                        <span className="deckrow__sub">
                          {ownedCopies >= row.qty ? (
                            <em className="deckrow__owned">
                              <Icon name="check" size={11} /> owned
                            </em>
                          ) : ownedCopies > 0 ? (
                            <em className="deckrow__partial">
                              {ownedCopies}/{row.qty} owned
                            </em>
                          ) : (
                            <em className="deckrow__missing">need {row.qty}</em>
                          )}{' '}
                          · {money(deckRowUnitPrice(row))}
                        </span>
                      </div>
                      {row.card.manaCost && <ManaCost cost={row.card.manaCost} className="deckrow__mana" />}
                    </button>
                    <div className={`deckrow__qty ${qtyOpenId === row.id ? 'deckrow__qty--open' : ''}`}>
                      <button
                        className="deckrow__qtychip"
                        onClick={() => setQtyOpenId(qtyOpenId === row.id ? null : row.id)}
                        aria-label={`Change quantity of ${row.card.name}`}
                      >
                        ×{row.qty}
                      </button>
                      <Stepper
                        value={row.qty}
                        onChange={(qty) => {
                          guarded(() => setDeckCardQty(row.id, qty), 'Update quantity')
                        }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
        </section>
      ))}
      {stats.total > 0 && (
        <div className="deckfab">
          <div className="deckfab__inner">
            <button className="btn btn--primary" onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} /> Add cards
            </button>
          </div>
        </div>
      )}
      <AddCardsModal open={adding} onClose={() => setAdding(false)} deck={deck} />
      <RenameDeckModal open={renaming} onClose={() => setRenaming(false)} deck={deck} />
    </div>
  )
}

function RenameDeckModal({ open, onClose, deck }: { open: boolean; onClose: () => void; deck: Deck }) {
  const toast = useUi((s) => s.toast)
  const [name, setName] = useState(deck.name)
  const [format, setFormat] = useState(deck.format ?? '')
  useEffect(() => {
    if (open) {
      setName(deck.name)
      setFormat(deck.format ?? '')
    }
  }, [open, deck.name, deck.format])
  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed || (trimmed === deck.name && format.trim() === (deck.format ?? ''))) {
      onClose()
      return
    }
    if (await guarded(async () => (await updateDeck(deck.id, { name: trimmed, format: format.trim() || undefined }), true), 'Rename deck')) {
      toast('Deck renamed', 'success')
      onClose()
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Rename deck">
      <div className="form">
        <input
          className="input"
          placeholder="Deck name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
          autoFocus
        />
        <input
          className="input"
          placeholder={deck.game === 'mtg' ? 'Format (Standard, Modern, Commander…)' : 'Format (optional)'}
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <button
          className="btn btn--primary"
          onClick={() => {
            save()
          }}
          disabled={!name.trim()}
        >
          Save
        </button>
      </div>
    </Modal>
  )
}

function AddCardsModal({ open, onClose, deck }: { open: boolean; onClose: () => void; deck: Deck }) {
  const pokemonKey = useSettings((s) => s.pokemonKey)
  const toast = useUi((s) => s.toast)
  const [source, setSource] = useState<'search' | 'collection'>('search')
  const [query, setQuery] = useState('')
  const [ownedFilter, setOwnedFilter] = useState('')
  const [results, setResults] = useState<Card[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ownedRows = useLiveQuery(() => db.collection.where('game').equals(deck.game).toArray(), [deck.game])
  const filtered = useMemo(() => filterOwned(ownedRows ?? [], ownedFilter), [ownedRows, ownedFilter])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const abortRef = useRef<AbortController | null>(null)
  const boards = GAME_BOARDS[deck.game]
  const [board, setBoard] = useState<DeckBoard>('main')

  const onType = (text: string) => {
    setQuery(text)
    clearTimeout(debounceRef.current)
    abortRef.current?.abort()
    if (text.trim().length < 2) {
      setResults([])
      setSearching(false)
      setError(null)
      return
    }
    debounceRef.current = setTimeout(() => {
      const controller = new AbortController()
      abortRef.current = controller
      setSearching(true)
      setError(null)
      searchGame(deck.game, text.trim(), { pokemonKey }, controller.signal)
        .then((cards) => {
          if (controller.signal.aborted) return
          setResults(cards)
          setSearching(false)
        })
        .catch((err) => {
          if (controller.signal.aborted || isAbort(err)) return
          setResults([])
          setSearching(false)
          setError(err.message.slice(0, 120))
        })
    }, 350)
  }

  useEffect(
    () => () => {
      clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    },
    [],
  )

  const add = async (card: Card, toBoard: DeckBoard = board) => {
    const resolved = boardForCard(deck.game, card.supertype, toBoard)
    const done = await guarded(async () => {
      await addCardToDeck(deck.id, card, 1, resolved)
      await updateDeck(deck.id, deck.coverCardId ? {} : { coverCardId: card.id })
      return true
    }, 'Add to deck')
    if (done) toast(addedToBoardToast(card.name, resolved), 'success')
  }

  return (
    <Modal open={open} onClose={onClose} title={`Add to ${deck.name}`}>
      <Seg
        ariaLabel="Source"
        options={[
          { value: 'search', label: 'Search' },
          { value: 'collection', label: 'My collection' },
        ]}
        value={source}
        onChange={setSource}
      />
      {boards.length > 1 && (
        <div className="addboard">
          <span className="fieldlabel" id="addcards-board">
            Board
          </span>
          <Seg
            ariaLabelledBy="addcards-board"
            size="sm"
            options={boards.map((b) => ({ value: b, label: BOARD_SHORT[b] }))}
            value={board}
            onChange={setBoard}
          />
        </div>
      )}
      {source === 'search' && (
        <>
          <div className="searchbox searchbox--slim" style={{ marginTop: 10 }}>
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={`Search ${GAME_LABEL[deck.game]}…`}
              value={query}
              onChange={(e) => onType(e.target.value)}
              autoFocus
            />
          </div>
          <div className="addlist">
            {searching && <div className="addlist__hint">Searching…</div>}
            {!searching && error && <div className="addlist__hint">Search failed — {error}</div>}
            {!searching && !error && query.trim().length >= 2 && results.length === 0 && (
              <div className="addlist__hint">
                No {GAME_LABEL[deck.game]} cards match “{query.trim()}”.
              </div>
            )}
            {!searching &&
              results.map((card) => (
                <div key={card.id} className="addlist__row">
                  <CardImg card={card} className="addlist__img" />
                  <div className="addlist__text">
                    <span>{card.name}</span>
                    <em>{card.setCode}</em>
                  </div>
                  <span className="addlist__price num">{money(card.prices.best ?? card.prices.bestFoil)}</span>
                  <button
                    className="iconbtn iconbtn--accent"
                    onClick={() => {
                      add(card)
                    }}
                    aria-label={`Add ${card.name}`}
                  >
                    <Icon name="plus" size={17} />
                  </button>
                </div>
              ))}
          </div>
        </>
      )}
      {source === 'collection' && (
        <>
          <div className="searchbox searchbox--slim" style={{ marginTop: 10 }}>
            <Icon name="search" size={16} />
            <input
              type="search"
              placeholder={`Filter ${GAME_LABEL[deck.game]} cards you own…`}
              value={ownedFilter}
              onChange={(e) => setOwnedFilter(e.target.value)}
            />
            {ownedFilter && (
              <button className="iconbtn" onClick={() => setOwnedFilter('')} aria-label="Clear">
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
          <div className="addlist">
            {(ownedRows ?? []).length === 0 && (
              <div className="addlist__hint">No {GAME_LABEL[deck.game]} cards in your collection yet.</div>
            )}
            {(ownedRows ?? []).length > 0 && filtered.matched === 0 && (
              <div className="addlist__hint">Nothing you own matches “{ownedFilter.trim()}”.</div>
            )}
            {filtered.rows.map((item) => (
              <div key={item.id} className="addlist__row">
                <CardImg card={item.card} className="addlist__img" />
                <div className="addlist__text">
                  <span>{item.name}</span>
                  <em>×{item.qty} owned</em>
                </div>
                <span className="addlist__price num">{money(item.card.prices.best ?? item.card.prices.bestFoil)}</span>
                <button
                  className="iconbtn iconbtn--accent"
                  onClick={() => {
                    add(item.card)
                  }}
                  aria-label={`Add ${item.name}`}
                >
                  <Icon name="plus" size={17} />
                </button>
              </div>
            ))}
            {filtered.hidden > 0 && (
              <div className="addlist__hint addlist__more">
                <span className="num">{filtered.hidden}</span> more — keep typing to narrow
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

/* Deck charts */

/** Mirrors `--silver` in styles.css — keep in step if the accent moves. */
const CURVE_COLOR = '#c3ccd9'

const MTG_COLORS: Record<string, { fill: string; label: string }> = {
  W: { fill: '#a3903f', label: 'White' },
  U: { fill: '#4b93d9', label: 'Blue' },
  B: { fill: '#7d5294', label: 'Black' },
  R: { fill: '#d95f3b', label: 'Red' },
  G: { fill: '#2f9d77', label: 'Green' },
  C: { fill: '#8a8f98', label: 'Colorless' },
}
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G', 'C']

function roundedBarPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + w - radius}Q${x + w},${y} ${x + w},${y + radius}V${y + h}Z`
}

function ManaCurve({ curve }: { curve: number[] }) {
  const max = Math.max(...curve, 1)
  const W = 320
  const H = 96
  const PAD_BOTTOM = 18
  const PAD_TOP = 14
  const GAP = 8
  const barW = (W - GAP * (curve.length + 1)) / curve.length
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Mana curve">
      <line x1="0" x2={W} y1={H - PAD_BOTTOM} y2={H - PAD_BOTTOM} className="chart__baseline" />
      {curve.map((count, i) => {
        const x = GAP + i * (barW + GAP)
        const barH = count === 0 ? 0 : Math.max(5, ((H - PAD_BOTTOM - PAD_TOP) * count) / max)
        return (
          <g key={i}>
            {count > 0 && (
              <>
                <path d={roundedBarPath(x, H - PAD_BOTTOM - barH, barW, barH, 4)} fill={CURVE_COLOR} opacity={0.92} />
                <text x={x + barW / 2} y={H - PAD_BOTTOM - barH - 5} className="chart__value" textAnchor="middle">
                  {count}
                </text>
              </>
            )}
            <text x={x + barW / 2} y={H - 5} className="chart__tick" textAnchor="middle">
              {i === 7 ? '7+' : i}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function ColorBar({ colors }: { colors: Record<string, number> }) {
  const present = COLOR_ORDER.filter((key) => colors[key] > 0).map((key) => ({ key, count: colors[key] }))
  if (!present.reduce((sum, c) => sum + c.count, 0)) return null
  return (
    <div className="colorbar">
      <div className="colorbar__track">
        {present.map((color) => (
          <div key={color.key} className="colorbar__seg" style={{ flexGrow: color.count, background: MTG_COLORS[color.key].fill }} />
        ))}
      </div>
      <div className="colorbar__chips">
        {present.map((color) => (
          <span key={color.key} className="colorbar__chip">
            <i style={{ background: MTG_COLORS[color.key].fill }} />
            {MTG_COLORS[color.key].label} · {color.count}
          </span>
        ))}
      </div>
    </div>
  )
}

function TypeBars({ types }: { types: { type: string; count: number }[] }) {
  const max = Math.max(...types.map((t) => t.count), 1)
  return (
    <div className="typebars">
      {types.slice(0, 6).map((row) => (
        <div key={row.type} className="typebars__row">
          <span className="typebars__label">{row.type}</span>
          <div className="typebars__track">
            <div className="typebars__fill" style={{ width: `${(row.count / max) * 100}%` }} />
          </div>
          <span className="typebars__count">{row.count}</span>
        </div>
      ))}
    </div>
  )
}
