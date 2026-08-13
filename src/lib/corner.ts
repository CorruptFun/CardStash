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

/**
 * Windows tried when the collector line is the SOLE evidence (no name was
 * readable — a non-Latin print, or glare over the title). Tighter than the
 * refine-path regions on purpose: they must exclude the rules box above,
 * whose text otherwise dominates segmentation and whose bright/dark mass
 * skews the polarity decision away from the line itself.
 */
export const SOLE_EVIDENCE_REGIONS: Partial<Record<Game, CornerRect[]>> = {
  mtg: [
    { x: 0, y: 0.925, w: 0.5, h: 0.075 },
    { x: 0, y: 0.88, w: 0.5, h: 0.12 },
  ],
  pokemon: [
    { x: 0, y: 0.93, w: 0.55, h: 0.07 },
    // Badge-tight: the Japanese set code is a white-on-dark chip a few
    // pixels wide, legible only when it dominates its own crop.
    { x: 0.02, y: 0.925, w: 0.28, h: 0.06 },
  ],
}

export interface CornerRead {
  setCode?: string
  number?: string
  /** Printed set size from "123/198" — disambiguates Pokémon sets. */
  total?: string
  /**
   * The fraction was RECONSTRUCTED from a bare digit run (OCR ate the
   * slash). Fine for refining a name-corroborated match; as sole evidence it
   * identifies only with independent set-code corroboration.
   */
  fused?: boolean
  /**
   * MTG solo collector number carried its leading-zero padding ("0266") —
   * the modern-frame shape. A read without it is either a vintage fraction
   * (which corroborates itself via the set size) or a degraded read that
   * must not serve as sole evidence: collector numbers are dense, so a
   * one-digit misread lands on a real neighboring card, not on nothing.
   */
  padded?: boolean
}

const LANGS = new Set(['EN', 'DE', 'FR', 'IT', 'ES', 'PT', 'JA', 'JP', 'KO', 'RU', 'ZH', 'CN', 'CS', 'CT'])
const YEAR = /^(19|20)\d{2}$/

/**
 * Pokémon rarity marks printed right beside the collector fraction — "020/066
 * RR". They share the set code's shape, and mistaking one for a set code is
 * worse than reading no code at all: it sends the lookup hunting a set that
 * doesn't exist instead of falling back to size matching.
 */
const PKM_RARITY = new Set(['C', 'U', 'R', 'RR', 'RRR', 'SR', 'HR', 'UR', 'AR', 'SAR', 'CHR', 'CSR', 'ACE', 'K', 'A', 'S', 'PR'])

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
    let total: string | undefined
    let padded: boolean | undefined
    for (const line of upper.split('\n')) {
      // The denominator is the SET size — a creature's "4/4" power/toughness
      // box also matches a bare fraction shape, but no set has 44 cards's
      // worth of ambiguity: real set sizes start well above P/T values.
      // Denominator bounds are the sanity check: below 45 it's a P/T box,
      // above 600 no set is that big and the digits doubled under OCR
      // ("266/302" → "2886/7302").
      const frac = line.match(/\b0*(\d{1,4})\s*\/\s*0*(\d{2,4})\b/)
      if (frac && Number(frac[2]) >= 45 && Number(frac[2]) <= 600) {
        number = frac[1]
        total = frac[2]
        break
      }
      // A line holding a REJECTED fraction is the P/T box or token rules
      // text — its digits must not feed the solo-number fallback either.
      if (/\d\s*\/\s*\d/.test(line)) continue
      const solo = line.match(/(?:^|[^\dA-Z/])(0*)(\d{1,4})(?:[A-Z]\b|\b)/)
      if (solo && !YEAR.test(solo[2])) {
        number = solo[2]
        padded = solo[1].length > 0 || undefined
        break
      }
    }
    const nearLang = upper.match(/\b([A-Z][A-Z0-9]{2,4})\b[^A-Z0-9\n]{0,4}(EN|DE|FR|IT|ES|PT|JA|JP|KO|RU|ZH)\b/)
    const setCode = nearLang && !LANGS.has(nearLang[1]) ? nearLang[1] : undefined
    return { setCode, number, total, padded }
  }

  // Fraction-style games: Pokémon 123/198, Lorcana 23/204 · EN · 1, SWU 056/262.
  const slashed = upper.match(/\b0*(\d{1,3})\s*\/\s*0*(\d{1,3})\b/)
  const frac = slashed ?? fusedFraction(upper)
  const fused = !slashed && frac ? true : undefined
  if (game === 'lorcana') {
    if (!frac) return {}
    const set = upper.match(/\b(?:EN|FR|DE|IT)\b[^A-Z0-9\n]{0,4}(Q?\d{1,2})\b/)
    return { number: frac[1], total: frac[2], setCode: set?.[1], fused }
  }
  if (game === 'pokemon') {
    if (frac) {
      // SV era also prints the set code: "SVI EN 123/198". Japanese prints
      // use digit-bearing codes with a trailing letter — "SV4K 046/066",
      // "S12a" — the second alternation's shape.
      // Sparse OCR splits the corner into fragments, so the code can land on
      // its own line — search the whole read, fraction line first.
      const lines = upper.split('\n')
      const fracLine = lines.find((l) => l.includes(`${frac[1]}/${frac[2]}`) || /\d\s*\/\s*\d/.test(l)) ?? ''
      const codeIn = (text: string, needsDigit: boolean) =>
        text
          .match(/\b([A-Z]{2,4}\d?|[A-Z]{1,3}\d{1,2}[A-Z]{1,2})\b/g)
          ?.find(
            (t) =>
              !LANGS.has(t) &&
              !PKM_RARITY.has(t) &&
              !/^\d+$/.test(t) &&
              // Off the fraction line, only a digit-bearing code counts:
              // sparse OCR scatters the illustrator credit ("Illus." →
              // "HUS") into its own fragment, and a letters-only token there
              // is far more likely to be that than a set code. Japanese
              // codes — the ones that matter here — always carry a digit.
              (!needsDigit || /\d/.test(t)),
          )
      const token = codeIn(fracLine, false) ?? codeIn(lines.filter((l) => l !== fracLine).join(' '), true)
      return { number: frac[1], total: frac[2], setCode: token, fused }
    }
    // Promos: SWSH250, SM210, XY67…
    const promo = upper.match(/\b(SWSH|SVP|SM|XY|BW)\s?0*(\d{1,3})\b/)
    if (promo) return { number: `${promo[1]}${promo[2]}` }
    return {}
  }
  // Riftbound / Star Wars: Unlimited and friends — the number alone helps.
  return frac ? { number: frac[1], total: frac[2], fused } : {}
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
  if (run) {
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
  }
  // The italic slash of "020/066" also reads as a DIGIT (7 above all, 1 for
  // upright faces): somewhere in the run hides a 3+slash+3 window. Junk
  // digits glue onto either end (the set-code badge beside the fraction
  // bleeds into the digits — "310207066"), so slide the window over runs up
  // to 10 long. Still reconstructions — fused, so they identify only with
  // set-code corroboration.
  const runLong = upper.match(/(?:^|[^\d/])(\d{7,10})(?:[^\d/]|$)/)
  if (runLong) {
    const run = runLong[1]
    for (let at = 0; at + 7 <= run.length; at++) {
      const digits = run.slice(at, at + 7)
      if (!/[71]/.test(digits[3]) || YEAR.test(digits.slice(0, 4))) continue
      const number = Number(digits.slice(0, 3).replace(/^0+(?=\d)/, ''))
      const total = Number(digits.slice(4).replace(/^0+(?=\d)/, ''))
      if (total >= 30 && total <= 400 && number >= 1 && number <= total + 150) {
        return [digits, String(number), String(total)] as unknown as RegExpMatchArray
      }
    }
  }
  return null
}

