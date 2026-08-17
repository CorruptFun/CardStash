/**
 * Shared plumbing for the corpus sweeps: load the real matching layer with its
 * catalogs pointed at the corpus, prove nothing else can reach the network,
 * and write the two report shapes.
 *
 * The loader is `tests/unit/bundle.mjs` — the same esbuild+alias pattern the
 * unit tests use to run `src/` TypeScript in plain node. A second loader would
 * be a second definition of "what the app does".
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleImport } from '../unit/bundle.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const REPORT_DIR = join(HERE, 'report')

const stub = (name) => join(HERE, 'stubs', name)
/** The unit tests' own DOM stubs — reused, not re-cut. */
const unitStub = (name) => join(HERE, '..', 'unit', 'stubs', name)
const API_STUB = join(HERE, 'apistub.mjs')

/* ----------------------------------------------------------- the net floor */

/**
 * Nothing in a corpus sweep may touch a live game API — the corpus IS the
 * catalog, and a sweep that quietly fetched would be grading the internet.
 * `fetchJson` is aliased to the corpus stub, but `catalog.ts` reaches our own
 * project through the GLOBAL fetch, so the global is trapped too and the
 * sweeps assert the trap never fired. Same posture as the camera harness:
 * an unexpected host is a failed run, not a warning.
 */
export function sealNetwork() {
  const attempts = []
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    attempts.push(url)
    throw new Error(`corpus sweep: live network attempt blocked — ${url}`)
  }
  return attempts
}

/**
 * Politeness gaps, paid instantly.
 *
 * `scryfall.ts` serialises its requests behind a 100ms minimum gap — correct
 * against the real API and fatal here, where a full MTG sweep issues a million
 * lookups against memory. Only the WAIT is removed: the request chain still
 * serialises exactly as it does in production, so no ordering changes. Long
 * timers (fetch deadlines) pass through untouched.
 */
export function compressPoliteWaits(maxMs = 250) {
  const real = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (typeof ms === 'number' && ms <= maxMs) {
      setImmediate(() => fn(...args))
      return { unref() {}, ref() {}, [Symbol.toPrimitive]: () => 0 }
    }
    return real(fn, ms, ...args)
  }
  return () => {
    globalThis.setTimeout = real
  }
}

/* ------------------------------------------------------------ app modules */

/**
 * The matching layer, with three substitutions and no others:
 *   ./fetchJson → the corpus API stub (the catalogs)
 *   ./catalog   → an inert mirror (it would grade the corpus against itself)
 *   ./db        → no patches, no hand-typed cards (there is no user here)
 * Everything under test — cardsearch, scryfall, pokemon, ygo, cardcode,
 * util's scoring — is the shipped code, bundled unmodified.
 */
export async function loadMatchers() {
  const alias = { './fetchJson': API_STUB, './catalog': stub('catalog-off.mjs'), './db': stub('db-off.mjs') }
  const cardsearch = await bundleImport('src/lib/cardsearch.ts', { alias })
  const cardcode = await bundleImport('src/lib/cardcode.ts')
  const util = await bundleImport('src/lib/util.ts')
  const corner = await bundleImport('src/lib/corner.ts')
  // identify.ts owns the bar a scan answer must clear, and that bar is what
  // separates "a wrong card" from "a wrong card the user was shown". Bundled
  // for the real function rather than copied, so the two cannot drift.
  const identify = await bundleImport('src/lib/identify.ts', { alias: { ...alias, './camera': unitStub('camera-none.mjs') } })
  return { ...cardsearch, ...cardcode, ...util, ...corner, matchThresholdFor: identify.matchThresholdFor }
}

/* ---------------------------------------------------------------- sampling */

/**
 * A deterministic subset that still spans the whole corpus: every (total/n)-th
 * item of a stably sorted list. Taking the head instead would sample one
 * alphabetical corner and call it a corpus.
 */
export function sample(list, n) {
  if (!n || n >= list.length) return list
  const out = []
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)])
  return out
}

export function parseArgs(argv) {
  const args = argv.slice(2)
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
  return {
    sample: Number.parseInt(value('sample') ?? '0', 10) || 0,
    games: (value('games') ?? 'mtg,pokemon,yugioh').split(',').filter(Boolean),
    arms: (value('arms') ?? '').split(',').filter(Boolean),
    out: value('out') ?? null,
    exemplars: Number.parseInt(value('exemplars') ?? '3', 10),
    has: (name) => args.includes(`--${name}`),
  }
}

/* ---------------------------------------------------------------- counting */

/** A named tally that keeps a bounded exemplar list per bucket. */
export class Buckets {
  constructor(cap = 3) {
    this.cap = cap
    this.counts = new Map()
    this.exemplars = new Map()
  }

  add(bucket, exemplar) {
    this.counts.set(bucket, (this.counts.get(bucket) ?? 0) + 1)
    if (!exemplar) return
    let list = this.exemplars.get(bucket)
    if (!list) this.exemplars.set(bucket, (list = []))
    // Hard cap, and it is a CAP not a sample: the first N of a stable walk are
    // reproducible, where a reservoir would move between runs.
    if (list.length < this.cap) list.push(exemplar)
  }

  get total() {
    let n = 0
    for (const v of this.counts.values()) n += v
    return n
  }

  toJSON() {
    const out = {}
    for (const [bucket, count] of [...this.counts.entries()].sort((a, b) => b[1] - a[1])) {
      out[bucket] = { count, exemplars: this.exemplars.get(bucket) ?? [] }
    }
    return out
  }
}

/* --------------------------------------------------------------- reporting */

export function writeReport(name, payload, markdown) {
  mkdirSync(REPORT_DIR, { recursive: true })
  const json = join(REPORT_DIR, `${name}.json`)
  const md = join(REPORT_DIR, `${name}.md`)
  writeFileSync(json, `${JSON.stringify(payload, null, 2)}\n`)
  writeFileSync(md, markdown)
  return { json, md }
}

export function mdTable(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')
}

export function pct(part, whole) {
  return whole ? `${((100 * part) / whole).toFixed(2)}%` : '—'
}
