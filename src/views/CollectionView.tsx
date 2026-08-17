import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SPORT_LABEL, SPORTS } from '../lib/sports'
import { useLiveQuery } from 'dexie-react-hooks'
import { AnimatedNumber, CardImg, Empty, Modal } from '../components/basics'
import { DeckPicker } from '../components/DeckPicker'
import { BinderBulkPicker } from '../components/BinderPicker'
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
  setItemForTrade,
  updateDeck,
} from '../lib/db'
import { boardForCard } from '../lib/deckstats'
import { backupToDrive, isDriveConfigured, prewarmDrive } from '../lib/drive'
import { GAMES, GAME_SHORT, FINISH_LABEL, isFoilFinish } from '../lib/games'
import { collectionToCsv, parseCollectionCsv, type CsvImportRow } from '../lib/importexport'
import { valueWindow } from '../lib/portfolio'
import {
  collectionValue,
  itemUnitPrice,
  netProceeds,
  totalQty,
  valueByGame,
  FEE_PCT,
} from '../lib/prices'
import { useSettings } from '../lib/settings'
import type { CollectionItem, Deck, Game, PricePoint, Sport } from '../lib/types'
import { haptic, money, ymd } from '../lib/util'
import { guarded, useUi } from '../store/ui'
import { InsightsPanel } from './InsightsPanel'

const NO_ITEMS: CollectionItem[] = []
const NO_POINTS: PricePoint[] = []
const HISTORY_DAYS = 32
const FILTER_DEBOUNCE_MS = 120
const PRICED_STALE_MS = 48 * 3_600_000

/**
 * Ordering only. `spares` and `trade` used to live in here too, which made one
 * control answer two questions and answer neither well: they FILTERED, so
 * picking one silently threw rows away, and choosing an order for what was left
 * was then impossible. They are `Subset` below.
 */
type SortMode = 'value' | 'name' | 'newest'
/** Which rows are on screen at all — composes with any `SortMode`. */
type Subset = 'all' | 'spares' | 'trade'

const SORT_LABEL: Record<SortMode, string> = {
  value: 'By value',
  name: 'By name',
  newest: 'Newest',
}

function unitPriceMap(items: CollectionItem[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of items) map.set(item.id, itemUnitPrice(item) ?? 0)
  return map
}

function spareValue(item: CollectionItem, unit: number): number {
  return item.qty > 1 ? (item.qty - 1) * unit : 0
}

function sparesSummary(items: CollectionItem[], units: Map<string, number>) {
  const summary = { count: 0, value: 0 }
  for (const item of items) {
    if (item.qty <= 1) continue
    summary.count += item.qty - 1
    summary.value += spareValue(item, units.get(item.id) ?? 0)
  }
  return summary
}

function tradeQty(item: CollectionItem): number {
  return Math.min(item.qty, item.forTrade ?? 0)
}

function tradeValue(item: CollectionItem, unit: number): number {
  return tradeQty(item) * unit
}

function tradeSummary(items: CollectionItem[], units: Map<string, number>) {
  const summary = { count: 0, value: 0 }
  for (const item of items) {
    const qty = tradeQty(item)
    if (!qty) continue
    summary.count += qty
    summary.value += tradeValue(item, units.get(item.id) ?? 0)
  }
  return summary
}

