import { useMemo, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { CardImg, Seg } from '../components/basics'
import { Icon } from '../components/Icon'
import { track } from '../lib/analytics'
import { matchGame } from '../lib/cardsearch'
import { addCardToDeck, createDeck, db, ownedNameCounts, updateDeck } from '../lib/db'
import { boardForCard } from '../lib/deckstats'
import { buildDecks, type BuildDecksResult, type ParsedDeck } from '../lib/gemini'
import { GAME_LABEL, GAMES } from '../lib/games'
import { useSettings } from '../lib/settings'
import type { Card, Game } from '../lib/types'
import { sleep } from '../lib/util'
import { guarded, uiStore, useUi } from '../store/ui'

const LOOKUP_GAP_MS = 110

function createdToast(added: number, missed: number, failed: number): { text: string; kind: 'success' | 'info' } {
  if (!missed && !failed) return { text: `Deck created with ${added} cards`, kind: 'success' }
  const parts = [`${added} added`]
  if (missed) parts.push(`${missed} not found`)
  if (failed) parts.push(`${failed} couldn't be looked up`)
  return { text: `Deck created — ${parts.join(', ')}`, kind: 'info' }
}

export function BuilderView({ navigate }: { navigate: (hash: string) => void }) {
  const config = useSettings()
  const toast = useUi((s) => s.toast)
  // Seeds arrive via the UI store from "Build a deck around this card" flows;
  // consumed once so a later plain visit starts clean.
  const [seeds, setSeeds] = useState<Card[]>(() => {
    const handed = uiStore.getState().builderSeeds
    if (handed?.length) uiStore.getState().setBuilderSeeds(null)
    return handed ?? []
  })
  const [game, setGame] = useState<Game>(seeds[0]?.game ?? 'mtg')
  const [format, setFormat] = useState(seeds[0]?.game && seeds[0].game !== 'mtg' ? '' : 'Standard')
  const [style, setStyle] = useState('')
  const [budget, setBudget] = useState<number | null>(50)
  const [useCollection, setUseCollection] = useState(true)
  const [phase, setPhase] = useState<'form' | 'loading' | 'result'>('form')
  const [result, setResult] = useState<BuildDecksResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [buildingTitle, setBuildingTitle] = useState<string | null>(null)

  const owned = useLiveQuery(() => db.collection.where('game').equals(game).toArray(), [game])
  const ownedCounts = useLiveQuery(() => ownedNameCounts(game), [game])
  const collectionList = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of owned ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + item.qty)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 400)
      .map(([name, qty]) => `${name} ×${qty}`)
      .join('\n')
  }, [owned])

  const removeSeed = (id: string) => setSeeds((prev) => prev.filter((card) => card.id !== id))

  const pickGame = (next: Game) => {
    setGame(next)
    setFormat(next === 'mtg' ? 'Standard' : '')
    // Seeds are per-game; switching games drops ones that no longer apply.
    setSeeds((prev) => prev.filter((card) => card.game === next))
  }

  const research = async () => {
    setPhase('loading')
    setError(null)
    const startedAt = performance.now()
    try {
      const res = await buildDecks(
        { game, format, style, budget, collectionList, useCollection, seedCards: seeds },
        config.geminiKey,
        config.geminiModel,
      )
      setResult(res)
      setPhase('result')
      track('ai_builder_run', { game, ok: true, seeded: seeds.length > 0, ms: Math.round(performance.now() - startedAt) })
    } catch (err: any) {
      setError(err.message)
      setPhase('form')
      track('ai_builder_run', { game, ok: false, seeded: seeds.length > 0, ms: Math.round(performance.now() - startedAt) })
    }
  }

  const createFromProposal = async (proposal: ParsedDeck) => {
    setBuildingTitle(proposal.title)
    try {
      const deck = await guarded(() => createDeck(game, proposal.title, format || undefined), 'Create deck')
      if (!deck) return
      track('deck_created', { game, source: 'ai', seeded: seeds.length > 0 })
      let added = 0
      let missed = 0
      let failed = 0
      let lastLookupAt = 0
      const addedNames = new Set<string>()
      for (const line of proposal.lines) {
        const sinceLast = Date.now() - lastLookupAt
        if (sinceLast < LOOKUP_GAP_MS) await sleep(LOOKUP_GAP_MS - sinceLast)
        lastLookupAt = Date.now()
        // The seeds already carry full card data — no lookup needed for them.
        const seed = seeds.find((card) => card.name.toLowerCase() === line.name.toLowerCase())
        let card: Card | null = seed ?? null
        if (!card) {
          try {
            card = await matchGame(game, line.name, null, null, { pokemonKey: config.pokemonKey })
          } catch {
            failed++
            continue
          }
        }
        if (!card) {
          missed++
          continue
        }
        const resolved = card
        const isFirst = added === 0
        const board = boardForCard(game, resolved.supertype, 'main')
        const done = await guarded(async () => {
          await addCardToDeck(deck.id, resolved, line.qty, board)
          if (isFirst) await updateDeck(deck.id, { coverCardId: resolved.id })
          return true
        }, 'Add to deck')
        if (done) {
          added++
          addedNames.add(resolved.name.toLowerCase())
        } else failed++
      }
      // A proposal that dropped a seed still gets it: the whole point of the
      // flow is that the chosen cards end up in the deck.
      for (const seed of seeds) {
        if (addedNames.has(seed.name.toLowerCase())) continue
        const board = boardForCard(game, seed.supertype, 'main')
        if (await guarded(async () => (await addCardToDeck(deck.id, seed, 1, board), true), 'Add to deck')) added++
      }
      const summary = createdToast(added, missed, failed)
      toast(summary.text, summary.kind)
      navigate(`#/decks/${deck.id}`)
    } catch (err: any) {
      toast(`Could not create deck: ${err.message}`, 'error')
    } finally {
      setBuildingTitle(null)
    }
  }

  if (!config.geminiKey) {
    return (
      <div className="screen safe-top">
        <BuilderHeader navigate={navigate} />
        <div className="buildergate">
          <div className="empty">
            <div className="empty__icon empty__icon--holo">
              <Icon name="sparkle" size={30} />
            </div>
            <span className="wordmark">
              Cardstock <span className="holotext">✦</span>
            </span>
            <h3>Bring your own Gemini key</h3>
            <p>
              The AI builder uses Google's Gemini with live search to study the current meta and design decks around
              your collection. Add a free API key from Google AI Studio to unlock it.
            </p>
            <a className="btn btn--primary" href="#/settings">
              Open settings
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="screen safe-top">
      <BuilderHeader navigate={navigate} />
      {phase === 'form' && (
        <div className="builderform">
          <span className="fieldlabel" id="builder-game">
            Game
          </span>
          <Seg
            ariaLabelledBy="builder-game"
            options={GAMES.map((g) => ({ value: g, label: GAME_LABEL[g] }))}
            value={game}
            onChange={pickGame}
          />
          {seeds.length > 0 && (
            <>
              <span className="fieldlabel" id="builder-seeds">
                Building around
              </span>
              <div className="seedrow" role="group" aria-labelledby="builder-seeds">
                {seeds.map((card) => (
                  <span key={card.id} className="seedchip">
                    <CardImg card={card} className="seedchip__img" />
                    <span className="seedchip__name">{card.name}</span>
                    <button className="seedchip__x" onClick={() => removeSeed(card.id)} aria-label={`Remove ${card.name}`}>
                      <Icon name="x" size={13} />
                    </button>
                  </span>
                ))}
              </div>
            </>
          )}
          <label className="fieldlabel" htmlFor="builder-format">
            Format
          </label>
          <input
            id="builder-format"
            className="input"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            placeholder={game === 'mtg' ? 'Standard, Modern, Commander…' : game === 'pokemon' ? 'Standard, Expanded' : 'Advanced'}
          />
          <label className="fieldlabel" htmlFor="builder-style">
            What do you want to play?
          </label>
          <input
            id="builder-style"
            className="input"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="aggro, control, a dragon theme, budget-friendly…"
          />
          <span className="fieldlabel" id="builder-budget">
            Budget for missing cards
          </span>
          <div className="budgetrow" role="group" aria-labelledby="builder-budget">
            {[25, 50, 100, 250, null].map((amount) => (
              <button key={String(amount)} className={`pill ${budget === amount ? 'pill--on' : ''}`} onClick={() => setBudget(amount)}>
                {amount == null ? 'No limit' : `$${amount}`}
              </button>
            ))}
          </div>
          <label className="checkrow">
            <input type="checkbox" checked={useCollection} onChange={(e) => setUseCollection(e.target.checked)} />
            <span>
              Build around my collection
              <em>
                {(owned ?? []).length
                  ? `${(owned ?? []).length} ${GAME_LABEL[game]} entries will be considered`
                  : `no ${GAME_LABEL[game]} cards collected yet — it'll design from scratch`}
              </em>
            </span>
          </label>
          {error && (
            <p className="formerror">
              <Icon name="alert" size={14} /> {error}
            </p>
          )}
          <button
            className="btn btn--holo btn--big"
            onClick={() => {
              research()
            }}
          >
            <Icon name="sparkle" size={18} /> Research the meta & build
          </button>
        </div>
      )}
      {phase === 'loading' && (
        <div className="builderloading">
          <div className="builderloading__orb" />
          <h3>Studying the {format || GAME_LABEL[game]} meta…</h3>
          <p>
            {seeds.length
              ? `Designing around ${seeds.map((card) => card.name).join(', ')} — checking archetypes, pricing the gaps.`
              : 'Searching current tournament results, matching archetypes to your cards, pricing the gaps.'}
          </p>
        </div>
      )}
      {phase === 'result' && result && (
        <div className="builderresult">
          <Markdownish text={result.markdown} />
          {result.decks.map((proposal) => {
            const ownedCards = proposal.lines.reduce((sum, line) => {
              const have = ownedCounts?.get(line.name.toLowerCase()) ?? 0
              return sum + Math.min(have, line.qty)
            }, 0)
            const totalCards = proposal.lines.reduce((sum, line) => sum + line.qty, 0)
            const toBuy = totalCards - ownedCards
            return (
              <div key={proposal.title} className="deckproposal">
                <div className="deckproposal__info">
                  <h4>{proposal.title}</h4>
                  <span>
                    {totalCards} cards · own {ownedCards}
                    {toBuy > 0 && <em> · {toBuy} to buy</em>}
                  </span>
                </div>
                <button
                  className="btn btn--primary btn--sm"
                  disabled={buildingTitle != null}
                  onClick={() => {
                    createFromProposal(proposal)
                  }}
                >
                  {buildingTitle === proposal.title ? 'Building…' : 'Create deck'}
                </button>
              </div>
            )
          })}
          <button className="btn btn--ghost" onClick={() => setPhase('form')}>
            <Icon name="refresh" size={15} /> Ask again
          </button>
        </div>
      )}
    </div>
  )
}

