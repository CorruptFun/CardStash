import { settings } from './settings'
import { groupContents, sealedKind, tcgplayerGroups, type TcgGroup } from './tcgcsv'
import type { Card, Game } from './types'
import { normalizeName, similarity, tcgplayerSearchLink } from './util'

/**
 * Sealed-product identification: a pack/box front carries the SET name in
 * huge type, so on-device OCR text is matched against the TCGplayer group
 * (set) index, then the set's sealed products are ranked by which product
 * words (booster/box/bundle/…) also appear on the packaging.
 */

/**
 * What product KIND the packaging text points at. Wording quirk that matters:
 * a booster BOX front says "36 Play Booster Packs" — plural "packs" is
 * box-front language, a single pack just says "Booster".
 */
function expectedKind(text: string): string | null {
  if (/elite trainer/.test(text)) return 'Elite Trainer Box'
  if (/booster box|display\b/.test(text)) return 'Booster box'
  if (/\bpacks\b/.test(text)) return 'Booster box'
  if (/bundle|fat pack/.test(text)) return 'Bundle'
  if (/\bcase\b/.test(text)) return 'Case'
  if (/\btin\b/.test(text)) return 'Tin'
  if (/(starter|structure|commander) deck/.test(text)) return 'Deck'
  if (/\bbooster\b|\bpack\b|\bblister\b/.test(text)) return 'Booster pack'
  return null
}

/** Booster-line names that tell sibling products apart (Play vs Collector…). */
const BOOSTER_FLAVORS = ['collector', 'draft', 'jumpstart', 'set booster', 'play'] as const

/** TCGplayer prefixes group names with codes ("SV08: Surging Sparks") — the box doesn't. */
function cleanGroupName(name: string): string {
  return name.replace(/^[A-Z0-9]{1,6}\s*[:—-]\s+/, '')
}

export interface SealedMatch {
  card: Card
  group: TcgGroup
  game: Game
  /** How confidently the set was recognized (0..1). */
  score: number
}

const SET_MATCH_THRESHOLD = 0.72

/**
 * Fire-and-forget: preload the group (set) indexes pack scans match against,
 * so the first sealed frame spends its time on OCR instead of the network.
 */
export function warmSealedIndex(games?: Game[]): void {
  for (const game of games?.length ? games : settings().enabledGames) tcgplayerGroups(game).catch(() => {})
}

/**
 * Match OCR'd packaging text to a set, then to one of its sealed products.
 * Games with no group data (offline, new category) simply don't compete.
 */
export async function identifySealedText(lines: string[], games?: Game[], signal?: AbortSignal): Promise<SealedMatch | null> {
  const pool = games?.length ? games : settings().enabledGames
  const text = normalizeName(lines.join(' '))
  if (text.length < 4) return null

  const perGame = await Promise.allSettled(pool.map(async (game) => ({ game, groups: await tcgplayerGroups(game, signal) })))
  let bestSet: { game: Game; group: TcgGroup; score: number } | null = null
  for (const settled of perGame) {
    if (settled.status !== 'fulfilled') continue
    const { game, groups } = settled.value
    for (const group of groups) {
      const clean = normalizeName(cleanGroupName(group.name))
      if (clean.length < 4) continue
      let score = 0
      if (text.includes(clean)) {
        // Containment + a length bonus so "Prismatic Evolutions" beats the
        // "Evolutions" it contains.
        score = 0.86 + Math.min(0.12, clean.length / 150)
      } else {
        for (const line of lines) {
          const lineScore = similarity(line, cleanGroupName(group.name))
          if (lineScore > score) score = lineScore
        }
      }
      if (score > (bestSet?.score ?? 0)) bestSet = { game, group, score }
    }
  }
  if (!bestSet || bestSet.score < SET_MATCH_THRESHOLD) return null

  const contents = await groupContents(bestSet.game, bestSet.group, signal)
  if (!contents.sealed.length) return null
  const wanted = expectedKind(text)
  let bestProduct: { card: Card; score: number } | null = null
  for (const product of contents.sealed) {
    const productName = normalizeName(product.name)
    let score = similarity(text, product.name) * 0.3
    // The product kind read off the packaging dominates the ranking.
    if (wanted) score += product.sealed?.kind === wanted ? 0.6 : -0.2
    for (const flavor of BOOSTER_FLAVORS) {
      const inText = text.includes(flavor)
      const inName = productName.includes(flavor)
      if (inText && inName) score += 0.15
      // A Collector/Jumpstart product the packaging doesn't mention is wrong.
      else if (inName && !inText && (flavor === 'collector' || flavor === 'jumpstart')) score -= 0.1
    }
    if (!bestProduct || score > bestProduct.score) bestProduct = { card: product, score }
  }
  // Nothing on the packaging told products apart — a lone booster pack is
  // the thing most often scanned, so prefer that over an arbitrary product.
  let card = bestProduct!.card
  if (!wanted && bestProduct!.score < 0.2) {
    card = contents.sealed.find((product) => product.sealed?.kind === 'Booster pack') ?? card
  }
  return { card, group: contents.group, game: bestSet.game, score: Math.min(1, bestSet.score) }
}

/** Every card that could be inside, priciest first, plus the set's group. */
export async function sealedSetContents(card: Card, signal?: AbortSignal): Promise<{ cards: Card[]; group: TcgGroup } | null> {
  if (!card.sealed) return null
  const group: TcgGroup = {
    groupId: card.sealed.groupId,
    name: card.setName ?? '',
    abbreviation: card.setCode,
    publishedOn: card.releasedAt,
  }
  const contents = await groupContents(card.game, group, signal)
  const cards = [...contents.singles].sort(
    (a, b) => (b.prices.best ?? b.prices.bestFoil ?? 0) - (a.prices.best ?? a.prices.bestFoil ?? 0),
  )
  return { cards, group: contents.group }
}

/** The set's other sealed products (box ↔ pack ↔ bundle), priciest first. */
export async function sealedVariants(card: Card, signal?: AbortSignal): Promise<Card[]> {
  if (!card.sealed) return [card]
  const group: TcgGroup = {
    groupId: card.sealed.groupId,
    name: card.setName ?? '',
    abbreviation: card.setCode,
    publishedOn: card.releasedAt,
  }
  const contents = await groupContents(card.game, group, signal)
  return [...contents.sealed].sort(
    (a, b) => (b.prices.best ?? b.prices.bestFoil ?? 0) - (a.prices.best ?? a.prices.bestFoil ?? 0),
  )
}

/** External page listing every card in the product's set. */
export function setListLink(card: Card): string {
  if (card.game === 'mtg' && card.setCode) return `https://scryfall.com/sets/${card.setCode.toLowerCase()}`
  return tcgplayerSearchLink(card.setName ?? card.name)
}

export { sealedKind }
