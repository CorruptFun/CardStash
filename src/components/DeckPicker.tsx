import { useLiveQuery } from 'dexie-react-hooks'
import { Icon } from './Icon'
import { Modal } from './basics'
import { db } from '../lib/db'
import { GAME_SHORT } from '../lib/games'
import type { Deck, Game } from '../lib/types'

/**
 * "Which deck?" — lists the decks the user has built (newest first), marks
 * the ones that already hold the card, and offers the AI builder as a way to
 * start a brand-new deck around it.
 */
export function DeckPicker({
  open,
  onClose,
  title,
  game,
  membership,
  onPick,
  onBuildNew,
  buildLabel = 'Build a new deck with AI',
  emptyHint,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** Limit the list to one game's decks (single-card mode). */
  game?: Game
  /** deckId → copies already in that deck, to show membership. */
  membership?: Map<string, number>
  onPick: (deck: Deck) => void
  /** Offer "build a new deck around this" via the AI builder. */
  onBuildNew?: () => void
  buildLabel?: string
  emptyHint?: string
}) {
  const decks = useLiveQuery(async () => {
    const all = await db.decks.orderBy('updatedAt').reverse().toArray()
    return game ? all.filter((deck) => deck.game === game) : all
  }, [game])

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="deckpicker">
        {onBuildNew && (
          <button className="deckpicker__row deckpicker__row--ai" onClick={onBuildNew}>
            <span className="deckpicker__aiicon">
              <Icon name="sparkle" size={17} />
            </span>
            <span className="deckpicker__text">
              <span className="deckpicker__name holotext">{buildLabel}</span>
              <em>Researches the meta, designs around your cards</em>
            </span>
            <Icon name="chevronRight" size={16} className="deckpicker__go" />
          </button>
        )}
        {decks && decks.length === 0 && (
          <p className="deckpicker__empty">{emptyHint ?? 'No decks yet — create one on the Decks tab, or let the AI builder start one.'}</p>
        )}
        {(decks ?? []).map((deck) => {
          const inDeck = membership?.get(deck.id) ?? 0
          return (
            <button key={deck.id} className="deckpicker__row" onClick={() => onPick(deck)}>
              <span className="deckpicker__text">
                <span className="deckpicker__name">{deck.name}</span>
                <em>
                  {GAME_SHORT[deck.game]}
                  {deck.format ? ` · ${deck.format}` : ''}
                </em>
              </span>
              {inDeck > 0 ? (
                <span className="deckpicker__have">
                  <Icon name="check" size={12} /> ×{inDeck} in deck
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
    </Modal>
  )
}