function BuilderHeader({ navigate }: { navigate: (hash: string) => void }) {
  return (
    <header className="deckhead">
      <button className="iconbtn" onClick={() => navigate('#/decks')} aria-label="Back">
        <Icon name="chevronLeft" size={20} />
      </button>
      <div className="deckhead__title">
        <h1>
          AI deck builder <span className="holotext">✦</span>
        </h1>
        <p>Live meta research · builds from your collection</p>
      </div>
    </header>
  )
}

/* Minimal markdown rendering for the builder's response. */

function Markdownish({ text }: { text: string }) {
  const blocks = useMemo(
    () =>
      text
        .replace(/```decklist[\s\S]*?```/g, '')
        .replace(/```[\s\S]*?```/g, '')
        .split(/\n{2,}/)
        .filter((block) => block.trim()),
    [text],
  )
  return (
    <div className="mdish">
      {blocks.map((block, i) => {
        const lines = block.split('\n').filter((line) => line.trim())
        if (!lines.length) return null
        if (lines[0].startsWith('## ')) {
          return (
            <div key={i}>
              <h3>{bolded(lines[0].slice(3))}</h3>
              {renderLines(lines.slice(1))}
            </div>
          )
        }
        return <div key={i}>{renderLines(lines)}</div>
      })}
    </div>
  )
}

