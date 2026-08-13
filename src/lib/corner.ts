import type { Game } from './types'

/**
 * The collector line — set code + collector number printed on the card — is
 * what pins the exact edition without any cloud vision. These are the crop
 * regions (fractions of a card crop) where each game prints it, and the
 * parsers that dig it out of noisy on-device OCR text.
 */

export interface CornerRect {
  x: number
  y: number
  w: number
  h: number
}

export const CORNER_REGION: Record<Game, CornerRect> = {
  mtg: { x: 0, y: 0.85, w: 0.62, h: 0.15 },
  pokemon: { x: 0, y: 0.87, w: 1, h: 0.13 },
  // Yu-Gi-Oh prints the set code right-aligned just under the art.
  yugioh: { x: 0.3, y: 0.5, w: 0.7, h: 0.13 },
  riftbound: { x: 0, y: 0.85, w: 1, h: 0.15 },
  lorcana: { x: 0, y: 0.87, w: 0.78, h: 0.13 },
  onepiece: { x: 0, y: 0.85, w: 1, h: 0.15 },
  starwars: { x: 0, y: 0.85, w: 1, h: 0.15 },
  digimon: { x: 0, y: 0.85, w: 1, h: 0.15 },
  gundam: { x: 0, y: 0.85, w: 1, h: 0.15 },
}

/**
 * Where to look HARDER when the wide strip fails: the collector line is tiny
 * type that drowns next to rules text at strip scale, but a narrow sliver
 * OCR'd at full upscale resolves it. Ordered by likelihood; read binarized.
 * (Pokémon: modern cards print it bottom-left, vintage bottom-right.)
 */
export const CORNER_RETRY_REGIONS: Partial<Record<Game, CornerRect[]>> = {
  pokemon: [
    { x: 0, y: 0.925, w: 0.52, h: 0.075 },
    { x: 0.45, y: 0.9, w: 0.55, h: 0.1 },
  ],
  mtg: [{ x: 0, y: 0.9, w: 0.5, h: 0.1 }],
  riftbound: [{ x: 0, y: 0.92, w: 0.6, h: 0.08 }],
  lorcana: [{ x: 0, y: 0.92, w: 0.55, h: 0.08 }],
  onepiece: [{ x: 0, y: 0.92, w: 0.6, h: 0.08 }],
  starwars: [{ x: 0, y: 0.92, w: 0.6, h: 0.08 }],
}

export interface CornerRead {
  setCode?: string
  number?: string
  /** Printed set size from "123/198" — disambiguates Pokémon sets. */
  total?: string
}

const LANGS = new Set(['EN', 'DE', 'FR', 'IT', 'ES', 'PT', 'JA', 'JP', 'KO', 'RU', 'ZH', 'CN', 'CS', 'CT'])
const YEAR = /^(19|20)\d{2}$/

/** Games whose collector number is a set-prefixed code like OP01-016. */
const CODE_GAMES = new Set<Game>(['yugioh', 'onepiece', 'digimon', 'gundam'])

