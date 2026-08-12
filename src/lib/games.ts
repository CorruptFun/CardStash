import type { Condition, Finish, Game, PriceSource } from './types'

export const GAMES: Game[] = [
  'mtg',
  'pokemon',
  'yugioh',
  'riftbound',
  'lorcana',
  'onepiece',
  'starwars',
  'digimon',
  'gundam',
]

export const GAME_LABEL: Record<Game, string> = {
  mtg: 'Magic',
  pokemon: 'Pokémon',
  yugioh: 'Yu-Gi-Oh!',
  riftbound: 'Riftbound',
  lorcana: 'Lorcana',
  onepiece: 'One Piece',
  starwars: 'Star Wars',
  digimon: 'Digimon',
  gundam: 'Gundam',
}

export const GAME_SHORT: Record<Game, string> = {
  mtg: 'MTG',
  pokemon: 'PKM',
  yugioh: 'YGO',
  riftbound: 'RIFT',
  lorcana: 'LOR',
  onepiece: 'OP',
  starwars: 'SWU',
  digimon: 'DIGI',
  gundam: 'GCG',
}

/** Full names for prompts and copy (vision hints, AI builder). */
export const GAME_FULL_NAME: Record<Game, string> = {
  mtg: 'Magic: The Gathering',
  pokemon: 'Pokémon TCG',
  yugioh: 'Yu-Gi-Oh!',
  riftbound: 'Riftbound (the League of Legends TCG)',
  lorcana: 'Disney Lorcana',
  onepiece: 'One Piece Card Game',
  starwars: 'Star Wars: Unlimited',
  digimon: 'Digimon Card Game',
  gundam: 'Gundam Card Game',
}

/**
 * Games whose APIs answer a cheap by-name query. The OCR sweep (no game hint)
 * only tries these — the TCGCSV-backed games would each pull a full catalog.
 */
export const LIGHT_MATCH_GAMES: Game[] = ['mtg', 'pokemon', 'yugioh', 'lorcana']

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
  riftbound: ['nonfoil', 'foil'],
  lorcana: ['nonfoil', 'foil'],
  onepiece: ['nonfoil', 'foil'],
  starwars: ['nonfoil', 'foil'],
  digimon: ['nonfoil', 'foil'],
  gundam: ['nonfoil', 'foil'],
}
