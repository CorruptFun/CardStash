/**
 * Reading a graded slab's label.
 *
 * This is the easiest high-value target in the whole app and the reason
 * sports scanning can be good rather than merely present. A raw card is a
 * photograph of an object with no fixed layout; a slab is a manufactured
 * label — clean printed type, a fixed vocabulary of grades, and a cert number
 * that resolves to the exact card. Everything a scanner wishes it had.
 *
 * The label also carries the card's own identity ("1989 UPPER DECK #1 KEN
 * GRIFFEY JR. RC"), so the same text feeds `sportsparse.ts` and the two reads
 * combine into a fully identified, fully graded card from one crop.
 *
 * Pure, like `sportsparse.ts` — no DOM, no network — so the grade vocabulary
 * can be held to by unit test. The canvas work lives in `identify.ts` and the
 * cert lookup in `psa.ts`.
 */

import type { GradeCompany, GradeInfo } from './types'

export interface SlabRead {
  grade: GradeInfo
  /**
   * How strongly this looks like a slab rather than a card that happens to
   * mention a number, 0..1. The caller uses it to decide whether to trust the
   * slab path over the ordinary card path.
   */
  confidence: number
}

/**
 * Company markers. Beckett prints "BGS" on the label but "BECKETT" in the
 * logo, and both appear on a good crop, so each company gets every form it
 * is actually printed in.
 */
const COMPANIES: [RegExp, GradeCompany][] = [
  [/\bP\.?S\.?A\.?\b|PROFESSIONAL SPORTS AUTHENTICATOR/i, 'PSA'],
  [/\bB\.?G\.?S\.?\b|\bBECKETT\b/i, 'BGS'],
  [/\bS\.?G\.?C\.?\b|SPORTSCARD GUARANTY/i, 'SGC'],
  [/\bC\.?G\.?C\.?\b|CERTIFIED GUARANTY/i, 'CGC'],
  [/\bH\.?G\.?A\.?\b|HYBRID GRADING/i, 'HGA'],
  [/\bT\.?A\.?G\.?\b|TECHNICAL AUTHENTICATION/i, 'TAG'],
]

/**
 * Printed grade descriptions and the number they mean. Labels very often show
 * both ("GEM MT 10"), but a worn or cropped read can lose one of them — and
 * either half alone is enough to recover the grade, which is why this table
 * is bidirectional in practice.
 *
 * Ordered longest-first at match time so "GEM MT" is not shadowed by "MT" and
 * "NM-MT" not by "NM".
 */
const GRADE_WORDS: [string, number][] = [
  ['PRISTINE', 10],
  ['GEM MINT', 10],
  ['GEM MT', 10],
  ['GEM-MT', 10],
  ['MINT+', 9.5],
  ['NM-MT+', 8.5],
  ['NM-MT', 8],
  ['NM MT', 8],
  ['NRMT-MT', 8],
  ['EX-MT', 6],
  ['EX MT', 6],
  ['VG-EX', 4],
  ['VG EX', 4],
  ['MINT', 9],
  ['NM', 7],
  ['EX', 5],
  ['VG', 3],
  ['GOOD', 2],
  ['FAIR', 1.5],
  ['POOR', 1],
  ['PR', 1],
]

/** PSA qualifiers — a graded 8(OC) is not an 8, and collectors price it apart. */
const QUALIFIERS = /\b(OC|ST|MK|MC|PD|OF)\b/

/** "AUTHENTIC" / "AUTH" slabs carry no numeric grade at all. */
const AUTHENTIC = /\bAUTHENTIC\b|\bAUTH\b(?!\w)/i

/**
 * Cert numbers are the one field on the label with no natural upper bound on
 * damage from a misread — a wrong cert resolves to a real but different card
 * — so the shape is kept strict: a standalone run of 7 to 11 digits, which is
 * what PSA, BGS, SGC and CGC all issue, and which a card number or a year
 * cannot masquerade as.
 */
const CERT = /(?<!\d)(\d{7,11})(?!\d)/

export function detectGradeCompany(text: string): GradeCompany | undefined {
  for (const [pattern, company] of COMPANIES) if (pattern.test(text)) return company
  return undefined
}

/**
 * The numeric grade. An explicit number next to a company or a grade word is
 * trusted; otherwise the printed description is translated. A bare number on
 * its own is deliberately NOT accepted — labels are covered in numbers, and
 * the card number is right there next to the grade.
 */
