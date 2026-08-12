import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { AnimatedNumber, CardImg, Empty, Modal } from '../components/basics'
import { DeckPicker } from '../components/DeckPicker'
import { Icon } from '../components/Icon'
import { track } from '../lib/analytics'
import { refreshCards, resolveImportRows } from '../lib/cardsearch'
import { readFileText, downloadFile } from '../lib/csv'
import {
  addToCollection,
  addCardToDeck,
  applyCardUpdate,
  db,
  exportBackup,
  historySince,
  importBackup,
  removeCopies,
  removeItems,
  updateDeck,
} from '../lib/db'
import { boardForCard } from '../lib/deckstats'
import { GAME_SHORT, FINISH_LABEL } from '../lib/games'
import { collectionToCsv, parseCollectionCsv, type CsvImportRow } from '../lib/importexport'
import { valueWindow } from '../lib/portfolio'
import {
  collectionValue,
  itemCurrency,
  itemUnitPrice,
  netProceeds,
  totalQty,
  valueByGame,
  FEE_PCT,
  type MoneyPair,
} from '../lib/prices'
import { useSettings } from '../lib/settings'
import type { CollectionItem, Currency, Deck, Game, PricePoint } from '../lib/types'
import { money, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'
import { InsightsPanel } from './InsightsPanel'

const NO_ITEMS: CollectionItem[] = []
const NO_POINTS: PricePoint[] = []
const ZERO: MoneyPair = { usd: 0, eur: 0 }
const HISTORY_DAYS = 32
const FILTER_DEBOUNCE_MS = 120
const PRICED_STALE_MS = 48 * 3_600_000

type SortMode = 'value' | 'name' | 'newest' | 'spares'

function unitPriceMap(items: CollectionItem[]): Map<string, { unit: number; currency: Currency }> {
  const map = new Map<string, { unit: number; currency: Currency }>()
  for (const item of items) map.set(item.id, { unit: itemUnitPrice(item) ?? 0, currency: itemCurrency(item) })
  return map
}

function spareValue(item: CollectionItem, unit: number): number {
  return item.qty > 1 ? (item.qty - 1) * unit : 0
}

function sparesSummary(items: CollectionItem[], units: Map<string, { unit: number; currency: Currency }>) {
  const summary = { count: 0, usd: 0, eur: 0 }
  for (const item of items) {
    if (item.qty <= 1) continue
    const unit = units.get(item.id)
    summary.count += item.qty - 1
    if (!unit) continue
    const value = spareValue(item, unit.unit)
    unit.currency === 'EUR' ? (summary.eur += value) : (summary.usd += value)
  }
  return summary
}

function exportScope(all: CollectionItem[], onScreen: CollectionItem[], editMode: boolean, selected: Set<string>) {
  return editMode && selected.size > 0
    ? { rows: all.filter((item) => selected.has(item.id)), name: 'selection' as const }
    : { rows: onScreen, name: 'collection' as const }
}

function bulkQtyToast(direction: number, rows: number, emptied: number): string {
  const noun = rows === 1 ? 'row' : 'rows'
  if (direction > 0) return `Added 1 to ${rows} ${noun}`
  const base = `Removed 1 from ${rows} ${noun}`
  return emptied > 0 ? `${base} · ${emptied} now empty and gone` : base
}

function pricedBadge(items: CollectionItem[], now = Date.now()) {
  const stamps = items.map((item) => item.card.prices.updatedAt).filter((at) => Number.isFinite(at) && at > 0)
  if (!stamps.length) return null
  stamps.sort((a, b) => a - b)
  const median = stamps[Math.floor(stamps.length / 2)]
  return {
    label: `PRICED ${new Date(median).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}`,
    stale: now - median > PRICED_STALE_MS,
    medianAt: median,
    oldestAt: stamps[0],
  }
}

export function CollectionView() {
  const items = useLiveQuery(() => db.collection.toArray(), [])
  const points = useLiveQuery(() => historySince(ymd(Date.now() - HISTORY_DAYS * 86_400_000)), []) ?? NO_POINTS
  const openSheet = useUi((s) => s.openSheet)
  const toast = useUi((s) => s.toast)
  const setBuilderSeeds = useUi((s) => s.setBuilderSeeds)
  const pokemonKey = useSettings((s) => s.pokemonKey)
  const [gameFilter, setGameFilter] = useState<Game | 'all'>('all')
  const [filterText, setFilterText] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('value')
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dataOpen, setDataOpen] = useState(false)
  const [busyText, setBusyText] = useState<string | null>(null)
  const [deckPickOpen, setDeckPickOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const refreshingRef = useRef(false)
  const refreshAbortRef = useRef<AbortController | null>(null)
  const [cancelable, setCancelable] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setFilter(filterText), FILTER_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filterText])

  const all = items ?? NO_ITEMS
  const units = useMemo(() => unitPriceMap(all), [all])
  const unitOf = useCallback((id: string) => units.get(id)?.unit ?? 0, [units])

  const shown = useMemo(() => {
    let rows = all
    if (gameFilter !== 'all') rows = rows.filter((item) => item.game === gameFilter)
    const needle = filter.trim().toLowerCase()
    if (needle)
      rows = rows.filter(
        (item) => item.name.toLowerCase().includes(needle) || item.setCode?.toLowerCase().includes(needle),
      )
    if (sort === 'spares') rows = rows.filter((item) => item.qty > 1)
    const sorted = rows === all ? [...rows] : rows
    if (sort === 'value') sorted.sort((a, b) => unitOf(b.id) * b.qty - unitOf(a.id) * a.qty)
    else if (sort === 'spares')
      sorted.sort((a, b) => spareValue(b, unitOf(b.id)) - spareValue(a, unitOf(a.id)) || b.qty - a.qty)
    else if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else sorted.sort((a, b) => b.addedAt - a.addedAt)
    return sorted
  }, [all, gameFilter, filter, sort, unitOf])

  const total = useMemo(() => collectionValue(all), [all])
  const count = useMemo(() => totalQty(all), [all])
  const byGame = useMemo(() => valueByGame(all), [all])
  const spares = useMemo(() => sparesSummary(all, units), [all, units])
  const priced = useMemo(() => pricedBadge(all), [all])
  const window = useMemo(() => valueWindow(all, points), [all, points])

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const pick = useCallback(
    (item: CollectionItem) => {
      if (editMode) toggleSelected(item.id)
      else openSheet({ card: item.card, item, origin: 'collection' })
    },
    [editMode, toggleSelected, openSheet],
  )

  const selectedItems = useMemo(() => all.filter((item) => selected.has(item.id)), [all, selected])

  const bulkQty = async (direction: number) => {
    const rows = selectedItems
    if (!rows.length) return
    const emptied = direction < 0 ? rows.filter((item) => item.qty <= 1).map((item) => item.id) : []
    const done = await guarded(async () => {
      for (const item of rows) {
        if (direction > 0) await addToCollection(item.card, { finish: item.finish, condition: item.condition, qty: 1 })
        else await removeCopies(item.id, 1)
      }
      return true
    }, 'Quantity')
    if (done) {
      if (emptied.length) {
        const gone = new Set(emptied)
        setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))))
      }
      toast(bulkQtyToast(direction, rows.length, emptied.length), 'success')
    }
  }

  const bulkRemove = async () => {
    const ids = [...selected]
    if (!ids.length) return
    if (!(await guarded(async () => (await removeItems(ids), true), 'Remove'))) return
    setSelected(new Set())
    setEditMode(false)
    toast(`Removed ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'}`, 'success')
  }

  /* Assign every selected row to a deck (skipping other games' cards). */
  const bulkAssignToDeck = async (deck: Deck) => {
    const rows = selectedItems
    const matching = rows.filter((item) => item.game === deck.game)
    const skipped = rows.length - matching.length
    if (!matching.length) {
      toast(`None of the selected cards are ${GAME_SHORT[deck.game]} cards`, 'error')
      return
    }
    const added = await guarded(async () => {
      for (const item of matching) {
        const board = boardForCard(deck.game, item.card.supertype, 'main')
        await addCardToDeck(deck.id, item.card, item.qty, board)
      }
      if (!deck.coverCardId) await updateDeck(deck.id, { coverCardId: matching[0].card.id })
      return matching.reduce((sum, item) => sum + item.qty, 0)
    }, 'Add to deck')
    if (added == null) return
    track('card_added', { game: deck.game, source: 'assign', batch: matching.length })
    setDeckPickOpen(false)
    const parts = [`Added ${added} ${added === 1 ? 'card' : 'cards'} to ${deck.name}`]
    if (skipped) parts.push(`${skipped} skipped — different game`)
    toast(parts.join(' · '), skipped ? 'info' : 'success')
  }

  /* Send the selected cards to the AI builder as seeds. */
  const buildAroundSelection = () => {
    const rows = selectedItems
    if (!rows.length) return
    const games = new Set(rows.map((item) => item.game))
    if (games.size > 1) {
      toast('Pick cards from one game to build a deck around', 'error')
      return
    }
    const seeds = [...new Map(rows.map((item) => [item.cardId, item.card])).values()]
    setBuilderSeeds(seeds)
    setDeckPickOpen(false)
    location.hash = '#/builder'
  }

  const selectionLegend =
    editMode && selected.size > 0
      ? `${selected.size} selected ${selected.size === 1 ? 'row' : 'rows'}`
      : `${shown.length} ${shown.length === 1 ? 'row' : 'rows'} on screen`

  const exportCsv = async () => {
    const scope = exportScope(all, shown, editMode, selected)
    downloadFile(`cardstock-${scope.name}-${ymd()}.csv`, collectionToCsv(scope.rows), 'text/csv')
    setDataOpen(false)
    toast(
      scope.name === 'selection'
        ? `Exported ${scope.rows.length} selected ${scope.rows.length === 1 ? 'row' : 'rows'}`
        : `Exported ${scope.rows.length} ${scope.rows.length === 1 ? 'row' : 'rows'} — what's on screen`,
      'info',
    )
  }

  const exportJson = async () => {
    downloadFile(`cardstock-backup-${ymd()}.json`, JSON.stringify(await exportBackup(), null, 1), 'application/json')
    setDataOpen(false)
  }

  const importFile = async (file: File) => {
    try {
      const text = await readFileText(file)
      if (file.name.endsWith('.json') || text.trimStart().startsWith('{')) {
        const parsed = JSON.parse(text)
        if (await guarded(async () => (await importBackup(parsed), true), 'Import')) {
          track('import_completed', { kind: 'backup', rows: parsed.collection?.length ?? 0, misses: 0 })
          toast('Backup imported', 'success')
        }
      } else {
        await importCsv(text)
      }
    } catch (err: any) {
      toast(`Import failed: ${err.message}`, 'error')
    } finally {
      setDataOpen(false)
      setBusyText(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const importCsv = async (text: string) => {
    const rows = parseCollectionCsv(text)
    setBusyText(`Importing 0/${rows.length}…`)
    const startedAt = performance.now()
    let done = 0
    let failed = 0
    const stats = await resolveImportRows(rows, {
      pokemonKey,
      onRow: async (row, card) => {
        if (card) {
          const csvRow = row as CsvImportRow
          const saved = await guarded(
            () =>
              addToCollection(card, {
                finish: csvRow.finish,
                condition: csvRow.condition,
                qty: csvRow.qty,
                purchasePrice: csvRow.purchasePrice,
              }),
            'Import',
          )
          if (!saved) failed++
        }
        done++
        if (done % 10 === 0 || done === rows.length) setBusyText(`Importing ${done}/${rows.length}…`)
      },
    })
    const added = stats.resolved - failed
    track('import_completed', {
      kind: 'csv',
      rows: rows.length,
      misses: stats.missed + failed,
      ms: Math.round(performance.now() - startedAt),
    })
    const parts = [`Imported ${added} ${added === 1 ? 'card' : 'cards'}`]
    if (stats.missed) parts.push(`${stats.missed} not found`)
    if (failed) parts.push(`${failed} not saved`)
    toast(parts.join(' · '), stats.missed || failed ? 'info' : 'success')
  }

  const cancelRefresh = () => {
    refreshAbortRef.current?.abort()
    setBusyText('Stopping…')
  }

  const refreshAllPrices = async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    const cards = [...new Map(all.map((item) => [item.cardId, item.card])).values()]
    const controller = new AbortController()
    refreshAbortRef.current = controller
    setCancelable(true)
    setDataOpen(false)
    let done = 0
    setBusyText(`Refreshing 0/${cards.length}…`)
    const startedAt = performance.now()
    try {
      const stats = await refreshCards(cards, {
        pokemonKey,
        signal: controller.signal,
        onCard: async (card) => {
          await guarded(async () => (await applyCardUpdate(card), true), 'Price update')
          done++
          if (done % 5 === 0 || done === cards.length) setBusyText(`Refreshing ${done}/${cards.length}…`)
        },
      })
      track('price_refresh', { ok: stats.failed === 0, ms: Math.round(performance.now() - startedAt), batch: cards.length })
      const skipped = cards.length - stats.ok - stats.failed
      const parts = [`Refreshed ${stats.ok}`]
      if (stats.failed) parts.push(`${stats.failed} unavailable`)
      if (skipped > 0) parts.push(`${skipped} skipped`)
      toast(parts.join(' · '), stats.failed || skipped > 0 ? 'info' : 'success')
    } catch (err: any) {
      toast(`Refresh failed: ${err.message}`, 'error')
    } finally {
      setBusyText(null)
      setCancelable(false)
      refreshAbortRef.current = null
      refreshingRef.current = false
    }
  }

  const busyBar = busyText ? (
    <div className="busybar">
      <span className="chip__spinner" /> {busyText}
      {cancelable && (
        <button className="btn btn--ghost btn--sm busybar__cancel" onClick={cancelRefresh}>
          Cancel
        </button>
      )}
    </div>
  ) : null

  if (items && items.length === 0) {
    return (
      <div className="screen safe-top">
        <header className="screenhead">
          <h1>Collection</h1>
        </header>
        {busyBar}
        <Empty
          icon="cards"
          title="Nothing collected yet"
          body="Scan a card and tap Add — or import a CSV from your previous collection app to bring everything over."
          action={
            <div className="empty__btns">
              <a className="btn btn--primary" href="#/scan">
                <Icon name="scan" size={16} /> Scan cards
              </a>
              <button className="btn btn--ghost" onClick={() => setDataOpen(true)}>
                <Icon name="upload" size={16} /> Import
              </button>
            </div>
          }
        />
        <DataMenu
          open={dataOpen}
          onClose={() => setDataOpen(false)}
          onCsv={exportCsv}
          onJson={exportJson}
          onImport={() => fileRef.current?.click()}
          onRefresh={refreshAllPrices}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.json,text/csv,application/json"
          hidden
          onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])}
        />
      </div>
    )
  }

  return (
    <div className={`screen safe-top ${editMode ? 'screen--bulk' : ''}`}>
      <header className="collhead">
        <div className="collhead__value">
          <span className="collhead__label">Collection value</span>
          <span className="collhead__figure">
            <span className="collhead__total">
              <AnimatedNumber value={total.usd} format={(v) => money(v)} />
            </span>
            {window.ready && (
              <span className={`collhead__delta collhead__delta--${window.delta >= 0 ? 'up' : 'down'}`}>
                <em>30d</em> {window.delta >= 0 ? '▲' : '▼'} {money(Math.abs(window.delta))} (
                {Math.abs(window.deltaPct).toFixed(1)}%)
              </span>
            )}
          </span>
          {total.usd > 0 && (
            <span className="netline">
              <span className="netline__label">Net if sold</span>
              <span className="netline__val">{money(netProceeds(total.usd))}</span>
              <em className="netline__note">after ~{Math.round(FEE_PCT * 100)}% fees, estimated</em>
            </span>
          )}
          <span className="collhead__meta">
            <span className="collhead__count">{count} cards</span>
            {total.eur > 0 && <span className="collhead__eur">+ {money(total.eur, 'EUR')} · eur only</span>}
            {priced && <span className={`collhead__priced ${priced.stale ? 'collhead__priced--stale' : ''}`}>{priced.label}</span>}
          </span>
        </div>
        <div className="collhead__games">
          {(['all', 'mtg', 'pokemon', 'yugioh'] as const).map((key) => {
            const pair = key === 'all' ? total : (byGame[key] ?? ZERO)
            return (
              <button key={key} className={`gamefilter ${gameFilter === key ? 'gamefilter--on' : ''}`} onClick={() => setGameFilter(key)}>
                <span>{key === 'all' ? 'All' : GAME_SHORT[key]}</span>
                <em>
                  {money(pair.usd)}
                  {pair.eur > 0 && <i className="gamefilter__eur">+{money(pair.eur, 'EUR')}</i>}
                </em>
              </button>
            )
          })}
        </div>
      </header>
      <InsightsPanel items={all} points={points} window={window} />
      <div className="colltools">
        <div className="searchbox searchbox--slim">
          <Icon name="search" size={16} />
          <input
            type="search"
            placeholder="Filter…"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            aria-label="Filter collection"
          />
        </div>
        <select className="select select--slim" value={sort} onChange={(event) => setSort(event.target.value as SortMode)} aria-label="Sort">
          <option value="value">By value</option>
          <option value="name">By name</option>
          <option value="newest">Newest</option>
          <option value="spares">Spares</option>
        </select>
        <button
          className={`btn btn--ghost btn--sm ${editMode ? 'btn--on' : ''}`}
          onClick={() => {
            setEditMode(!editMode)
            setSelected(new Set())
          }}
          aria-pressed={editMode}
        >
          <Icon name="pencil" size={15} /> Edit
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => setDataOpen(true)}>
          <Icon name="download" size={15} /> Data
        </button>
      </div>
      {busyBar}
      {sort === 'spares' && spares.count > 0 && (
        <div className="sparesline">
          {spares.count} SPARES · {money(spares.usd)}
          {spares.eur > 0 && <> · {money(spares.eur, 'EUR')}</>}
        </div>
      )}
      {items && shown.length === 0 && (
        <Empty
          icon="search"
          title="No matches"
          body={
            filter.trim()
              ? `Nothing in the collection matches “${filter.trim()}”.`
              : sort === 'spares'
                ? 'No duplicates yet — spares are the copies past the first of each row.'
                : 'No cards in that game yet.'
          }
        />
      )}
      <div className="cardgrid">
        {shown.map((item) => (
          <CollectionCell
            key={item.id}
            item={item}
            editMode={editMode}
            selected={selected.has(item.id)}
            unit={unitOf(item.id)}
            currency={units.get(item.id)?.currency ?? 'USD'}
            onPick={pick}
          />
        ))}
      </div>
      {editMode && selected.size > 0 && (
        <div className="bulkbar">
          <span className="bulkbar__count">{selected.size} selected</span>
          <span className="bulkbar__qty">
            <button
              className="iconbtn"
              onClick={() => {
                bulkQty(-1)
              }}
              aria-label="Remove one from each selected card"
            >
              <Icon name="minus" size={16} />
            </button>
            <button
              className="iconbtn"
              onClick={() => {
                bulkQty(1)
              }}
              aria-label="Add one to each selected card"
            >
              <Icon name="plus" size={16} />
            </button>
          </span>
          <button className="btn btn--ghost btn--sm" onClick={() => setDeckPickOpen(true)}>
            <Icon name="decks" size={15} /> Deck
          </button>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              exportCsv()
            }}
          >
            <Icon name="download" size={15} /> Export
          </button>
          <button
            className="btn btn--danger btn--sm"
            onClick={() => {
              bulkRemove()
            }}
          >
            <Icon name="trash" size={15} /> Remove
          </button>
        </div>
      )}
      <DeckPicker
        open={deckPickOpen}
        onClose={() => setDeckPickOpen(false)}
        title={`Add ${selected.size} ${selected.size === 1 ? 'card' : 'cards'} to a deck`}
        onPick={(deck) => {
          bulkAssignToDeck(deck)
        }}
        onBuildNew={buildAroundSelection}
        buildLabel={`Build a deck around ${selected.size === 1 ? 'this card' : 'these cards'}`}
        emptyHint="No decks yet — the AI builder can design one around your selection, or create one on the Decks tab first."
      />
      <DataMenu
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        onCsv={exportCsv}
        onJson={exportJson}
        onImport={() => fileRef.current?.click()}
        onRefresh={refreshAllPrices}
        csvScope={selectionLegend}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.json,text/csv,application/json"
        hidden
        onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])}
      />
    </div>
  )
}

