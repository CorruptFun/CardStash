/**
 * Sports cards: identity without a catalog.
 *
 * Every other adapter in this folder is a client for a service that already
 * knows what cards exist — Scryfall, the Pokémon API, TCGplayer's catalog.
 * There is no free equivalent for sports, so this module does the job the
 * other way round: `sportsparse.ts` reads the identity off the card, and a
 * `Card` is SYNTHESIZED from what it read. The physical card is the catalog.
 *
 * Two consequences run through everything here:
 *
 * 1. **The id is the contract.** With no server to agree with, the only thing
 *    making two devices call the same card the same card is that they compute
 *    the same slug from the same printed facts. `sportsSlug` is therefore
 *    deliberately narrow (see its comment) and must not casually change —
 *    changing it renames every sports card anyone owns.
 *
 * 2. **There is no price feed.** Sports pricing is a paid business and the
 *    free path must keep working, so a sports card carries no prices at all.
 *    Value comes from the collector: `CollectionItem.marketValue`, informed
 *    by the eBay sold-comps link this module builds. Anything else would be
 *    inventing numbers about someone's money.
 *
 *    `ebaycomps.ts` now puts a NUMBER beside that link — the spread of active
 *    eBay listings, fetched only when the collector taps for it and applied
 *    only when they accept it (decision 17a). Note what did not change: a
 *    `Card` built here still carries no prices, because an asking price is
 *    not a market price and must never enter portfolio maths on its own.
 *
 * "Search" is local recall rather than a lookup: the cards this user has
 * already identified, which live on their collection rows and scan history.
 * That is genuinely all the catalog that exists for them, and it needs no
 * network, which keeps sports on the offline-first path with everything else.
 */

import { db } from './db'
import { parseSportsText, sportsSetName, sportsSlug } from './sportsparse'
import type { ParsedSportsCard } from './sportsparse'
import type { Card, Sport, SportsInfo } from './types'
import { normalizeName, similarity } from './util'

export const SPORT_LABEL: Record<Sport, string> = {
  baseball: 'Baseball',
  basketball: 'Basketball',
  football: 'Football',
  hockey: 'Hockey',
  soccer: 'Soccer',
  racing: 'Racing',
  wrestling: 'Wrestling',
  multi: 'Multi-sport',
  other: 'Other',
}

export const SPORTS: Sport[] = [
  'baseball',
  'basketball',
  'football',
  'hockey',
  'soccer',
  'racing',
  'wrestling',
  'multi',
  'other',
]

/**
 * How much of an identity has to be read before a scan is allowed to become a
 * card. Below this the parse has essentially only seen a year and a brand,
 * which describes a whole set equally well — and a card invented out of that
 * is worse than an honest miss, because the user cannot tell it is wrong.
 */
export const MIN_SPORTS_CONFIDENCE = 0.5

/** `${game}:${apiId}` for a parsed sports card. */
export function sportsCardId(parsed: ParsedSportsCard): string {
  return `sports:${sportsSlug(parsed)}`
}

/**
 * Build the normalized `Card` for a parsed sports read.
 *
 * The display name is the player, because that is what a collector searches
 * for. When the player could not be read the card still gets a name — the set
 * and number it definitely is — rather than an empty string, so it stays
 * findable and editable instead of becoming an anonymous row.
 */
export function sportsCard(parsed: ParsedSportsCard): Card {
  const setName = sportsSetName(parsed)
  const info: SportsInfo = {
    sport: parsed.sport,
    year: parsed.year,
    brand: parsed.brand,
    product: parsed.product,
    player: parsed.player,
    team: parsed.team,
    parallel: parsed.parallel,
    serial: parsed.serial,
    rookie: parsed.rookie,
    auto: parsed.auto,
    relic: parsed.relic,
  }
  const fallback = [setName, parsed.number ? `#${parsed.number}` : ''].filter(Boolean).join(' ')
  const name = parsed.player ?? (fallback || 'Unidentified sports card')
  const apiId = sportsSlug(parsed)

  const card: Card = {
    id: `sports:${apiId}`,
    game: 'sports',
    apiId,
    name,
    setName: setName || undefined,
    number: parsed.number,
    rarity: parsed.parallel,
    releasedAt: parsed.year != null ? `${parsed.year}-01-01` : undefined,
    typeLine: [parsed.team, SPORT_LABEL[parsed.sport]].filter(Boolean).join(' · ') || undefined,
    subtext: describeCard(info),
    supertype: SPORT_LABEL[parsed.sport],
    sports: info,
    // No sports price feed exists on the free path — see the module comment.
    prices: { best: null, bestFoil: null, entries: [], updatedAt: Date.now() },
    links: {},
  }
  card.links = { ebaySold: sportsCompLink(card) }
  return card
}

/** The one-line "what is this" a sports card needs in place of rules text. */
function describeCard(info: SportsInfo): string | undefined {
  const bits: string[] = []
  if (info.rookie) bits.push('Rookie card')
  if (info.auto) bits.push('Autograph')
  if (info.relic) bits.push('Relic / game-used')
  if (info.serial) bits.push(`Serial numbered ${info.serial.num}/${info.serial.of}`)
  if (info.parallel) bits.push(`${info.parallel} parallel`)
  return bits.length ? bits.join(' · ') : undefined
}

/**
 * The eBay sold-listings query for a sports card.
 *
 * This is the app's actual pricing answer for sports, so the query is built
 * the way a collector would type it: the facts that narrow to one card, and
 * nothing that would drag in the rest of the set. The grade goes in when
 * there is one, because a PSA 10 and a raw copy are different markets.
 */