export function detectGrade(text: string): { grade?: number; label?: string } {
  const upper = text.toUpperCase()
  const ordered = [...GRADE_WORDS].sort((a, b) => b[0].length - a[0].length)
  for (const [word, value] of ordered) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // "GEM MT 10" — the description with its number spelled out beside it.
    const withNumber = upper.match(new RegExp(`\\b${escaped}\\b\\s*(10|\\d(?:\\.5)?)\\b`))
    if (withNumber) return { grade: Number(withNumber[1]), label: word }
    if (new RegExp(`\\b${escaped}\\b`).test(upper)) return { grade: value, label: word }
  }
  // "PSA 10" / "BGS 9.5" — the company followed by its number.
  const beside = upper.match(/\b(?:PSA|BGS|SGC|CGC|HGA|TAG)\s*(10(?:\.0)?|[1-9](?:\.5)?)\b/)
  if (beside) return { grade: Number(beside[1]) }
  return {}
}

export function detectCert(text: string): string | undefined {
  return text.match(CERT)?.[1]
}

/**
 * Parse a slab label into a grade, or null when the text is not a slab.
 *
 * The bar for "this is a slab" is a company marker plus either a grade or a
 * cert. A card can easily mention a number; only a slab says PSA and 10 in
 * the same breath, and requiring both is what keeps the slab path from
 * hijacking ordinary card scans.
 */
export function parseSlabLabel(lines: string[]): SlabRead | null {
  const text = lines
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  if (!text) return null

  const company = detectGradeCompany(text)
  if (!company) return null

  const cert = detectCert(text)
  const { grade, label } = detectGrade(text)
  const authentic = AUTHENTIC.test(text)
  if (grade == null && !authentic) {
    // A company name with no grade at all is a sticker, a sleeve or a shop
    // logo — not a graded card. Refusing here costs nothing; the ordinary
    // card path still gets its turn.
    return null
  }

  const qualifier = text.match(QUALIFIERS)?.[1]
  const info: GradeInfo = {
    company,
    grade: grade ?? 0,
    label: label ?? (authentic ? 'AUTHENTIC' : undefined),
    cert,
    qualifier,
  }

  // Evidence, not enthusiasm: the company is a given by this point, so what
  // is left to earn is the grade and the cert that makes it verifiable.
  const confidence = 0.4 + (grade != null ? 0.3 : 0) + (cert ? 0.3 : 0)
  return { grade: info, confidence: Math.round(confidence * 100) / 100 }
}

/** Whether a read is worth routing down the slab path at all. */
export function looksLikeSlab(lines: string[]): boolean {
  return parseSlabLabel(lines) != null
}

/** "PSA 10 GEM MT" — how a grade is written wherever it is shown. */
export function gradeLabel(grade: GradeInfo): string {
  const number = grade.grade > 0 ? ` ${grade.grade}` : ''
  const qualifier = grade.qualifier ? `(${grade.qualifier})` : ''
  return `${grade.company}${number}${qualifier}${grade.label ? ` ${grade.label}` : ''}`.trim()
}

/**
 * Validate a grade that came from outside — a backup file, a shared binder, a
 * trade link. Same rule as everything else decoded from a link or a file: the
 * shape is checked here once and both the backup path and `social.ts` use it,
 * so there is a single implementation to get right.
 */
export function sanitizeGrade(raw: unknown): GradeInfo | undefined {
  if (raw == null || typeof raw !== 'object') return undefined
  const entry = raw as Record<string, unknown>
  const company = COMPANY_NAMES.find((name) => name === entry.company)
  if (!company) return undefined
  const grade = Number(entry.grade)
  // 0 is the AUTHENTIC slab; anything outside 0..10 is not a grade.
  if (!Number.isFinite(grade) || grade < 0 || grade > 10) return undefined
  const text = (value: unknown, max: number): string | undefined => {
    const out = typeof value === 'string' ? value.trim().slice(0, max) : ''
    return out ? out : undefined
  }
  return {
    company,
    grade: Math.round(grade * 2) / 2,
    label: text(entry.label, 24),
    cert: text(entry.cert, 24)?.replace(/[^0-9A-Za-z-]/g, '') || undefined,
    qualifier: text(entry.qualifier, 4),
  }
}

const COMPANY_NAMES: GradeCompany[] = ['PSA', 'BGS', 'SGC', 'CGC', 'HGA', 'TAG']

/** Short form for a chip: "PSA 10". */
export function gradeShort(grade: GradeInfo): string {
  return grade.grade > 0 ? `${grade.company} ${grade.grade}` : `${grade.company} AUTH`
}
