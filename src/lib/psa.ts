/**
 * PSA cert lookup — the one free, official identity service sports cards have.
 *
 * PSA publishes a public API whose single useful job is exactly the one we
 * need: hand it a certification number off a slab label and it returns what
 * PSA graded — year, brand, subject, card number, grade, sport, population.
 * That turns a slab scan from "we read some words" into an exact card.
 *
 * It is strictly an ENHANCEMENT and never a dependency:
 *
 * - A token is the user's own, entered in Settings, exactly like `pokemonKey`.
 *   With no token this module never runs and never contacts PSA, so a user
 *   who does not opt in makes no request — the same rule Drive and the vault
 *   follow.
 * - Every failure is non-fatal. The slab label alone already yields the grade,
 *   the cert and usually the whole card, so a refused, rate-limited or
 *   unreachable API downgrades the scan rather than breaking it.
 *
 * Two caveats worth knowing before debugging this in the wild. PSA's free tier
 * is about 100 calls a day, which is why results are cached hard and lookups
 * only ever fire on an explicit slab scan. And the API is not documented as
 * CORS-enabled for browser origins: if PSA does not send the header, this call
 * fails in the page no matter how good the token is. That is why the failure
 * path is a first-class outcome here rather than an afterthought — see
 * `PsaOutcome`.
 */

import { db, kvGet, kvPut } from './db'
import { fetchJson, isAbort } from './fetchJson'
import { detectBrand, detectProduct } from './sportsparse'
import type { ParsedSportsCard } from './sportsparse'
import type { Sport } from './types'

const ENDPOINT = 'https://api.psacard.com/publicapi/cert/GetByCertNumber'
/** A cert's grade never changes, so a hit is good essentially forever. */
const CERT_TTL_MS = 180 * 86_400_000

export interface PsaCert {
  cert: string
  year?: number
  /** PSA's own brand string — "1989 UPPER DECK", "PANINI PRIZM". */
  brand?: string
  subject?: string
  cardNumber?: string
  variety?: string
  category?: string
  grade?: number
  gradeDescription?: string
  totalPopulation?: number
  populationHigher?: number
}

export type PsaOutcome =
  | { ok: true; cert: PsaCert }
  | { ok: false; reason: 'no-token' | 'not-found' | 'unauthorized' | 'rate-limited' | 'unreachable'; message: string }

/**
 * Field names come back from PSA in more than one casing depending on the
 * endpoint and the era of the docs, and we cannot verify the live shape from
 * a build environment. Reading keys case-insensitively costs nothing and
 * turns "the API renamed a field" from a silent blank into a non-event.
 */
function pick(source: Record<string, unknown> | null, ...names: string[]): unknown {
  if (!source) return undefined
  const lower = new Map(Object.keys(source).map((key) => [key.toLowerCase(), key]))
  for (const name of names) {
    const actual = lower.get(name.toLowerCase())
    if (actual != null && source[actual] != null && source[actual] !== '') return source[actual]
  }
  return undefined
}

function asNumber(value: unknown): number | undefined {
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function asText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : value != null ? String(value).trim() : ''
  return text ? text : undefined
}