const LIST_PREFIX = /^[-*•]\s/

type TextChunk = { kind: 'list'; items: string[] } | { kind: 'line'; text: string }

function chunkLines(lines: string[]): TextChunk[] {
  const chunks: TextChunk[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (LIST_PREFIX.test(line)) {
      const item = line.replace(LIST_PREFIX, '')
      const last = chunks[chunks.length - 1]
      if (last?.kind === 'list') last.items.push(item)
      else chunks.push({ kind: 'list', items: [item] })
    } else {
      chunks.push({ kind: 'line', text: line })
    }
  }
  return chunks
}

function renderLines(lines: string[]): ReactNode[] {
  return chunkLines(lines).map((chunk, i) =>
    chunk.kind === 'list' ? (
      <ul key={i}>
        {chunk.items.map((item, j) => (
          <li key={j}>{bolded(item)}</li>
        ))}
      </ul>
    ) : (
      renderLine(chunk.text, i)
    ),
  )
}

function renderLine(text: string, key: number): ReactNode {
  const trimmed = text.trim()
  if (/^#{1,3}\s/.test(trimmed)) return <h4 key={key}>{bolded(trimmed.replace(/^#{1,3}\s/, ''))}</h4>
  return <p key={key}>{bolded(trimmed)}</p>
}

function bolded(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part))
}