const CollectionCell = memo(function CollectionCell({
  item,
  editMode,
  selected,
  unit,
  currency,
  onPick,
}: {
  item: CollectionItem
  editMode: boolean
  selected: boolean
  unit: number
  currency: Currency
  onPick: (item: CollectionItem) => void
}) {
  return (
    <button className={`cardcell ${selected ? 'cardcell--selected' : ''}`} onClick={() => onPick(item)}>
      <CardImg card={item.card} />
      {item.qty > 1 && <span className="cardcell__qty">×{item.qty}</span>}
      {item.finish !== 'nonfoil' && <span className="cardcell__finish">{FINISH_LABEL[item.finish]}</span>}
      <span className="cardcell__price">{money(unit * item.qty, currency)}</span>
      <span className="cardcell__name">{item.name}</span>
      <span className="cardcell__set">
        {item.setCode}
        {item.condition !== 'NM' ? ` · ${item.condition}` : ''}
      </span>
      {editMode && (
        <span className={`cardcell__check ${selected ? 'cardcell__check--on' : ''}`}>{selected && <Icon name="check" size={13} />}</span>
      )}
    </button>
  )
})

function DataMenu({
  open,
  onClose,
  onCsv,
  onJson,
  onImport,
  onRefresh,
  csvScope = 'spreadsheet-friendly',
}: {
  open: boolean
  onClose: () => void
  onCsv: () => void
  onJson: () => void
  onImport: () => void
  onRefresh: () => void
  csvScope?: string
}) {
  return (
    <Modal open={open} onClose={onClose} title="Collection data">
      <div className="datamenu">
        <button className="datamenu__opt" onClick={onImport}>
          <Icon name="upload" size={18} />
          <span>
            Import <em>collection CSV or Cardstock backup</em>
          </span>
        </button>
        <button className="datamenu__opt" onClick={onCsv}>
          <Icon name="download" size={18} />
          <span>
            Export CSV <em>{csvScope}</em>
          </span>
        </button>
        <button className="datamenu__opt" onClick={onJson}>
          <Icon name="download" size={18} />
          <span>
            Export backup <em>full JSON — collection, decks, history</em>
          </span>
        </button>
        <button className="datamenu__opt" onClick={onRefresh}>
          <Icon name="refresh" size={18} />
          <span>
            Refresh all prices <em>re-fetches every card</em>
          </span>
        </button>
      </div>
      <p className="datamenu__note">
        Everything lives on this device. Magic prices come from Scryfall, Pokémon from pokemontcg.io, Yu-Gi-Oh! from
        YGOPRODeck.
      </p>
    </Modal>
  )
}
