import { normalizeName, similarity } from './util'

/**
 * Pure scoring for sealed-product SET matching: OCR lines from a pack/box
 * front vs the TCGplayer group (set) index. Kept free of catalog/db imports
 * so node unit tests can exercise the matching rules directly.
 */

/** The shape of a TCGplayer group this module needs to score against. */
export interface SealedSetCandidate {
  /** Group display name, often code-prefixed ("SV08: Surging Sparks"). */
  name: string
  /** Set abbreviation when the catalog carries one ("SV4K"). */
  abbreviation?: string
}

/** Containment of the whole set name — the strongest evidence there is. */
const NAME_CONTAINED_SCORE = 0.86

/**
 * An exact printed set-code token ("sv4K" on a Japanese Pokémon pack). Strong
 * — it's the only Latin text such packaging carries — but deliberately below
 * NAME_CONTAINED_SCORE so a readable set name always outranks a code.
 */
const SET_CODE_SCORE = 0.8

/**
 * TCGplayer prefixes group names with codes ("SV08: Surging Sparks") — the
 * box doesn't print that prefix, so name matching compares without it. The
 * prefix must read as a CODE: an uppercase/digit run with at most one trailing
 * lowercase letter ("SV2a"). A capitalized word ("Theros: Beyond Death") is
 * part of the name, not a code — stripping it would break MTG box matching.
 */
export function cleanGroupName(name: string): string {
  return name.replace(/^[A-Z0-9]{1,6}[a-z]?\s*[:：—–-]\s+/, '')
}

/**
 * The set code a pack might literally print, lowercased for token comparison.
 * Sourced from the catalog abbreviation, falling back to the group-name
 * prefix. Only codes carrying BOTH a letter and a digit qualify ("sv4k",
 * "s12a"): letter-only ("MEW") and digit-only ("151") strings collide with
 * real card names and plain numbers OCR'd off any packaging.
 */
export function sealedSetCode(group: SealedSetCandidate): string | null {
  const fromName = group.name.match(/^([A-Za-z0-9]{2,7})\s*[:：—–-]\s/)?.[1]
  const code = (group.abbreviation?.trim() || fromName || '').toLowerCase()
  return /^(?=.*[a-z])(?=.*\d)[a-z0-9]{3,7}$/.test(code) ? code : null
}

/** Every alphanumeric token OCR produced, lowercased — set codes live here. */
export function sealedTokens(lines: string[]): Set<string> {
  const tokens = new Set<string>()
  for (const line of lines) {
    for (const token of line.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 2) tokens.add(token)
    }
  }
  return tokens
}

export interface SealedTextEvidence {
  /** Raw OCR lines, one per packaging text row. */
  lines: string[]
  /** All lines joined and normalized, for containment checks. */
  text: string
  /** Token set from `sealedTokens(lines)`. */
  tokens: Set<string>
}

/** Precompute the per-scan evidence every group is scored against. */
export function sealedEvidence(lines: string[]): SealedTextEvidence {
  return { lines, text: normalizeName(lines.join(' ')), tokens: sealedTokens(lines) }
}

/**
 * How confidently the packaging text points at this set (0..1). Three signals,
 * best wins: whole-name containment (plus a length bonus so "Prismatic
 * Evolutions" beats the "Evolutions" it contains), per-line fuzzy similarity,
 * and an exact printed set-code token — the only signal a Japanese Pokémon
 * pack offers, since everything but "Pokémon" and the code ("sv4K") is kanji
 * the on-device English OCR cannot read.
 */
export function sealedSetScore(group: SealedSetCandidate, evidence: SealedTextEvidence): number {
  let score = 0
  const clean = normalizeName(cleanGroupName(group.name))
  if (clean.length >= 4) {
    if (evidence.text.includes(clean)) {
      score = NAME_CONTAINED_SCORE + Math.min(0.12, clean.length / 150)
    } else {
      for (const line of evidence.lines) {
        const lineScore = similarity(line, cleanGroupName(group.name))
        if (lineScore > score) score = lineScore
      }
    }
  }
  if (score < SET_CODE_SCORE) {
    const code = sealedSetCode(group)
    if (code && evidence.tokens.has(code)) score = SET_CODE_SCORE
  }
  return score
}
