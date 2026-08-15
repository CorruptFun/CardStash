import type { Game } from './types'

/**
 * The printed "batch number" — the set/print code every trading card carries
 * somewhere on its face: "BLMR-EN085" on a Yu-Gi-Oh card, "OP01-016" on One
 * Piece, "NEO 266" on Magic, "SVI 123/198" on Pokémon.
 *
 * It is the one identifier a collector can read off the card without knowing
 * how the app spells anything, and it names ONE printing where a name names a
 * dozen — so search accepts it as a query in its own right. Parsing lives
 * here (pure, node-tested) and the per-game lookups it feeds live in
 * `cardsearch.ts`.
 *
 * The parse is deliberately conservative and never authoritative: a query
 * that parses still runs the ordinary name search alongside it (see
 * `searchGame`), so a card name that happens to look like a code — "Mew 25" —
 * loses nothing.
 */
export interface CardCode {
  /** The query re-joined in printed form, upper-cased: "BLMR-EN085". */
  code: string
  /** Printed set/batch prefix: "BLMR", "SVI", "OP01". Absent on a bare fraction. */
  setCode?: string
  /** Collector number as printed, language infix dropped: "085", "266a". */
  number?: string
  /** `number` with padding and any letters dropped: "85". */
  digits?: string
  /** Denominator of a printed fraction — "123/198" → "198". */
  printedTotal?: string
  /** Yu-Gi-Oh's 8-digit passcode: an identity on its own, no set involved. */
  passcode?: string
}

/**
 * Language infixes printed between set code and number ("BLMR-EN085"). Same
 * list the collector-line parser uses; a card's number is the digits, the
 * infix only says which printing plant ran it.
 */
const LANG = /^(EN|DE|FR|IT|ES|SP|PT|JA|JP|KR|KO|RU|ZH|CN|TC|AE)(?=\d)/

/** A set/batch prefix: starts with a letter, 2–6 chars, letters and digits. */
const PREFIX = '[A-Z][A-Z0-9]{1,5}'
/** A collector suffix: optional language infix, digits, optional variant letter. */
const SUFFIX = '(?:[A-Z]{2})?\\d{1,4}[A-Z]?'

const PASSCODE = /^\d{8}$/
const BARE_FRACTION = /^(\d{1,4})\s*\/\s*(\d{2,4})$/
const SET_FRACTION = new RegExp(`^(${PREFIX})[\\s-]+(\\d{1,4})\\s*/\\s*(\\d{2,4})$`)
const SET_NUMBER = new RegExp(`^(${PREFIX})[\\s-]+(${SUFFIX})$`)

function unpad(value: string): string {
  return value.replace(/^0+(?=\d)/, '')
}

function digitsOf(value: string): string | undefined {
  return unpad(value.replace(/\D+/g, '')) || undefined
}

/**
 * Read a search query as a printed card code, or null when it plainly isn't
 * one. Kept tight on purpose: a separator is required (nobody prints
 * "BLMREN085"), the prefix caps at six characters, and anything longer than a
 * code is rejected outright — every loose match costs a wasted lookup on an
 * ordinary name search.
 */
export function parseCardCode(query: string): CardCode | null {
  const raw = query
    .trim()
    .toUpperCase()
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
  if (!raw || raw.length > 20) return null

  if (PASSCODE.test(raw)) return { code: raw, passcode: unpad(raw) }

  const bare = raw.match(BARE_FRACTION)
  // Set-size floor: below 45 the "fraction" is a Magic power/toughness box or
  // a deck-list count, not a collector number.
  if (bare && Number(bare[2]) >= 45) {
    return { code: `${unpad(bare[1])}/${unpad(bare[2])}`, number: bare[1], digits: digitsOf(bare[1]), printedTotal: unpad(bare[2]) }
  }

  const fraction = raw.match(SET_FRACTION)
  if (fraction && Number(fraction[3]) >= 45) {
    return {
      code: `${fraction[1]} ${unpad(fraction[2])}/${unpad(fraction[3])}`,
      setCode: fraction[1],
      number: fraction[2],
      digits: digitsOf(fraction[2]),
      printedTotal: unpad(fraction[3]),
    }
  }

  const pair = raw.match(SET_NUMBER)
  if (pair) {
    const setCode = pair[1]
    const suffix = pair[2]
    const lang = suffix.match(LANG)?.[1]
    const number = lang ? suffix.slice(lang.length) : suffix
    const digits = digitsOf(number)
    if (!digits) return null
    return { code: `${setCode}-${suffix}`, setCode, number, digits }
  }

  return null
}

/**
 * Codes compare across languages and zero-padding — "BLMR-EN085",
 * "BLMR-085" and "blmr en85" are one printing. That rule is identical in
 * every code game (One Piece's OP01-016, Digimon's BT12-041), so search
 * reuses the collector-line parser's comparator rather than growing a second
 * one that could drift from it.
 */
export { sameYgoCode as sameCardCode } from './corner'

/** What a printed code looks like in each game — search placeholder copy. */
export const CODE_EXAMPLE: Record<Game, string | null> = {
  mtg: 'NEO 266',
  pokemon: 'SVI 123',
  yugioh: 'BLMR-EN085',
  riftbound: 'OGN-045',
  lorcana: 'TFC 1',
  onepiece: 'OP01-016',
  starwars: 'SOR 015',
  digimon: 'BT12-041',
  gundam: 'GD01-003',
  sports: null,
}
