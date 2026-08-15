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
  'sports',
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
  sports: 'Sports',
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
  sports: 'SPT',
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
  sports: 'sports trading cards',
}

/**
 * Games whose APIs answer a cheap by-name query. The OCR sweep (no game hint)
 * only tries the enabled subset of these — the TCGCSV-backed games would each
 * pull a full catalog, so they only join the sweep when the user has turned
 * every light game off (see identifyViaOcr).
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

/**
 * Whether this finish is a reflective treatment — the ones that actually
 * catch the light, and so the ones the UI gives a holographic glare to.
 *
 * `firstEd` is deliberately excluded: it is an edition stamp, not a surface.
 * A 1st Edition Yu-Gi-Oh common is as matte as any other common, and making
 * it shimmer would be the app asserting something about the card that isn't
 * true.
 */
const FOIL_FINISHES = new Set<Finish>(['foil', 'etched', 'holo', 'reverse'])

export function isFoilFinish(finish: Finish | undefined): boolean {
  return finish != null && FOIL_FINISHES.has(finish)
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

/**
 * Finishes offered for one specific printing: the printing's own finish list
 * when its API declares one, otherwise the game-wide list. Never empty.
 */
export function finishOptions(card: { game: Game; finishes?: Finish[] }): Finish[] {
  const base = GAME_FINISHES[card.game]
  if (!card.finishes?.length) return base
  const available = base.filter((finish) => card.finishes!.includes(finish))
  return available.length ? available : base
}

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
  // Sports parallels (Refractor, Prizm, Gold) are separate printings, not
  // finishes — they live in `rarity`/`sports.parallel`. What is left is
  // whether this particular card stock shines.
  sports: ['nonfoil', 'foil'],
}