/**
 * The 8-digit passcode printed in every Yu-Gi-Oh card's bottom-left corner —
 * the same digits in every language, and exactly YGOPRODeck's card id. The
 * id space is sparse (~13k cards over 100M combinations), so a misread digit
 * resolves to nothing rather than to a wrong card.
 */
export const YGO_PASSCODE_REGION: CornerRect = { x: 0, y: 0.93, w: 0.42, h: 0.07 }

export function parsePasscode(text: string): string | null {
  const m = text.match(/(?:^|\D)(\d{8})(?!\d)/)
  return m ? m[1].replace(/^0+(?=\d)/, '') : null
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

/**
 * Could a card printing this collector-line text belong to `game`?
 *
 * The games split cleanly on the SHAPE of the number they print: Pokémon,
 * Magic, Lorcana, Riftbound and Star Wars print the collector number as a
 * fraction of the set size ("183/226"), while the code games — Yu-Gi-Oh, One
 * Piece, Digimon, Gundam — print a set-prefixed code ("LOB-EN001", "OP01-016")
 * and never a fraction at all. So a fraction read off the bottom strip is
 * positive evidence AGAINST those games, and it is the only cross-game
 * evidence available before a name has been matched to anything.
 *
 * Deliberately one-directional: this only ever rules a game OUT, and only on
 * the one shape it cannot print. It is not a game detector — a card that reads
 * no line at all (the common case on a poor capture) rules out nothing, and
 * the caller carries on exactly as before.
 *
 * Measured over the whole scan matrix, the fraction fires on 41/81 Pokémon
 * cells and on 0/36 Yu-Gi-Oh ones: it catches the failure direction about half
 * the time and never once misfired on a genuine Yu-Gi-Oh card. Yu-Gi-Oh's own
 * digit pairs can't trip it — "ATK/2500 DEF/2000" has letters, not digits, on
 * the near side of every slash.
 */
export function collectorLineAllows(game: Game, text: string): boolean {
  if (!CODE_GAMES.has(game)) return true
  const upper = text.toUpperCase().replace(/[–—]/g, '-')
  const frac = upper.match(/\b0*(\d{1,3})\s*\/\s*0*(\d{1,3})\b/)
  // The same shape and set-size floor looksLikeCollectorLine trusts, so a
  // creature's "4/4" or a stray "1/2" is not mistaken for a set size.
  return !(frac && Number(frac[2]) >= 20)
}

/**
 * Does this text read like a printed collector line? Used to decide which way
 * up a SIDEWAYS card is: turned the right way the bottom strip holds the
 * fraction / set-dash code / passcode, turned the wrong way it holds the
 * card's top edge and matches none of them. Deliberately game-agnostic and
 * script-agnostic — a Japanese card offers no other Latin evidence, and the
 * decision has to be made before any game is known.
 */
export function looksLikeCollectorLine(text: string): boolean {
  const upper = text.toUpperCase().replace(/[–—]/g, '-')
  // "123/198" — a printed fraction with a plausible set size.
  const frac = upper.match(/\b0*(\d{1,3})\s*\/\s*0*(\d{1,3})\b/)
  if (frac && Number(frac[2]) >= 20) return true
  // "OP01-016", "LOB-EN001" — set-prefixed codes.
  if (/\b[A-Z]{1,4}\d{0,3}\s*-\s*[A-Z]{0,2}\s?\d{2,4}\b/.test(upper)) return true
  // The Yu-Gi-Oh passcode.
  if (/(?:^|\D)\d{8}(?!\d)/.test(upper)) return true
  return false
}
