import type { Condition, Finish, Game, PriceSource } from './types'

export const GAMES: Game[] = ['mtg', 'pokemon', 'yugioh']

export const GAME_LABEL: Record<Game, string> = {
  mtg: 'Magic',
  pokemon: 'Pokémon',
  yugioh: 'Yu-Gi-Oh!',
}

export const GAME_SHORT: Record<Game, string> = {
  mtg: 'MTG',
  pokemon: 'PKM',
  yugioh: 'YGO',
}

export const FINISH_LABEL: Record<Finish, string> = {
  nonfoil: 'Normal',
  foil: 'Foil',
  etched: 'Etched',
  holo: 'Holo',
  reverse: 'Reverse holo',
  firstEd: '1st Edition',
}

export const SOURCE_LABEL: Record<PriceSource, string> = {
  tcgplayer: 'TCGplayer',
  cardmarket: 'Cardmarket',
  ebay: 'eBay',
  amazon: 'Amazon',
  coolstuffinc: 'CoolStuffInc',
  cardhoarder: 'Cardhoarder',
}

export const CONDITIONS: Condition[] = ['M', 'NM', 'LP', 'MP', 'HP', 'DMG']

/** Finishes a game's cards are commonly graded/priced in, for pickers. */
export const GAME_FINISHES: Record<Game, Finish[]> = {
  mtg: ['nonfoil', 'foil', 'etched'],
  pokemon: ['nonfoil', 'holo', 'reverse', 'firstEd'],
  yugioh: ['nonfoil', 'firstEd'],
}