function exportScope(all: CollectionItem[], onScreen: CollectionItem[], selectMode: boolean, selected: Set<string>) {
  return selectMode && selected.size > 0
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
  const driveOn = useSettings((s) => s.driveBackup)
  const [gameFilter, setGameFilter] = useState<Game | 'all'>('all')
  const [sportFilter, setSportFilter] = useState<Sport | 'all'>('all')
  const [filterText, setFilterText] = useState('')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('value')
  const [subset, setSubset] = useState<Subset>('all')
  /** Multi-select, for the bulk bar. Not editing a card — see the Select chip. */
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dataOpen, setDataOpen] = useState(false)
  const [busyText, setBusyText] = useState<string | null>(null)
  const [deckPickOpen, setDeckPickOpen] = useState(false)
  const [binderPickOpen, setBinderPickOpen] = useState(false)
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
  const unitOf = useCallback((id: string) => units.get(id) ?? 0, [units])

  const shown = useMemo(() => {
    let rows = all
    if (gameFilter !== 'all') rows = rows.filter((item) => item.game === gameFilter)
    if (sportFilter !== 'all') rows = rows.filter((item) => item.card.sports?.sport === sportFilter)
    const needle = filter.trim().toLowerCase()
    if (needle)
      rows = rows.filter(
        (item) => item.name.toLowerCase().includes(needle) || item.setCode?.toLowerCase().includes(needle),
      )
    if (subset === 'spares') rows = rows.filter((item) => item.qty > 1)
    else if (subset === 'trade') rows = rows.filter((item) => tradeQty(item) > 0)
    const sorted = rows === all ? [...rows] : rows
    // "By value" means the value of what is actually on screen: in a subset the
    // figure that matters is the spares' or the offered copies' worth, not the
    // whole row's. Those two orderings were the old `spares`/`trade` sort modes,
    // which is why they came with a filter welded on — now they are what By
    // value MEANS inside a subset, and By name and Newest work there too.
    if (sort === 'value')
      sorted.sort(
        subset === 'spares'
          ? (a, b) => spareValue(b, unitOf(b.id)) - spareValue(a, unitOf(a.id)) || b.qty - a.qty
          : subset === 'trade'
            ? (a, b) => tradeValue(b, unitOf(b.id)) - tradeValue(a, unitOf(a.id)) || tradeQty(b) - tradeQty(a)
            : (a, b) => unitOf(b.id) * b.qty - unitOf(a.id) * a.qty,
      )
    else if (sort === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
    else sorted.sort((a, b) => b.addedAt - a.addedAt)
    return sorted
  }, [all, gameFilter, sportFilter, filter, sort, subset, unitOf])

  const total = useMemo(() => collectionValue(all), [all])
  const count = useMemo(() => totalQty(all), [all])
  const byGame = useMemo(() => valueByGame(all), [all])
  // Only games actually collected get a filter chip — nine zero rows is noise.
  const ownedGames = useMemo(() => GAMES.filter((game) => byGame[game] != null), [byGame])
  useEffect(() => {
    if (gameFilter !== 'all' && items && !ownedGames.includes(gameFilter)) setGameFilter('all')
  }, [gameFilter, items, ownedGames])
  const spares = useMemo(() => sparesSummary(all, units), [all, units])
  const trades = useMemo(() => tradeSummary(all, units), [all, units])
  const priced = useMemo(() => pricedBadge(all), [all])
  // Not `window`. This is a 700-line component and that name shadowed the global
  // inside all of it, so the first line here to want `window.matchMedia` would
  // have got a portfolio figure and a confusing error.
  const valueWin = useMemo(() => valueWindow(all, points), [all, points])

  /**
   * Spares and for-trade as views with their own counts, beside the game chips.
   * Both used to be options inside the Sort control, where they filtered without
   * saying so and nothing announced there was anything to look at — a collector
   * with 38 spares had to open a dropdown to find that out.
   *
   * A chip appears only once the collection actually has any, the same rule the
   * game chips follow: no row of dead controls over a shelf of singles.
   */
  const subsetChips = useMemo(() => {
    const chips: { key: Subset; label: string; meta: string }[] = [
      { key: 'all', label: 'All', meta: `${count} ${count === 1 ? 'card' : 'cards'}` },
    ]
    if (spares.count > 0) chips.push({ key: 'spares', label: 'Spares', meta: `${spares.count} · ${money(spares.value)}` })
    if (trades.count > 0) chips.push({ key: 'trade', label: 'For trade', meta: `${trades.count} · ${money(trades.value)}` })
    return chips
  }, [count, spares, trades])

  // Trading away the last spare must not leave the grid filtered to nothing by a
  // chip that is no longer on screen.
  useEffect(() => {
    if (subset !== 'all' && !subsetChips.some((chip) => chip.key === subset)) setSubset('all')
  }, [subset, subsetChips])

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const pick = useCallback(
    (item: CollectionItem) => {
      if (selectMode) toggleSelected(item.id)
      else openSheet({ card: item.card, item, origin: 'collection' })
    },
    [selectMode, toggleSelected, openSheet],
  )

  /**
   * Sports collapses nine sports into one game chip, so the second row is how
   * a baseball collector gets to their baseball. It only appears once sports
   * are actually being filtered — one more row of chips over everyone else's
   * collection would be clutter they can do nothing with.
   */
  const ownedSports = useMemo(() => {
    if (gameFilter !== 'sports') return []
    const seen = new Set<Sport>()
    for (const item of all) if (item.card.sports) seen.add(item.card.sports.sport)
    return SPORTS.filter((sport) => seen.has(sport))
  }, [all, gameFilter])

  useEffect(() => {
    if (sportFilter !== 'all' && !ownedSports.includes(sportFilter)) setSportFilter('all')
  }, [ownedSports, sportFilter])

  const selectedItems = useMemo(() => all.filter((item) => selected.has(item.id)), [all, selected])

  /**
   * Select everything on screen, or drop it. Filing a shelf into a binder or
   * exporting one game meant tapping every card, because the bulk bar only
   * exists once something is picked — so there was no "all" to reach for.
   *
   * Scoped to `shown` and not to the whole collection, which is the same promise
   * the CSV export makes ("what's on screen"): the filters above are how you say
   * what you mean, and a button that quietly took the other 800 rows too would
   * make them decoration.
   */
  const allShownSelected = shown.length > 0 && shown.every((item) => selected.has(item.id))
  const toggleSelectAll = () => {
    setSelected(allShownSelected ? new Set() : new Set(shown.map((item) => item.id)))
    haptic(6)
  }

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

  /* Flag every selected row fully for trade — or clear if all are flagged. */
  const bulkTrade = async () => {
    const rows = selectedItems.filter((item) => item.opened !== true)
    if (!rows.length) {
      toast('Opened products can’t be listed for trade', 'info')
      return
    }
    const allMarked = rows.every((item) => tradeQty(item) === item.qty)
    const done = await guarded(async () => {
      for (const item of rows) await setItemForTrade(item.id, allMarked ? 0 : item.qty)
      return true
    }, 'Mark for trade')
    if (done) {
      const noun = rows.length === 1 ? 'row' : 'rows'
      toast(allMarked ? `Cleared the trade flag on ${rows.length} ${noun}` : `Marked ${rows.length} ${noun} for trade`, 'success')
    }
  }

  const bulkRemove = async () => {
    const ids = [...selected]
    if (!ids.length) return
    if (!(await guarded(async () => (await removeItems(ids), true), 'Remove'))) return
    setSelected(new Set())
    setSelectMode(false)
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
    selectMode && selected.size > 0
      ? `${selected.size} selected ${selected.size === 1 ? 'row' : 'rows'}`
      : `${shown.length} ${shown.length === 1 ? 'row' : 'rows'} on screen`

  /**
   * How tall the floating bulk bar actually is, published to CSS so the grid
   * can reserve exactly that much room underneath itself.
   *
   * The reservation used to be a constant in `.screen--bulk`, and the bar
   * outgrew it as soon as it started wrapping — 87px at 390px wide, 125px at
   * 320px against 130px reserved for bar + tab bar + margin — which left the
   * last row of cards permanently under the bar with nothing left to scroll.
   * A measurement can't drift from the bar the way a constant did, and it also
   * survives a longer label or another button being added to the row.
   */
  const barUp = selectMode && selected.size > 0
  const bulkRef = useRef<HTMLDivElement | null>(null)
  const [bulkHeight, setBulkHeight] = useState(0)
  useEffect(() => {
    const node = bulkRef.current
    if (!node) {
      setBulkHeight(0)
      return
    }
    const observer = new ResizeObserver(() => setBulkHeight(node.getBoundingClientRect().height))
    observer.observe(node)
    return () => observer.disconnect()
  }, [barUp])
  // Left unset — so `.screen--bulk` uses its fallback — only in the frame
  // between the bar mounting and its first measurement. No selection means no
  // bar and nothing to reserve.
  const bulkReserve = {
    '--bulkbar-h': barUp ? (bulkHeight ? `${Math.ceil(bulkHeight)}px` : undefined) : '0px',
  } as CSSProperties

  const exportCsv = async () => {
    const scope = exportScope(all, shown, selectMode, selected)
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

  /** Interactive, so a lapsed Google session can re-consent from this tap. */
  const backupToDriveNow = async () => {
    setDataOpen(false)
    setBusyText('Backing up to Drive…')
    try {
      await backupToDrive(true)
      if (!driveOn) useSettings.getState().set({ driveBackup: true })
      toast('Backed up to your Google Drive', 'success')
    } catch (err: any) {
      toast(err?.message ?? 'Drive backup failed', 'error')
    } finally {
      setBusyText(null)
    }
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
                forTrade: csvRow.forTrade,
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
          onDrive={backupToDriveNow}
          driveOn={driveOn}
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
    <div
      className={`screen safe-top ${selectMode ? 'screen--bulk' : ''}`}
      style={bulkReserve}
    >
      <header className="collhead">
        <div className="collhead__value">
          <span className="collhead__label">Collection value</span>
          <span className="collhead__figure">
            <span className="collhead__total">
              <AnimatedNumber value={total} format={(v) => money(v)} />
            </span>
            {valueWin.ready && (
              <span className={`collhead__delta collhead__delta--${valueWin.delta >= 0 ? 'up' : 'down'}`}>
                <em>30d</em> {valueWin.delta >= 0 ? '▲' : '▼'} {money(Math.abs(valueWin.delta))} (
                {Math.abs(valueWin.deltaPct).toFixed(1)}%)
              </span>
            )}
          </span>
          {total > 0 && (
            <span className="netline">
              <span className="netline__label">Net if sold</span>
              <span className="netline__val">{money(netProceeds(total))}</span>
              <em className="netline__note">after ~{Math.round(FEE_PCT * 100)}% fees, estimated</em>
            </span>
          )}
          <span className="collhead__meta">
            <span className="collhead__count">{count} cards</span>
            {priced && <span className={`collhead__priced ${priced.stale ? 'collhead__priced--stale' : ''}`}>{priced.label}</span>}
          </span>
        </div>
        <div className="collhead__games">
          {(['all' as const, ...ownedGames]).map((key) => {
            const value = key === 'all' ? total : (byGame[key] ?? 0)
            return (
              <button key={key} className={`gamefilter ${gameFilter === key ? 'gamefilter--on' : ''}`} onClick={() => setGameFilter(key)}>
                <span>{key === 'all' ? 'All' : GAME_SHORT[key]}</span>
                <em>{money(value)}</em>
              </button>
            )
          })}
        </div>
        {ownedSports.length > 1 && (
          <div className="collhead__games">
            {(['all' as const, ...ownedSports]).map((key) => (
              <button
                key={key}
                className={`gamefilter ${sportFilter === key ? 'gamefilter--on' : ''}`}
                onClick={() => setSportFilter(key)}
              >
                <span>{key === 'all' ? 'All sports' : SPORT_LABEL[key]}</span>
              </button>
            ))}
          </div>
        )}
        {subsetChips.length > 1 && (
          <div className="collhead__games">
            {subsetChips.map((chip) => (
              <button
                key={chip.key}
                className={`gamefilter ${subset === chip.key ? 'gamefilter--on' : ''}`}
                onClick={() => setSubset(chip.key)}
                aria-pressed={subset === chip.key}
              >
                <span>{chip.label}</span>
                <em>{chip.meta}</em>
              </button>
            ))}
          </div>
        )}
      </header>
      <InsightsPanel items={all} points={points} window={valueWin} />
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
          {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {SORT_LABEL[mode]}
            </option>
          ))}
        </select>
        {/* "Select", not "Edit". This enters multi-select for the bulk bar; it
            has never edited anything, and tapping a card in the collection now
            opens that copy's editor, so one screen cannot have two meanings for
            the word. */}
        <button
          className={`btn btn--ghost btn--sm ${selectMode ? 'btn--on' : ''}`}
          onClick={() => {
            setSelectMode(!selectMode)
            setSelected(new Set())
          }}
          aria-pressed={selectMode}
        >
          <Icon name="check" size={15} /> {selectMode ? 'Done' : 'Select'}
        </button>
        {selectMode && (
          <button className="btn btn--ghost btn--sm" onClick={toggleSelectAll} aria-pressed={allShownSelected}>
            <Icon name="grid" size={15} /> {allShownSelected ? 'None' : `All ${shown.length}`}
          </button>
        )}
        <button className="btn btn--ghost btn--sm" onClick={() => setDataOpen(true)}>
          <Icon name="download" size={15} /> Data
        </button>
      </div>
      {busyBar}
      {/* The chip above carries the count and the value; what this adds is the
          recourse, because a for-trade flag does nothing until a friend has the
          binder it appears in. */}
      {subset === 'trade' && trades.count > 0 && (
        <div className="sparesline">
          Offered to friends who have your binder ·{' '}
          <a className="sparesline__link" href="#/friends">
            share binder
          </a>
        </div>
      )}
      {items && shown.length === 0 && (
        <Empty
          icon="search"
          title="No matches"
          body={
            filter.trim()
              ? `Nothing in the collection matches “${filter.trim()}”.`
              : subset === 'spares'
                ? 'No duplicates in this game — spares are the copies past the first of each row.'
                : subset === 'trade'
                  ? 'Nothing here marked for trade — select rows and tap Trade, or set a For-trade count on a card’s copies.'
                  : 'No cards in that game yet.'
          }
        />
      )}
      <div className="cardgrid">
        {shown.map((item) => (
          <CollectionCell
            key={item.id}
            item={item}
            selectMode={selectMode}
            selected={selected.has(item.id)}
            unit={unitOf(item.id)}
            onPick={pick}
          />
        ))}
      </div>
      {barUp && (
        <div className="bulkbar" ref={bulkRef}>
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
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              bulkTrade()
            }}
          >
            <Icon name="swap" size={15} /> Trade
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => setDeckPickOpen(true)}>
            <Icon name="decks" size={15} /> Deck
          </button>
          {/* Filing a shelf that predates the app: select the rows, put them in
            * a binder, print its label. */}
          <button className="btn btn--ghost btn--sm" onClick={() => setBinderPickOpen(true)}>
            <Icon name="binder" size={15} /> Binder
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
      <BinderBulkPicker
        open={binderPickOpen}
        itemIds={[...selected]}
        onClose={() => {
          setBinderPickOpen(false)
          setSelected(new Set())
        }}
      />
      <DataMenu
        open={dataOpen}
        onClose={() => setDataOpen(false)}
        onCsv={exportCsv}
        onJson={exportJson}
        onImport={() => fileRef.current?.click()}
        onRefresh={refreshAllPrices}
        onDrive={backupToDriveNow}
        driveOn={driveOn}
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
  selectMode,
  selected,
  unit,
  onPick,
}: {
  item: CollectionItem
  selectMode: boolean
  selected: boolean
  unit: number
  onPick: (item: CollectionItem) => void
}) {
  return (
    <button
      className={`cardcell ${selected ? 'cardcell--selected' : ''}`}
      onClick={() => onPick(item)}
      // Only while selecting: the rest of the time this button opens a sheet,
      // and a pressed state on it would claim a toggle that isn't there.
      aria-pressed={selectMode ? selected : undefined}
    >
      <CardImg card={item.card} foil={isFoilFinish(item.finish)} />
      {item.qty > 1 && <span className="cardcell__qty">×{item.qty}</span>}
      {tradeQty(item) > 0 && (
        <span className="cardcell__trade">
          <Icon name="swap" size={11} />
          {tradeQty(item) < item.qty ? ` ${tradeQty(item)}` : ''}
        </span>
      )}
      {/* `firstEd` is an edition stamp and not a surface, so it gets the silver
          treatment rather than the rainbow — `isFoilFinish` above refuses it for
          the art for the same reason. */}
      {item.finish !== 'nonfoil' && (
        <span className={`cardcell__finish ${isFoilFinish(item.finish) ? '' : 'cardcell__finish--stamp'}`}>
          {FINISH_LABEL[item.finish]}
        </span>
      )}
      <span className="cardcell__price">{money(unit * item.qty)}</span>
      <span className="cardcell__name">{item.name}</span>
      <span className="cardcell__set">
        {item.setCode}
        {item.opened != null ? ` · ${item.opened ? 'Opened' : 'Sealed'}` : item.condition !== 'NM' ? ` · ${item.condition}` : ''}
      </span>
      {selectMode && (
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
  onDrive,
  driveOn,
  csvScope = 'spreadsheet-friendly',
}: {
  open: boolean
  onClose: () => void
  onCsv: () => void
  onJson: () => void
  onImport: () => void
  onRefresh: () => void
  onDrive: () => void
  driveOn: boolean
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
        {/* Only when the build can actually do it — a button that cannot work
            is worse than no button (same rule as the upload control). */}
        {isDriveConfigured() && (
          <button className="datamenu__opt" onClick={onDrive} onPointerDown={prewarmDrive}>
            <Icon name="refresh" size={18} />
            <span>
              {driveOn ? 'Back up to Drive now' : 'Back up to Google Drive'}{' '}
              <em>{driveOn ? 'a daily copy already goes to your Drive' : 'a daily copy in your own Drive — set up in Settings'}</em>
            </span>
          </button>
        )}
        <button className="datamenu__opt" onClick={onRefresh}>
          <Icon name="refresh" size={18} />
          <span>
            Refresh all prices <em>re-fetches every card</em>
          </span>
        </button>
      </div>
      <p className="datamenu__note">
        Everything lives on this device. Magic prices come from Scryfall, Pokémon from pokemontcg.io, Yu-Gi-Oh! from
        YGOPRODeck, Lorcana from Lorcast, and Riftbound, One Piece, Star Wars: Unlimited, Digimon &amp; Gundam from
        TCGplayer market data via TCGCSV.
      </p>
    </Modal>
  )
}