export function sportsCompLink(card: Card, grade?: { company: string; grade: number }): string {
  const query = sportsCompTerms(card, grade)
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_Sold=1&LH_Complete=1&_sop=13`
}

/**
 * The search terms themselves, shared by the link above and the live comp
 * lookup in `ebaycomps.ts`.
 *
 * One function on purpose: the number the app shows and the eBay page it sends
 * the user to check it against must be answers to the same question. Two term
 * lists would drift, and the failure would look like the app lying — a median
 * on screen that the linked search does not contain.
 */
export function sportsCompTerms(card: Card, grade?: { company: string; grade: number }): string {
  const info = card.sports
  const terms = [
    info?.year != null ? String(info.year) : '',
    info?.brand ?? '',
    info?.product ?? '',
    info?.player ?? card.name,
    card.number ? `#${card.number}` : '',
    info?.parallel ?? '',
    info?.serial ? `/${info.serial.of}` : '',
    grade ? `${grade.company} ${grade.grade}` : '',
  ]
  return terms.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

/* --- local recall --------------------------------------------------------
 * The user's own history is the only sports catalog there is. Reading it back
 * out of the collection and scan tables means no extra table to migrate, back
 * up and sanitize — the cards are already stored there in full.
 */

const RECALL_TTL_MS = 30_000
let recall: { at: number; cards: Card[] } | null = null

/** Every sports card this device has seen, newest first, briefly memoized. */
async function knownCards(): Promise<Card[]> {
  if (recall && Date.now() - recall.at < RECALL_TTL_MS) return recall.cards
  const byId = new Map<string, Card>()
  const rows = await db.collection.where('game').equals('sports').toArray()
  for (const row of rows) if (row.card) byId.set(row.card.id, row.card)
  const scans = await db.scans.orderBy('at').reverse().limit(500).toArray()
  for (const scan of scans) {
    if (scan.card?.game === 'sports' && !byId.has(scan.card.id)) byId.set(scan.card.id, scan.card)
  }
  const cards = [...byId.values()]
  recall = { at: Date.now(), cards }
  return cards
}

/** Drop the memo — called after a scan adds a card the next search should see. */
export function clearSportsRecall(): void {
  recall = null
}

/** Everything a query could reasonably be matched against, lowercased once. */
function haystack(card: Card): string {
  const info = card.sports
  return [card.name, card.setName, card.number, info?.team, info?.parallel, info?.brand, info?.product]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

const SEARCH_LIMIT = 30

/**
 * Search the cards this device already knows. A substring hit anywhere in the
 * card's text is a match — collectors search by fragments ("griffey", "prizm
 * 136") far more than by full names — with fuzzy name similarity as the
 * ranking signal and a floor so a typo still finds the card.
 */
export async function searchSports(query: string, _signal?: AbortSignal): Promise<Card[]> {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const cards = await knownCards()
  const scored: { card: Card; score: number }[] = []
  for (const card of cards) {
    const hay = haystack(card)
    const contains = hay.includes(q)
    const score = Math.max(contains ? 0.8 : 0, similarity(q, card.name))
    if (contains || score >= 0.6) scored.push({ card, score })
  }
  scored.sort((a, b) => b.score - a.score || (b.card.sports?.year ?? 0) - (a.card.sports?.year ?? 0))
  return scored.slice(0, SEARCH_LIMIT).map((entry) => entry.card)
}

/**
 * Resolve a name (plus optional set/number) to a known sports card. Used by
 * CSV import, where the row came from an export this app wrote, so an exact
 * id or a close name plus a matching number is the realistic case.
 */
export async function matchSports(name: string, setCode?: string | null, number?: string | null): Promise<Card | null> {
  const cards = await knownCards()
  if (!cards.length) return null
  const wanted = normalizeName(name)
  let best: { card: Card; score: number } | null = null
  for (const card of cards) {
    if (number && card.number && card.number.toUpperCase() !== number.toUpperCase()) continue
    let score = similarity(wanted, card.name)
    if (setCode && card.setName?.toLowerCase().includes(setCode.toLowerCase())) score += 0.15
    if (number && card.number?.toUpperCase() === number.toUpperCase()) score += 0.2
    if (!best || score > best.score) best = { card, score }
  }
  return best && best.score >= 0.7 ? best.card : null
}

/**
 * Look a sports card up by its id. Only local recall can answer: the slug is
 * lossy on purpose (brands and products slug to hyphenated words, so it does
 * not split back apart unambiguously) and there is no service to ask. A miss
 * is a real "not known here", which is the truthful answer.
 */
export async function sportsById(apiId: string): Promise<Card | null> {
  const cards = await knownCards()
  return cards.find((card) => card.apiId === apiId) ?? null
}

/** Other cards of the same player this device knows — the sports "printings". */
export async function sportsPrintings(name: string, _signal?: AbortSignal): Promise<Card[]> {
  const cards = await knownCards()
  const wanted = normalizeName(name)
  return cards
    .filter((card) => normalizeName(card.name) === wanted)
    .sort((a, b) => (b.sports?.year ?? 0) - (a.sports?.year ?? 0))
}

/** Parse OCR lines and synthesize a card, or null if too little was read. */
export function sportsCardFromText(lines: string[]): { card: Card; parsed: ParsedSportsCard } | null {
  const parsed = parseSportsText(lines)
  if (parsed.confidence < MIN_SPORTS_CONFIDENCE) return null
  return { card: sportsCard(parsed), parsed }
}