export function parseCornerInfo(game: Game, text: string): CornerRead {
  const upper = text.toUpperCase().replace(/[–—]/g, '-')

  if (CODE_GAMES.has(game)) {
    // LOB-EN001, OP01-016, BT12-041, GD01-003 — tolerate OCR gaps.
    const code = upper.match(/\b([A-Z]{1,4}\d{0,3})\s*-\s*([A-Z]{0,2}\s?\d{2,4})\b/)
    if (!code) return {}
    const prefix = code[1].replace(/[^A-Z0-9]/g, '')
    const suffix = code[2].replace(/[^A-Z0-9]/g, '')
    return { number: `${prefix}-${suffix}`, setCode: prefix }
  }

  if (game === 'mtg') {
    // Modern: "0269 M" then "MH3 • EN"; older: "269/350 U" then "M21 • EN".
    let number: string | undefined
    for (const line of upper.split('\n')) {
      // The denominator is the SET size — a creature's "4/4" power/toughness
      // box also matches a bare fraction shape, but no set has 44 cards's
      // worth of ambiguity: real set sizes start well above P/T values.
      const frac = line.match(/\b0*(\d{1,4})\s*\/\s*0*(\d{2,4})\b/)
      if (frac && Number(frac[2]) >= 45) {
        number = frac[1]
        break
      }
      // A line holding a REJECTED fraction is the P/T box or token rules
      // text — its digits must not feed the solo-number fallback either.
      if (/\d\s*\/\s*\d/.test(line)) continue
      const solo = line.match(/(?:^|[^\dA-Z/])0*(\d{1,4})(?:[A-Z]\b|\b)/)
      if (solo && !YEAR.test(solo[1])) {
        number = solo[1]
        break
      }
    }
    const nearLang = upper.match(/\b([A-Z][A-Z0-9]{2,4})\b[^A-Z0-9\n]{0,4}(EN|DE|FR|IT|ES|PT|JA|JP|KO|RU|ZH)\b/)
    const setCode = nearLang && !LANGS.has(nearLang[1]) ? nearLang[1] : undefined
    return { setCode, number }
  }

  // Fraction-style games: Pokémon 123/198, Lorcana 23/204 · EN · 1, SWU 056/262.
  const frac = upper.match(/\b0*(\d{1,3})\s*\/\s*0*(\d{1,3})\b/) ?? fusedFraction(upper)
  if (game === 'lorcana') {
    if (!frac) return {}
    const set = upper.match(/\b(?:EN|FR|DE|IT)\b[^A-Z0-9\n]{0,4}(Q?\d{1,2})\b/)
    return { number: frac[1], total: frac[2], setCode: set?.[1] }
  }
  if (game === 'pokemon') {
    if (frac) {
      // SV era also prints the set code: "SVI EN 123/198".
      const line = upper.split('\n').find((l) => l.includes(`${frac[1]}/${frac[2]}`) || /\d\s*\/\s*\d/.test(l)) ?? ''
      const token = line.match(/\b([A-Z]{2,4}\d?)\b/g)?.find((t) => !LANGS.has(t) && !/^\d+$/.test(t))
      return { number: frac[1], total: frac[2], setCode: token }
    }
    // Promos: SWSH250, SM210, XY67…
    const promo = upper.match(/\b(SWSH|SVP|SM|XY|BW)\s?0*(\d{1,3})\b/)
    if (promo) return { number: `${promo[1]}${promo[2]}` }
    return {}
  }
  // Riftbound / Star Wars: Unlimited and friends — the number alone helps.
  return frac ? { number: frac[1], total: frac[2] } : {}
}

/**
 * The collector fraction's slash is the smallest glyph on the card and OCR
 * regularly eats it: "156/149" reads as "156149". Recover a plausible
 * number/total split from a bare 5-6 digit run — totals are set sizes
 * (double or triple digits) and secret-rare numbers overshoot the total
 * only modestly, which prunes bogus splits.
 */
function fusedFraction(upper: string): RegExpMatchArray | null {
  const run = upper.match(/(?:^|[^\d/])(\d{5,6})(?:[^\d/]|$)/)
  if (!run) return null
  const digits = run[1]
  const splits = digits.length === 6 ? [3] : [2, 3]
  for (const at of splits) {
    const number = Number(digits.slice(0, at).replace(/^0+(?=\d)/, ''))
    const total = Number(digits.slice(at).replace(/^0+(?=\d)/, ''))
    const plausible =
      total >= 30 && total <= 400 && number >= 1 && number <= total + 150 && !YEAR.test(digits.slice(0, 4))
    if (plausible) {
      // Shape-compatible with the RegExpMatchArray the fraction regex yields
      // (which also strips leading zeros from both groups).
      return [digits, String(number), String(total)] as unknown as RegExpMatchArray
    }
  }
  return null
}

/** Compare Yu-Gi-Oh print codes across languages: LOB-EN001 ≡ LOB-001. */
export function sameYgoCode(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const norm = (value: string) => {
    const m = value
      .toUpperCase()
      .replace(/\s+/g, '')
      .match(/([A-Z0-9]+)-(?:[A-Z]{0,2})?0*(\d+)/)
    return m ? `${m[1]}-${m[2]}` : value.toUpperCase()
  }
  return norm(a) === norm(b)
}
