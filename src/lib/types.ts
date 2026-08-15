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
  | 'sports'

export type Finish = 'nonfoil' | 'foil' | 'etched' | 'holo' | 'reverse' | 'firstEd'

export type Condition = 'M' | 'NM' | 'LP' | 'MP' | 'HP' | 'DMG'

/**
 * Which sport a `sports` card belongs to. This is a field rather than nine
 * more `Game` literals on purpose: sports collectors organize by player, set
 * and year, not by sport, and every `Record<Game, …>` table in the app would
 * otherwise multiply. Splitting later is a data migration, not a redesign.
 */
export type Sport =
  | 'baseball'
  | 'basketball'
  | 'football'
  | 'hockey'
  | 'soccer'
  | 'racing'
  | 'wrestling'
  | 'multi'
  | 'other'

/** Grading companies whose slabs the scanner recognizes. */
export type GradeCompany = 'PSA' | 'BGS' | 'SGC' | 'CGC' | 'HGA' | 'TAG'

/**
 * A grade on one physical copy. This lives on the collection row, never on
 * `Card`: the slab and the raw copy are the same printing, so folding a grade
 * into the card id would fork the catalog and break every price lookup. What
 * differs is the item in the box, which is exactly what `CollectionItem` is.
 */
export interface GradeInfo {
  company: GradeCompany
  /** 1..10, in halves for BGS/CGC subgrades (9.5). */
  grade: number
  /** The label's own words — "GEM MT", "MINT", "AUTHENTIC". */
  label?: string
  /** Certification number, as printed. Resolves to the exact card via PSA. */
  cert?: string
  /** PSA qualifier suffix: OC, ST, MK, MC, PD, OF. */
  qualifier?: string
}

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

/**
 * Present on `sports` cards: the attributes a sports card is actually
 * identified by. Unlike every other game here, these do not come from a
 * catalog — no free sports card API exists — they are read off the card
 * itself and the card is synthesized from them. See docs/card-data.md.
 */
export interface SportsInfo {
  sport: Sport
  /** Print year from the copyright line, e.g. 1989. */
  year?: number
  /** Manufacturer: Topps, Panini, Upper Deck, Bowman, Fleer, Donruss… */
  brand?: string
  /** Product line within the brand: Chrome, Prizm, Stadium Club, Select. */
  product?: string
  player?: string
  team?: string
  /** Parallel/insert treatment: "Silver Prizm", "Refractor", "Gold". */
  parallel?: string
  /** Serial numbering off the card face: 23/99. */
  serial?: { num: number; of: number }
  rookie?: boolean
  auto?: boolean
  relic?: boolean
}

/** A card as normalized from any of the game APIs. */
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
  /** Present when this is a sports card, carrying what it was identified by. */
  sports?: SportsInfo
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
  /**
   * This copy is slabbed. Part of the row's identity — a PSA 10 never merges
   * into the raw row, because they are not the same thing to sell or trade.
   */
  grade?: GradeInfo
  /**
   * User-set market value per copy, USD. Sports cards have no free price API,
   * so a collector's own number off eBay comps is the honest valuation — and
   * it wins over `card.prices` in portfolio maths when set, for any game.
   */
  marketValue?: number
  /** Cost basis per copy, USD. */
  purchasePrice?: number
  /** Copies of this row offered for trade (0..qty); absent = none. */
  forTrade?: number
  note?: string
  addedAt: number
  /**
   * When this row last changed, stamped by a Dexie hook on every create and
   * update (db.ts v7). Optional only because rows written by builds before v7
   * predate it; the v7 upgrade backfills them from `addedAt`. This is the
   * left-hand side of any future three-way merge — see docs/roadmap.md round 3.
   */
  updatedAt?: number
  card: Card
}

/**
 * A row the user deliberately deleted. Exists because absence is ambiguous: a
 * device that deleted a card and a device that never owned it are otherwise
 * indistinguishable, so a union merge would resurrect everything thrown away.
 */
