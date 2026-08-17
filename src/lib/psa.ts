/**
 * PSA cert lookup — the one free, official identity service sports cards have.
 *
 * PSA publishes a public API whose single useful job is exactly the one we
 * need: hand it a certification number off a slab label and it returns what
 * PSA graded — year, brand, subject, card number, grade, sport, population.
 * That turns a slab scan from "we read some words" into an exact card.
 *
 * The token is **ours**, compiled in from `VITE_PSA_TOKEN`, so cert lookup
 * works out of the box with nothing for the user to configure. An empty value
 * makes the whole module dormant — the same shape `drive.ts` uses for its
 * OAuth client id — and slab scanning still works off the printed label.
 *
 * It is strictly an ENHANCEMENT and never a dependency: the label alone
 * already yields the grade, the cert and usually the whole card, so a refused,
 * rate-limited or unreachable API downgrades the scan rather than breaking it.
 *
 * ## Read this before relying on it
 *
 * Unlike the other two values this app compiles in, **a PSA token is not
 * designed to be public.** The Google OAuth client id is protected by its
 * origin allowlist and the Supabase publishable key by row-level security;
 * both are safe in a bundle because something else is the actual boundary. A
 * bearer token has no such backstop: it ships in a static gh-pages bundle,
 * anyone can read it out, and it authorises calls against our PSA account.
 *
 * The practical consequence is the quota. PSA's free tier is roughly 100 calls
 * a DAY for the account, now shared across every user of the app rather than
 * per-person, so it is exhausted by ordinary traffic long before it is
 * exhausted by abuse. Two mitigations live here — certs are cached for months
 * (`CERT_TTL_MS`) so a re-scan is free, and a 429 stops all further calls for
 * `QUOTA_COOLDOWN_MS` instead of hammering a dead quota — but neither changes
 * the arithmetic. The real fix exists: `supabase/functions/psa-proxy` holds
 * the token server-side (the `PSA_TOKEN` secret), and a build with
 * `VITE_PSA_ENDPOINT` pointed at it ships **no token at all** — this module
 * then calls the proxy with no headers whatsoever. The quota stays one shared
 * allowance either way; the proxy changes who can read the credential, not
 * the arithmetic.
 *
 * One more caveat for debugging in the wild: PSA's own API is not documented
 * as CORS-enabled for browser origins. If PSA does not send the header, a
 * direct call fails in the page no matter how valid the token is — the proxy
 * sends explicit CORS headers, which is the other problem it solves. That is
 * why the failure path is a first-class outcome here — see `PsaOutcome`.
 */

import { db, kvGet, kvPut } from './db'
import { fetchJson, isAbort } from './fetchJson'
import { detectBrand, detectProduct } from './sportsparse'
import type { ParsedSportsCard } from './sportsparse'
import type { Sport } from './types'

const env = (import.meta.env ?? {}) as Record<string, string | undefined>

/**
 * Our PSA token, compiled in at build time. Only the direct-to-PSA shape
 * needs it; the proxy shape below ships without one. With neither value set,
 * this module never contacts anyone at all.
 */
const PSA_TOKEN: string = (env.VITE_PSA_TOKEN ?? '').trim()

/**
 * Our proxy (`supabase/functions/psa-proxy`), when the build sets one. The
 * proxy holds the real token server-side, so with this set no
 * `VITE_PSA_TOKEN` needs to exist — and none is sent: the request goes out
 * with no headers at all, which keeps this module ignorant of what hosts the
 * endpoint and keeps the GET a CORS simple request.
 */
const PSA_PROXY: string = (env.VITE_PSA_ENDPOINT ?? '').trim().replace(/\/+$/, '')

/** Whether this build can resolve certs — a token of its own, or a proxy holding ours. */
export const PSA_AVAILABLE: boolean = Boolean(PSA_TOKEN) || Boolean(PSA_PROXY)

const ENDPOINT = PSA_PROXY || 'https://api.psacard.com/publicapi/cert/GetByCertNumber'

/** A cert's grade never changes, so a hit is good essentially forever. */
const CERT_TTL_MS = 180 * 86_400_000
/**
 * How long a quota refusal stands everyone down. PSA's limit is daily, but
 * pinning this to midnight would assume their reset boundary; a few hours is
 * long enough to stop pointless traffic and short enough to recover the same
 * day. Slab scanning is unaffected either way — only cert resolution pauses.
 */
const QUOTA_COOLDOWN_MS = 6 * 3_600_000
const QUOTA_KEY = 'psa-quota-block'

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
  | {
      ok: false
      reason: 'not-configured' | 'not-found' | 'unauthorized' | 'rate-limited' | 'unreachable'
      message: string
    }

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
export async function psaLookup(cert: string, signal?: AbortSignal): Promise<PsaOutcome> {
  const trimmed = cert.replace(/\D/g, '')
  if (!trimmed) return { ok: false, reason: 'not-found', message: 'No certification number to look up' }
  if (!PSA_AVAILABLE) return { ok: false, reason: 'not-configured', message: 'This build has no PSA cert lookup' }

  const cached = await kvGet<PsaCert>(cacheKey(trimmed), CERT_TTL_MS).catch(() => null)
  if (cached) return { ok: true, cert: cached }

  // The quota is one shared allowance, so once it is gone it is gone for
  // everyone — keep making the request and every slab scan pays the latency
  // of a call that cannot succeed.
  const blocked = await kvGet<boolean>(QUOTA_KEY, QUOTA_COOLDOWN_MS).catch(() => null)
  if (blocked) {
    return { ok: false, reason: 'rate-limited', message: 'Cert lookup is at its daily limit — the label was still read' }
  }

  try {
    const payload = await fetchJson(`${ENDPOINT}/${encodeURIComponent(trimmed)}`, {
      // Direct PSA needs the bearer. The proxy must NOT get it: the point of
      // the proxy build is that no token ships, and even when both values are
      // configured a credential does not belong in requests to another host.
      headers: PSA_PROXY ? undefined : { Authorization: `bearer ${PSA_TOKEN}` },
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
      // Ours, not theirs — the user has nothing to fix, so do not send them
      // looking for a setting that no longer exists.
      return { ok: false, reason: 'unauthorized', message: 'Cert lookup is unavailable right now' }
    }
    if (/HTTP 429/.test(message)) {
      kvPut(QUOTA_KEY, true).catch(() => {})
      return { ok: false, reason: 'rate-limited', message: 'Cert lookup is at its daily limit — the label was still read' }
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
  await db.cache.delete(QUOTA_KEY)
}
