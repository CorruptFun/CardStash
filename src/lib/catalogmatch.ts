/**
 * The pure half of the catalog mirror (see catalog.ts for the transport and
 * the rules): shaping a server row into an app `Card`. Kept free of
 * settings/db/network imports so node unit tests exercise every decision in
 * this file directly.
 */

import { mergePrices } from './prices'
import type { Card, Game } from './types'
import { ebaySoldLink, tcgplayerSearchLink } from './util'

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

/**
 * One sanitized printing row from the mirror.
 *
 * The server row also carries an `art_hash` column (see migration 0022): a
 * RESERVED, unpopulated slot for a future artwork fingerprint. Nothing
 * client-side reads it this round — the hash-format contract (what is hashed,
 * how, and what distances mean) is deliberately still open, and parsing a
 * format that is not yet a contract would quietly close it. Don't add the
 * field back here without settling that question first.
 */
export interface CatalogHit {
  game: CatalogGame
  apiId: string
  name: string
  setCode?: string
  number?: string
  rarity?: string
  imageUrl?: string
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