export interface Tombstone {
  /** The deleted CollectionItem's id. */
  id: string
  at: number
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
  /** Catalog-shape version; rows from older builds are refetched, not trusted. */
  v?: number
  /** When product lists were last fully fetched; refreshes inside this window are prices-only for mature sets. */
  productsAt?: number
  cards: Card[]
  /** Parallel to `cards`: the TCGplayer group (set) id each card came from. */
  cardGroups?: number[]
}

/** Small keyed cache row (TCGplayer group lists etc.); readers check `at` for TTL. */
export interface KvCacheRow {
  key: string
  at: number
  data: unknown
}

/* --- Social: friends & trades (no server — snapshots travel as links/files) --- */

/** What a profile share includes: just the trade binder, or the whole collection. */
export type ShareScope = 'trade' | 'all'

/** One shared binder row — a friend's copy, or one side of a trade. */
export interface SharedCard {
  /** `${game}:${apiId}` — same id space as Card, so live lookups still work. */
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
  /** Slab details, when this copy is graded. */
  grade?: GradeInfo
  /** Copies of this row offered for trade (≤ qty). */
  forTrade: number
  image?: string
  /** Market unit price for the finish at export time, USD — condition NOT applied. */
  price?: number
}

/** One card on a want list — card-level, not printing-level. */
export interface WantRow {
  /** `${game}|${normalized name}` — any printing of the card matches. */
  key: string
  cardId: string
  game: Game
  name: string
  setCode?: string
  image?: string
  price?: number
  addedAt: number
}

/** A want as it travels in a profile share (subset of WantRow). */
export interface SharedWant {
  cardId: string
  game: Game
  name: string
  image?: string
  price?: number
}

/** What changed between two imported snapshots of the same friend. */
export interface FriendDelta {
  added: number
  removed: number
  at: number
}

/** A followed collector: their last imported snapshot, kept locally. */
export interface Friend {
  /** Their stable profile id (generated once on their device). */
  id: string
  name: string
  note?: string
  scope: ShareScope
  addedAt: number
  /** When the snapshot was last imported here. */
  updatedAt: number
  /** The snapshot's own export stamp. */
  exportedAt: number
  /** Where the snapshot was fetched from — enables one-tap refresh. */
  sourceUrl?: string
  /**
   * The hosted binder revision this snapshot came from, when it came from
   * hosted social. Lets the poller ask "did anything move?" in a few bytes
   * per friend instead of downloading every binder to find out. Absent for
   * friends imported from a link or a file.
   */
  remoteRev?: number
  cards: SharedCard[]
  /** Cards they're hunting (travels with their share). */
  wants?: SharedWant[]
  /** Row-level diff produced by the latest refresh. */
  lastDelta?: FriendDelta
}

export type TradeStatus = 'proposed' | 'accepted' | 'declined' | 'completed' | 'canceled'

export interface TradeRecord {
  id: string
  /** Other party's profile id ('' when unknown — they may not be a saved friend). */
  friendId: string
  friendName: string
  /** 'out' = I proposed it, 'in' = it was proposed to me. */
  direction: 'out' | 'in'
  status: TradeStatus
  createdAt: number
  updatedAt: number
  note?: string
  /** My side: copies I hand over. */
  give: SharedCard[]
  /** Their side: copies I receive. */
  get: SharedCard[]
  /** Set once the swap has been booked into the collection. */
  appliedAt?: number
}

/* Decoded + sanitized share payloads. On the wire they carry an
 * `app: 'cardstock-social'` marker and travel deflate+base64url-encoded in
 * links, or as plain JSON in exported files. */

export interface ProfilePayload {
  kind: 'profile'
  id: string
  name: string
  note?: string
  scope: ShareScope
  at: number
  cards: SharedCard[]
  wants?: SharedWant[]
}

export interface TradePayload {
  kind: 'trade'
  id: string
  at: number
  from: { id: string; name: string }
  to?: { id?: string; name?: string }
  note?: string
  /** Cards the sender offers. */
  offer: SharedCard[]
  /** Cards the sender wants back. */
  want: SharedCard[]
}

export interface ReplyPayload {
  kind: 'reply'
  id: string
  at: number
  from: { id: string; name: string }
  status: 'accepted' | 'declined'
  note?: string
}

export type SocialPayload = ProfilePayload | TradePayload | ReplyPayload
