/**
 * The pure half of the catalog mirror (see catalog.ts for the transport and
 * the rules): shaping a server row into an app `Card`, and choosing between
 * printings by artwork fingerprint. Kept free of settings/db/network imports
 * so node unit tests exercise every decision in this file directly.
 */

import { mergePrices } from './prices'
import type { Card, Game } from './types'
import { ebaySoldLink, normalizeName, tcgplayerSearchLink } from './util'
import { ART_HASH_BITS, artHashDistance } from './vision'

/**
 * The games the mirror carries — the three with healthy bulk sources
 * (Scryfall, TCGdex, YGOPRODeck). The TCGCSV games already have a day-cached
 * catalog of their own, and sports has no catalog anywhere (decision 17).
 */
export const CATALOG_GAMES = ['mtg', 'pokemon', 'yugioh'] as const satisfies readonly Game[]
export type CatalogGame = (typeof CATALOG_GAMES)[number]

export function isCatalogGame(game: string): game is CatalogGame {
  return (CATALOG_GAMES as readonly string[]).includes(game)
}

/** One sanitized printing row from the mirror. */
export interface CatalogHit {
  game: CatalogGame
  apiId: string
  name: string
  setCode?: string
  number?: string
  rarity?: string
  imageUrl?: string
  artHash?: string
}

const bounded = (value: unknown, max: number): string | undefined => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s && s.length <= max ? s : undefined
}

/**
 * A server row through the same posture as a pasted link: every field
 * re-checked here even though the SQL constrains them, because "our own
 * server" still answers with whatever is in the table, and the table is
 * written by an operator script rather than this client.
 */
export function sanitizeCatalogHit(row: unknown): CatalogHit | null {
  const r = (row ?? {}) as Record<string, unknown>
  const game = typeof r.game === 'string' ? r.game : ''
  if (!isCatalogGame(game)) return null
  const apiId = bounded(r.api_id, 120)
  const name = bounded(r.name, 200)
  if (!apiId || !name) return null
  const imageUrl = bounded(r.image_url, 500)
  const artHash = bounded(r.art_hash, ART_HASH_BITS / 4)
  return {
    game,
    apiId,
    name,
    setCode: bounded(r.set_code, 24),
    number: bounded(r.collector_number, 24),
    rarity: bounded(r.rarity, 40),
    // The value becomes an <img src>; anything but https is dropped, exactly
    // as httpsImage does for shared binders.
    imageUrl: imageUrl?.startsWith('https://') ? imageUrl : undefined,
    artHash: artHash && new RegExp(`^[0-9a-f]{${ART_HASH_BITS / 4}}$`).test(artHash) ? artHash : undefined,
  }
}

/**
 * Synthesize an app `Card` from a mirror row. The id is the contract: the
 * mirror stores each game's OWN api id namespace (Scryfall uuid, `dex-…`
 * TCGdex ids, YGOPRODeck passcodes), so a card answered from the mirror
 * dedupes with — and later refreshes through — the same card from the live
 * API. Deliberately NO prices: the mirror is a fallback for identity, and a
 * day-stale mirror price presented as live would be wrong in the one place
 * users check value. `refreshCard` fills prices from the real source because
 * the apiId is real.
 */
export function cardFromCatalog(hit: CatalogHit): Card {
  return {
    id: `${hit.game}:${hit.apiId}`,
    game: hit.game,
    apiId: hit.apiId,
    name: hit.name,
    setCode: hit.setCode,
    number: hit.number,
    rarity: hit.rarity,
    imageSmall: hit.imageUrl,
    imageLarge: hit.imageUrl,
    prices: mergePrices([]),
    links: {
      tcgplayer: tcgplayerSearchLink(hit.name),
      ebaySold: ebaySoldLink({ name: hit.name, game: hit.game }),
    },
  }
}

/**
 * Accept a printing swap only under this distance. Measured on the harness
 * fixture images through the real `cardArtHash` (26 catalog scans, all
 * pairwise): different cards bottom out at 95 bits (median 126), while the
 * same art re-sampled to phone-preview size stays within 25–72. A live
 * capture adds lighting and perspective on top of resampling, so 80 accepts
 * most genuine same-art matches while sitting safely under everything that
 * was ever a different picture. Re-run the measurement before moving either
 * number — the method is in the 0021 migration header.
 */
export const ART_ACCEPT_DISTANCE = 80
/**
 * And only when the winner beats the runner-up by this much. Inside the
 * margin, two printings are indistinguishable at this hash's resolution
 * (reprints share art exactly), and swapping on a near-tie would let noise
 * pick which — the honest answer is to leave the name match's pick alone.
 */
export const ART_PICK_MARGIN = 16

/**
 * Choose between printings of an ALREADY-IDENTIFIED card by artwork
 * distance. This mirrors the cloud read's treatment rule (gemini.ts): art
 * similarity may pick among printings of the card, never propose a different
 * card — every candidate whose name is not the card's own is dropped before
 * distances are even computed. Returns null unless one candidate wins
 * decisively; null means "keep what the name match picked".
 */
export function pickPrintingByArt(
  captureHash: string,
  cardName: string,
  candidates: CatalogHit[],
): { hit: CatalogHit; distance: number } | null {
  if (!captureHash) return null
  const wanted = normalizeName(cardName)
  const ranked = candidates
    .filter((hit) => hit.artHash && normalizeName(hit.name) === wanted)
    .map((hit) => ({ hit, distance: artHashDistance(captureHash, hit.artHash!) }))
    .sort((a, b) => a.distance - b.distance)
  // One candidate is not a choice — with nothing to beat, "decisive" cannot
  // be established and the swap would rest on the absolute threshold alone.
  if (ranked.length < 2) return null
  const [best, second] = ranked
  if (best.distance > ART_ACCEPT_DISTANCE) return null
  if (second.distance - best.distance < ART_PICK_MARGIN) return null
  return best
}
