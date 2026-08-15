import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { CardImg, Empty, Seg } from '../components/basics'
import { track } from '../lib/analytics'
import { CODE_EXAMPLE } from '../lib/cardcode'
import { searchGame } from '../lib/cardsearch'
import { recordPricePoint } from '../lib/db'
import { isAbort } from '../lib/fetchJson'
import { GAME_LABEL } from '../lib/games'
import { warmCatalog } from '../lib/tcgcsv'
import { useSettings } from '../lib/settings'
import type { Card, Game } from '../lib/types'
import { money } from '../lib/util'
import { uiStore, useUi } from '../store/ui'

export function SearchView() {
  const config = useSettings()
  const games = config.enabledGames
  const openSheet = useUi((s) => s.openSheet)
  const [game, setGame] = useState<Game>(() => {
    const preferred = config.gameFilter === 'auto' ? 'mtg' : config.gameFilter
    return games.includes(preferred) ? preferred : games[0]
  })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Card[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const gameRef = useRef(game)
  gameRef.current = game

  const runSearch = useCallback(
    (text: string, searchIn: Game) => {
      abortRef.current?.abort()
      if (text.trim().length < 2) {
        setResults(null)
        setLoading(false)
        setError(null)
        return
      }
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      setError(null)
      searchGame(searchIn, text.trim(), { pokemonKey: config.pokemonKey }, controller.signal)
        .then((cards) => {
          if (controller.signal.aborted) return
          setResults(cards)
          setLoading(false)
          track('search', { game: searchIn, results: cards.length })
          for (const card of cards.slice(0, 10)) recordPricePoint(card)
        })
        .catch((err) => {
          if (controller.signal.aborted || isAbort(err)) return
          setLoading(false)
          setError(err.message)
        })
    },
    [config.pokemonKey],
  )

  const onType = (text: string) => {
    setQuery(text)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(text, gameRef.current), 350)
  }

  useEffect(() => {
    // Picking a game tab names intent — start its catalog download (no-op
    // for API-backed games) before the user finishes typing.
    warmCatalog(game)
    clearTimeout(debounceRef.current)
    if (query.trim().length >= 2) runSearch(query, game)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game])

  useEffect(() => {
    const prefill = uiStore.getState().searchPrefill
    if (!prefill) return
    uiStore.getState().setSearchPrefill(null)
    // A prefill naming a turned-off game keeps its query but not the game.
    const prefillGame = prefill.game && games.includes(prefill.game) ? prefill.game : undefined
    const searchIn = prefillGame ?? game
    if (prefillGame) setGame(prefillGame)
    if (prefill.query) {
      setQuery(prefill.query)
      runSearch(prefill.query, searchIn)
    } else {
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(
    () => () => {
      clearTimeout(debounceRef.current)
      abortRef.current?.abort()
    },
    [],
  )

  // The printed set/batch number is a first-class query (see cardsearch.ts),
  // and nothing on the screen would say so unless the copy does.
  const codeExample = CODE_EXAMPLE[game]

  return (
    <div className="screen safe-top">
      <header className="screenhead searchhead">
        <Seg
          ariaLabel="Game"
          scroll
          options={games.map((g) => ({ value: g, label: GAME_LABEL[g] }))}
          value={game}
          onChange={setGame}
        />
      </header>
      <div className="searchbox">
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          type="search"
          placeholder={codeExample ? `Name or card number — ${codeExample}` : `Search ${GAME_LABEL[game]} cards…`}
          value={query}
          onChange={(event) => onType(event.target.value)}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {query && (
          <button className="iconbtn" onClick={() => onType('')} aria-label="Clear">
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      {loading && (
        <div className="cardgrid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="cardcell cardcell--skeleton" />
          ))}
        </div>
      )}
      {!loading && error && (
        <Empty
          icon="alert"
          title="Search failed"
          body={`The ${GAME_LABEL[game]} card service didn't answer. Check your connection and try again.`}
          note={error.slice(0, 90)}
          action={
            <button className="btn btn--primary" onClick={() => runSearch(query, game)}>
              Retry
            </button>
          }
        />
      )}
      {!loading && !error && results && results.length === 0 && (
        <Empty
          icon="search"
          title="No cards found"
          body={`Nothing in ${GAME_LABEL[game]} matches “${query}”.`}
          note={codeExample ? `Card numbers work too — try ${codeExample}.` : undefined}
        />
      )}
      {!loading && !error && results && results.length > 0 && (
        <>
          <p className="resultlegend">
            {results.length} {results.length === 1 ? 'result' : 'results'} · {GAME_LABEL[game]}
          </p>
          <div className="cardgrid">
            {results.map((card) => (
              <button key={card.id} className="cardcell" onClick={() => openSheet({ card, origin: 'search' })}>
                <CardImg card={card} />
                <span className="cardcell__price">{money(card.prices.best ?? card.prices.bestFoil)}</span>
                <span className="cardcell__name">{card.name}</span>
                <span className="cardcell__set">{card.setCode}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {!loading && !error && results == null && (
        <Empty
          icon="search"
          title="Look up any card"
          body={
            codeExample
              ? `Search by name, or by the number printed on the card — ${codeExample}. Tap a result for prices, comps and history.`
              : 'Type at least two letters. Tap a result for prices, comps and history.'
          }
        />
      )}
    </div>
  )
}
