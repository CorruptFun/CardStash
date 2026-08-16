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
  /**
   * A `CardPatch` has been laid over this card — a user-supplied image, edited
   * fields, or both (see `cardpatch.ts`). Display-only: never stored on the
   * card, never sent anywhere, and recomputed on every merge, so a stale
   * `true` on a card read back from Dexie means nothing and costs nothing.
   */
  patched?: boolean
  prices: Prices
  links: CardLinks
}

/**
 * The subset of `Card` a user (or the shared index) may fill in or correct.
 * Kept separate from `Card` so the sanitizer in `cardpatch.ts` has exactly one
 * list to enforce — anything not named here cannot be patched.
 */
export interface CardFields {
  name?: string
  setName?: string
  setCode?: string
  number?: string
  rarity?: string
  /** YYYY-MM-DD. A bare year the user typed is widened to Jan 1. */
  releasedAt?: string
  typeLine?: string
  subtext?: string
}

/**
 * One card's local override: the picture the catalogs did not have, and the
 * details the user filled in themselves.
 *
 * An overlay, not a replacement — see `cardpatch.ts`. Rows keyed by the card
 * id they patch, which for a card no catalog lists is a `custom-…` id minted
 * from the printed facts.
 */
export interface CardPatch {
  /** `${game}:${apiId}` — the card this patches. Primary key. */
  cardId: string
  game: Game
  /** The user's photo as a `data:image/*;base64` URL, downscaled on the way in. */
  image?: string
  /** Fingerprint of `image`, for dedupe against the shared index. */
  imageHash?: string
  /** Only the keys the user actually changed. */
  fields: CardFields
  /**
   * What the card said before this patch, for exactly the keys in `fields`.
   *
   * Undo needs it. A stored `Card` is denormalized into collection and deck
   * rows, so once a patch is written over one the catalog's values are gone
   * from that copy — and "re-fetch it" is not an answer offline, nor for a
   * card no catalog lists. Keys absent here were absent on the card too.
   */
  base?: CardFields
  /** The catalog image the patch's photo covered, restored on undo. */
  baseImage?: string
  baseImageLarge?: string
  /** This card exists nowhere but here — the patch IS the card. */
  custom?: boolean
  /** Authored on this device, or pulled from the shared card index. */
  origin: 'local' | 'community'
  /** The user chose to contribute this to the shared index. */
  shared?: boolean
  /** When the shared index last accepted it. */
  sharedAt?: number
  updatedAt: number
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

/**
 * Who may read a custom binder.
 *
 * The same two audiences the whole-collection binder already has (decision 16),
 * plus the one it does not: `private`, which is never uploaded at all.
 *
 * `public` means **any signed-in collector**, never an anonymous caller — the
 * same line `binders` draws. An inventory of valuable cards that a stranger
 * with the publishable key could enumerate is the thing `trade_offers` exists
 * to refuse; see decision 26.
 */
export type BinderVisibility = 'private' | 'friends' | 'public'

/**
 * A binder the user built by hand: a named selection of copies they own.
 *
 * Where the whole-collection binder answers "everything I have" or "everything
 * I'll swap", these answer "my vintage Charizards" or "the box I'm selling at
 * the weekend" — and each carries its OWN audience, so one can be public while
 * the collection behind it stays private.
 */
export interface CustomBinder {
  id: string
  name: string
  note?: string
  /** Card id whose art fronts the binder in lists. */
  coverCardId?: string
  visibility: BinderVisibility
  /**
   * The copies in here are offered for trade: a `public` binder that is also
   * tradeable enters the global want index, so collectors hunting these cards
   * find them. Separate from visibility because "look at my collection" and
   * "these are available" are different sentences.
   */
  tradeable: boolean
  createdAt: number
  updatedAt: number
}

/**
 * One copy in a custom binder.
 *
 * It points at a **collection row**, not at a card, and that is the load-bearing
 * choice: finish, condition, grade and price all live on the row, and a binder
 * that copied them would be a fourth denormalized `Card` to keep in step with a
 * card patch (see `savePatch` in db.ts). Pointing at the row means a binder
 * shows the copy the user actually owns, and a fixed picture fixes it here too.
 * A row whose item has been deleted is dropped rather than shown hollow.
 */
export interface BinderCard {
  id: string
  binderId: string
  /** The `CollectionItem.id` this is a copy of. */
  itemId: string
  /** Denormalized off the item so a binder can be listed without joining. */
  cardId: string
  qty: number
  /**
   * Which page of the physical binder this copy sits on, 1-based.
   *
   * Set when the copy arrived from a binder page scan, and absent when it was
   * added by hand — a binder is a selection first and a physical object
   * second, so a page number is extra knowledge rather than a requirement. It
   * lives on the binder row rather than on the collection row because the same
   * copy can be in two binders, and "page 3" is only true of one of them.
   */
  page?: number
  addedAt: number
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
  /**
   * What the scanner read off the physical copy, kept so the batch-add screen
   * (and the tray's card sheet) file the copy that was actually in frame
   * rather than the printing's default. Absent on rows the tray already held
   * when batch add landed, and on a scan whose finish the detector had no
   * opinion about.
   */
  finish?: Finish
  grade?: GradeInfo
  /**
   * Did the printed collector line CHOOSE this printing, or is the edition on
   * show the source's default? Mirrors `IdentificationMeta.pinned`, and rides
   * the tray row because the card sheet opened from a tile has no other way
   * back to it — without this the tray showed a guessed edition looking
   * exactly as settled as a read one.
   *
   * Three-valued on purpose: `undefined` is "unknown", not "unconfirmed".
   * Rows the tray already held before this shipped carry no reading, and
   * marking them unconfirmed would put a warning on cards that may well have
   * been pinned. Only an explicit `false` earns the chip.
   */
  pinned?: boolean
  /**
   * This scan has been filed into the collection — by Collect mode or by the
   * batch-add screen. The tray is a log, not a collection, so a filed row
   * stays visible; the flag is only what stops the batch screen offering the
   * same copy a second time by default.
   */
  added?: boolean
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
/**
 * A place a collector can be reached, shown as an icon beside their binder.
 *
 * A closed vocabulary rather than free text: the rendered link's destination is
 * built from the platform, so the icon and the href can never disagree. The
 * table, the sanitizer and the URL builder all live in `lib/profilelinks.ts`.
 */
export type SocialPlatform =
  | 'instagram'
  | 'x'
  | 'bluesky'
  | 'youtube'
  | 'tiktok'
  | 'twitch'
  | 'discord'
  | 'reddit'
  | 'facebook'
  | 'telegram'
  | 'whatnot'
  | 'ebay'
  | 'website'

export interface SocialLink {
  platform: SocialPlatform
  /** The handle without its `@` — or, for `website`, the whole https URL. */
  value: string
}

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
  /** The social accounts they chose to show beside their binder. */
  links?: SocialLink[]
  /**
   * Their published custom binders. Kept on this row rather than in a table of
   * their own so a friend is still ONE record — one sanitizer, one backup
   * entry, one thing to delete when they are removed.
   */
  binders?: SharedBinder[]
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

/**
 * A custom binder on the wire, and as a friend's app stores it.
 *
 * Deliberately NOT a `ProfilePayload` with a name on it: importing one must
 * never touch the sender's main binder snapshot, and a shape that could be
 * mistaken for a whole profile is a shape that eventually is.
 */
export interface SharedBinder {
  /** The binder's own id, stable across devices and re-shares. */
  id: string
  name: string
  note?: string
  tradeable: boolean
  /** The sender's own export stamp — the freshness test, as on a profile. */
  at: number
  cards: SharedCard[]
}

export interface ProfilePayload {
  kind: 'profile'
  id: string
  name: string
  note?: string
  scope: ShareScope
  at: number
  cards: SharedCard[]
  wants?: SharedWant[]
  /**
   * Where else this collector can be reached — Instagram, Discord, a store
   * page. It rides the binder rather than the directory profile ON PURPOSE
   * (see `lib/profilelinks.ts`): contact details inherit the binder's
   * scope-driven audience, where `profiles` is readable by every signed-in
   * user. Nothing here is ever required, and a serverless share carries it
   * exactly the same way a hosted one does.
   */
  links?: SocialLink[]
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

/**
 * One custom binder, handed over on its own.
 *
 * The fourth payload kind. It carries `from` like a trade does, because a
 * binder share has to say whose it is without claiming to be their profile —
 * `upsertFriendBinder` files it under that collector, creating a stub for
 * them if they are not followed yet, and never overwrites their card list.
 */
export interface BinderPayload {
  kind: 'binder'
  /** The binder id. */
  id: string
  at: number
  from: { id: string; name: string }
  name: string
  note?: string
  tradeable: boolean
  cards: SharedCard[]
}

export type SocialPayload = ProfilePayload | TradePayload | ReplyPayload | BinderPayload