/** Normalize whatever shape the response arrived in into `PsaCert`. */
export function normalizePsaCert(payload: unknown, cert: string): PsaCert | null {
  if (payload == null || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const inner = (pick(root, 'PSACert', 'psaCert', 'cert') as Record<string, unknown> | undefined) ?? root
  const grade = asNumber(pick(inner, 'CardGrade', 'grade', 'gradeValue'))
  const description = asText(pick(inner, 'GradeDescription', 'cardGrade', 'gradeDescription'))
  // "GEM MT 10" arrives in either field depending on the record; if the
  // numeric one is missing, the words still carry the number.
  const spelled = description?.match(/\b(10|[1-9](?:\.5)?)\b/)?.[1]
  return {
    cert,
    year: asNumber(pick(inner, 'Year', 'year')),
    brand: asText(pick(inner, 'Brand', 'brand')),
    subject: asText(pick(inner, 'Subject', 'subject', 'playerName')),
    cardNumber: asText(pick(inner, 'CardNumber', 'cardNumber')),
    variety: asText(pick(inner, 'Variety', 'varietyPedigree', 'variety')),
    category: asText(pick(inner, 'Category', 'category', 'sport')),
    grade: grade ?? (spelled ? Number(spelled) : undefined),
    gradeDescription: description,
    totalPopulation: asNumber(pick(inner, 'TotalPopulation', 'totalPopulation')),
    populationHigher: asNumber(pick(inner, 'PopulationHigher', 'populationHigher')),
  }
}

/** PSA's category string ("Baseball Cards") to our sport. */
export function psaSport(category: string | undefined): Sport {
  const text = (category ?? '').toLowerCase()
  if (text.includes('baseball')) return 'baseball'
  if (text.includes('basketball')) return 'basketball'
  if (text.includes('football')) return 'football'
  if (text.includes('hockey')) return 'hockey'
  if (text.includes('soccer')) return 'soccer'
  if (text.includes('racing') || text.includes('nascar')) return 'racing'
  if (text.includes('wrestling')) return 'wrestling'
  return 'other'
}

/**
 * Turn a PSA record into the same parsed shape a card read produces, so a
 * cert lookup and an OCR read build cards through one code path and cannot
 * drift apart. PSA's `brand` is a whole set string, so it goes back through
 * the same brand/product vocabulary the scanner uses.
 */
export function psaToParsed(cert: PsaCert): ParsedSportsCard {
  const brandText = [cert.brand, cert.variety].filter(Boolean).join(' ')
  const variety = cert.variety ?? ''
  return {
    sport: psaSport(cert.category),
    year: cert.year,
    brand: detectBrand(brandText),
    product: detectProduct(brandText),
    player: cert.subject,
    number: cert.cardNumber,
    parallel: undefined,
    rookie: /\bRC\b|ROOKIE/i.test(variety) || undefined,
    auto: /\bAUTO/i.test(variety) || undefined,
    relic: /RELIC|PATCH|JERSEY/i.test(variety) || undefined,
    // A cert lookup is authoritative — this is the identity, not a guess.
    confidence: 1,
  }
}

function cacheKey(cert: string): string {
  return `psa-cert-${cert}`
}

/**
 * Look a cert number up. Cached hits never re-spend the daily allowance, and
 * every failure mode is reported rather than thrown so the scan path can just
 * carry on with what the label said.
 */
export async function psaLookup(cert: string, token: string, signal?: AbortSignal): Promise<PsaOutcome> {
  const trimmed = cert.replace(/\D/g, '')
  if (!trimmed) return { ok: false, reason: 'not-found', message: 'No certification number to look up' }
  if (!token.trim()) return { ok: false, reason: 'no-token', message: 'Add a PSA API token in Settings to resolve certs' }

  const cached = await kvGet<PsaCert>(cacheKey(trimmed), CERT_TTL_MS).catch(() => null)
  if (cached) return { ok: true, cert: cached }

  try {
    const payload = await fetchJson(`${ENDPOINT}/${encodeURIComponent(trimmed)}`, {
      headers: { Authorization: `bearer ${token.trim()}` },
      timeoutMs: 10_000,
      signal,
    })
    const record = normalizePsaCert(payload, trimmed)
    if (!record || (!record.subject && !record.brand && record.grade == null)) {
      return { ok: false, reason: 'not-found', message: `PSA has no record for cert ${trimmed}` }
    }
    kvPut(cacheKey(trimmed), record).catch(() => {})
    return { ok: true, cert: record }
  } catch (err) {
    if (isAbort(err)) return { ok: false, reason: 'unreachable', message: 'PSA lookup timed out' }
    const message = err instanceof Error ? err.message : String(err)
    if (/HTTP 401|HTTP 403/.test(message)) {
      return { ok: false, reason: 'unauthorized', message: 'PSA rejected the token — check it in Settings' }
    }
    if (/HTTP 429/.test(message)) {
      return { ok: false, reason: 'rate-limited', message: 'PSA daily lookup limit reached — the label was still read' }
    }
    // A CORS refusal surfaces here as an opaque network failure. Naming it is
    // the difference between a user thinking their token is wrong and knowing
    // the browser never got to use it.
    return { ok: false, reason: 'unreachable', message: `PSA lookup unavailable (${message})` }
  }
}

/** Forget cached certs — used by the "clear caches" path in Settings. */
export async function clearPsaCache(): Promise<void> {
  const rows = await db.cache.toCollection().primaryKeys()
  const certs = rows.filter((key): key is string => typeof key === 'string' && key.startsWith('psa-cert-'))
  if (certs.length) await db.cache.bulkDelete(certs)
}
