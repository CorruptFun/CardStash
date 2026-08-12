export type Game =
  | 'mtg'
  | 'pokemon'
  | 'yugioh'
  | 'riftbound'
  | 'lorcana'
  | 'onepiece'
  | 'starwars'
  | 'digimon'
  | 'gundam'

export type Finish = 'nonfoil' | 'foil' | 'etched' | 'holo' | 'reverse' | 'firstEd'

export type Condition = 'M' | 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'

export type PriceSource =
  | 'tcgplayer'
  | 'cardmarket'
  | 'ebay'
  | 'amazon'
  | 'coolstuffinc'
  | 'cardhoarder'

export type PriceKind = 'market' | 'low' | 'mid' | 'high' | 'trend' | 'avg30'

/**
 * The app prices in USD only. 'EUR' survives in the type because cards and
 * history stored by pre-0.5 versions carry Cardmarket entries — readers in
 * prices.ts/portfolio.ts filter them out rather than mislabel them as $.
 */
export type Currency = 'USD' | 'EUR'

export interface PriceEntry {
  source: PriceSource
  kind: PriceKind
  finish: Finish
  currency: Currency
  value: number
}

export interface Prices {
  /** Non-foil USD headline price. */
  best: number | null
  /** Best premium-finish USD price (foil/holo/etched/…). */
  bestFoil: number | null
  entries: PriceEntry[]
  updatedAt: number
}

export interface Printing {
  setName?: string
  setCode?: string
  rarity?: string
  price?: number
}

export interface CardLinks {
  market?: string
  tcgplayer?: string
  /** No longer emitted (EU marketplace) — present on stored pre-0.5 cards. */
  cardmarket?: string
  ebaySold?: string
  source?: string
}

/** Marks a Card as a sealed product; carries what a price refresh needs. */
export interface SealedInfo {
  /** TCGplayer category id (the game). */
  categoryId: number
  /** TCGplayer group id (the set the product belongs to). */
  groupId: number
  /** Product kind guess from the name: booster box, pack, bundle, … */
  kind?: string
}

/** A card as normalized from any of the three game APIs. */
export interface Card {
  /** `${game}:${apiId}` — stable across sessions. */
  id: string
  game: Game
  apiId: string
  name: string
  setCode?: string
  setName?: string
  number?: string
  rarity?: string
  /** Set/printing release date, YYYY-MM-DD (when the API provides one). */
  releasedAt?: string
  /** Finishes this exact printing exists in (when the API says); pickers fall back to the game's list. */
  finishes?: Finish[]
  imageSmall?: string
  imageLarge?: string
  typeLine?: string
  /** Oracle/effect/flavor text. */
  subtext?: string
  manaCost?: string
  cmc?: number
  colors?: string[]
  supertype?: string
  printings?: Printing[]
  /** Present when this is a sealed product (booster pack/box/bundle), not a single. */
  sealed?: SealedInfo
  prices: Prices
  links: CardLinks
}

/** One row of the collection: copies of one printing of a card in a given finish+condition. */
export interface CollectionItem {
  id: string
  cardId: string
  game: Game
  name: string
  setCode?: string
  setName?: string
  number?: string
  rarity?: string
  finish: Finish
  condition: Condition
  qty: number
  /**
   * Sealed products only: false while still sealed, true once cracked.
   * Opened rows stop counting at the sealed market price — the pulls get
   * scanned in as singles instead.
   */
  opened?: boolean
  /** Cost basis per copy, USD. */
  purchasePrice?: number
  note?: string
  addedAt: number
  card: Card
}

export type DeckBoard = 'main' | 'side' | 'extra'

export interface Deck {
  id: string
  game: Game
  name: string
  format?: string
  coverCardId?: string
  createdAt: number
  updatedAt: number
}

export interface DeckCard {
  id: string
  deckId: string
  cardId: string
  qty: number
  board: DeckBoard
  card: Card
}

export interface PricePoint {
  cardId: string
  /** YYYY-MM-DD */
  date: string
  best: number | null
  foil: number | null
  currency?: Currency
}

export interface ScanRecord {
  id: string
  cardId: string
  at: number
  card: Card
}

/** Cached TCGplayer catalog (via TCGCSV) for games with no search API. */
export interface CatalogCache {
  game: Game
  /** When the catalog was fetched — stale after ~a day (prices are daily). */
  at: number
  cards: Card[]
}

/** Small keyed cache row (TCGplayer group lists etc.); readers check `at` for TTL. */
export interface KvCacheRow {
  key: string
  at: number
  data: unknown
}
