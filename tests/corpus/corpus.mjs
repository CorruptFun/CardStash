/**
 * The corpus: every card the three bulk sources publish, in memory, as the
 * catalog the matcher sweeps run against.
 *
 * The camera harness samples ~40 photographed cards. This samples nothing —
 * it loads Scryfall's `default_cards`, TCGdex's English sets and YGOPRODeck's
 * `cardinfo.php` and drives the matching layer over all of them, because the
 * bug class it hunts (a name that matches a DIFFERENT card with confidence)
 * is a property of the catalog's shape, not of any one photograph.
 *
 * Three rules this file exists to keep:
 *
 * - **Downloads are cached and checked before they are made.** A sibling agent
 *   shares CORPUS_CACHE, so a file already there — or being written by
 *   somebody else right now — is waited for, never re-fetched. Politeness
 *   numbers are `scripts/sync-catalog.mjs`'s own (Scryfall wants a
 *   User-Agent and 50–100ms between requests, TCGdex 150ms between sets,
 *   YGOPRODeck is one request).
 * - **The mappers are the sync script's, not new ones.** `parseBulkLine`,
 *   `scryfallToRows`, `isPaperDexSet`, `dexSetToRows` and `ygoToRows` are
 *   imported from `scripts/sync-catalog.mjs` verbatim. A second copy of "what
 *   counts as a printing" would drift from the mirror the app actually reads.
 * - **Rows are compact and raws are synthesized on demand.** 200k+ printings
 *   live here as five-field objects; the API-shaped JSON each stub answers
 *   with is built per request from the row and thrown away. Holding the
 *   sources' own JSON would multiply the corpus by ten for no extra evidence.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

import { dexSetToRows, isPaperDexSet, parseBulkLine, scryfallToRows, ygoToRows } from '../../scripts/sync-catalog.mjs'

export const CORPUS_CACHE =
  process.env.CORPUS_CACHE ??
  '/private/tmp/claude-502/-Users-lucid-Creative-CardStash/0518304a-508a-4ac1-b5c5-08b13e32fb9e/scratchpad/corpus-cache'

const SCRYFALL_BULK = 'https://api.scryfall.com/bulk-data'
const DEX_BASE = 'https://api.tcgdex.net/v2/en'
const YGO_API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'

/** Same convention as the sync script: a bulk consumer says who it is. */
const UA = 'CardstockCorpusSweep/1.0 (+https://github.com/CorruptFun/CardStash)'
const DEX_GAP_MS = 150

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ------------------------------------------------------------- cache layer */

function cachePath(name) {
  mkdirSync(CORPUS_CACHE, { recursive: true })
  return join(CORPUS_CACHE, name)
}

/**
 * Is somebody else writing this file right now?
 *
 * The cache is shared with a sibling agent, so a half-finished `.part` beside
 * the name we want is normal rather than exceptional. Growing means alive:
 * wait for it. Stalled means abandoned: take over. Waiting on a dead partial
 * for ever is the failure mode this exists to avoid.
 */
async function waitForForeignPart(finalPath, log) {
  const dir = CORPUS_CACHE
  const base = finalPath.slice(dir.length + 1)
  let lastSize = -1
  let stalls = 0
  for (let i = 0; i < 120; i++) {
    if (existsSync(finalPath)) return true
    const parts = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith(base) && f.endsWith('.part'))
    if (!parts.length) return false
    const size = parts.reduce((sum, f) => sum + (statSync(join(dir, f), { throwIfNoEntry: false })?.size ?? 0), 0)
    if (size > lastSize) {
      if (i === 0 || i % 10 === 0) log?.(`  waiting on a sibling's ${base} (${(size / 1e6).toFixed(0)} MB so far)…`)
      stalls = 0
    } else if (++stalls >= 4) {
      log?.(`  sibling's ${base} stalled at ${(size / 1e6).toFixed(0)} MB — downloading our own`)
      return false
    }
    lastSize = size
    await sleep(5_000)
  }
  return existsSync(finalPath)
}

/**
 * A cached download. Check, wait, then fetch — in that order, always.
 * The fetch writes to a pid-suffixed partial and renames, so a reader can
 * never see a half file and two writers can never corrupt each other.
 */
async function cached(name, fetchTo, { log } = {}) {
  const finalPath = cachePath(name)
  if (existsSync(finalPath) && statSync(finalPath).size > 0) {
    log?.(`  cache hit ${name} (${(statSync(finalPath).size / 1e6).toFixed(1)} MB)`)
    return finalPath
  }
  if (await waitForForeignPart(finalPath, log)) {
    log?.(`  cache hit ${name} (sibling finished it)`)
    return finalPath
  }
  const partial = `${finalPath}.${process.pid}.part`
  await fetchTo(partial)
  renameSync(partial, finalPath)
  return finalPath
}

async function getJson(url, what) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
  return res.json()
}

async function cachedJson(name, url, what, opts) {
  const path = await cached(
    name,
    async (partial) => {
      const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } })
      if (!res.ok || !res.body) throw new Error(`${what}: HTTP ${res.status}`)
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partial))
    },
    opts,
  )
  return JSON.parse(readFileSync(path, 'utf8'))
}

/* --------------------------------------------------------------- downloads */

/**
 * Scryfall's bulk `default_cards`. Streamed on both legs — the inflated file
 * is larger than the biggest string Node can make, which is the lesson
 * `scripts/sync-catalog.mjs` learned the hard way and this file inherits.
 */
async function scryfallBulkPath(log) {
  const index = await cachedJson('scryfall-bulk-index.json', SCRYFALL_BULK, 'scryfall bulk index', { log })
  const list = Array.isArray(index?.data) ? index.data : []
  const entry = list.find((b) => b?.type === 'default_cards') ?? list.find((b) => /default/i.test(String(b?.type ?? '')))
  const uri = entry?.download_uri ?? entry?.jsonl_download_uri
  if (!uri) throw new Error(`scryfall: no default_cards entry among [${list.map((b) => b?.type).join(', ') || 'nothing'}]`)
  const gz = uri.endsWith('.gz')
  return {
    gz,
    path: await cached(
      gz ? 'default-cards.jsonl.gz' : 'default-cards.json',
      async (partial) => {
        log?.(`  downloading ${uri} (~${Math.round((entry.size ?? entry.compressed_size ?? 0) / 1e6)} MB)…`)
        const res = await fetch(uri, { headers: { 'User-Agent': UA } })
        if (!res.ok || !res.body) throw new Error(`scryfall default_cards: HTTP ${res.status}`)
        await pipeline(Readable.fromWeb(res.body), createWriteStream(partial))
      },
      { log },
    ),
  }
}

/**
 * TCGdex's English paper sets, one cached file each. Per-set caching is what
 * makes an interrupted load resumable: the 150ms courtesy gap only has to be
 * paid for the sets we do not already hold.
 */
async function dexSets(log) {
  const briefs = (await cachedJson('tcgdex-sets.json', `${DEX_BASE}/sets`, 'tcgdex sets', { log })).filter((s) =>
    isPaperDexSet(s?.id),
  )
  log?.(`  ${briefs.length} paper sets`)
  const sets = []
  let fetched = 0
  for (const brief of briefs) {
    const name = `tcgdex-set-${String(brief.id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`
    if (!existsSync(cachePath(name))) {
      await sleep(DEX_GAP_MS)
      fetched++
    }
    const set = await cachedJson(name, `${DEX_BASE}/sets/${encodeURIComponent(brief.id)}`, `tcgdex set ${brief.id}`).catch(
      (err) => {
        log?.(`  tcgdex ${brief.id}: ${err.message} — skipped`)
        return null
      },
    )
    if (set?.id) sets.push(set)
  }
  log?.(`  ${sets.length} sets loaded (${fetched} fetched, ${sets.length - fetched} cached)`)
  return sets
}

/* ------------------------------------------------------------- text search */

/**
 * A trigram posting index over normalized names, so the substring endpoints
 * (`fname=` on YGOPRODeck, `?name=` on TCGdex — both documented as `contains`
 * filters) answer in roughly constant time instead of scanning 60k names per
 * query. The rarest trigram's posting list is the candidate set; membership
 * is then decided by a real `includes`, so the index only ever narrows.
 */
class SubstringIndex {
  constructor(norms) {
    this.norms = norms
    this.grams = new Map()
    for (let i = 0; i < norms.length; i++) {
      const s = norms[i]
      const seen = new Set()
      for (let j = 0; j + 3 <= s.length; j++) {
        const g = s.slice(j, j + 3)
        if (seen.has(g)) continue
        seen.add(g)
        let list = this.grams.get(g)
        if (!list) this.grams.set(g, (list = []))
        list.push(i)
      }
    }
  }

  /** Indexes of every name CONTAINING `query` (already normalized). */
  find(query) {
    if (query.length < 3) {
      const out = []
      for (let i = 0; i < this.norms.length; i++) if (this.norms[i].includes(query)) out.push(i)
      return out
    }
    let rarest = null
    for (let j = 0; j + 3 <= query.length; j++) {
      const list = this.grams.get(query.slice(j, j + 3))
      if (!list) return []
      if (!rarest || list.length < rarest.length) rarest = list
    }
    const out = []
    for (const i of rarest) if (this.norms[i].includes(query)) out.push(i)
    return out
  }
}

/**
 * A word-prefix index: every WORD of every name, sorted, so "all of the
 * query's words prefix some word of the target" can be answered without
 * walking the name list.
 *
 * This is Scryfall's fuzzy resolver's shape, and it is the sweep's hottest
 * path by an order of magnitude — a corrupted name misses the exact and
 * substring tiers and lands here every single time. Walking 37k names per
 * query turned the MTG sweep into an overnight job; picking the query word
 * with the SMALLEST prefix range and checking only those candidates turns it
 * back into minutes.
 */
class WordPrefixIndex {
  constructor(entries) {
    this.entries = entries
    this.words = []
    for (let i = 0; i < entries.length; i++) for (const w of entries[i].words) this.words.push([w, i])
    this.words.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]))
  }

  /** [lo, hi) over `words` whose word starts with `prefix`. */
  range(prefix) {
    const lower = (target) => {
      let lo = 0
      let hi = this.words.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.words[mid][0] < target) lo = mid + 1
        else hi = mid
      }
      return lo
    }
    // The prefix's successor bounds the range: everything between them starts
    // with it. `￿` is above any character a normalized name can hold.
    return [lower(prefix), lower(`${prefix}￿`)]
  }

  /** Entry indexes whose words prefix-cover every query word; caps at `max`. */
  coveringAll(queryWords, max = 2) {
    if (!queryWords.length) return []
    let narrowest = null
    for (const word of queryWords) {
      const [lo, hi] = this.range(word)
      if (hi === lo) return []
      if (!narrowest || hi - lo < narrowest[1] - narrowest[0]) narrowest = [lo, hi]
    }
    const seen = new Set()
    const out = []
    for (let i = narrowest[0]; i < narrowest[1]; i++) {
      const at = this.words[i][1]
      if (seen.has(at)) continue
      seen.add(at)
      const target = this.entries[at].words
      if (queryWords.every((w) => target.some((t) => t.startsWith(w)))) {
        out.push(at)
        if (out.length > max) return out
      }
    }
    return out
  }
}

/** The app's own normalizer, replicated here ONLY for indexing (util.ts). */
function norm(name) {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * One game's name space: unique names, each remembering one representative
 * printing. The sweeps walk NAMES, not printings — the name path never sees a
 * collector number, so sweeping 105k MTG printings would re-ask 30k questions
 * three times each and report the same answer.
 */
function nameSpace(prints, nameOf = (p) => p.name) {
  const byNorm = new Map()
  for (const print of prints) {
    const name = nameOf(print)
    if (!name) continue
    const key = norm(name)
    if (!key) continue
    let entry = byNorm.get(key)
    // Each entry keeps its own printings. The API stub answers name queries
    // out of these lists rather than re-filtering the whole game every time —
    // a linear scan per query turns a 100k-name sweep into an O(n²) one.
    if (!entry) byNorm.set(key, (entry = { name, norm: key, sample: print, prints: 0, rows: [], words: key.split(' ') }))
    entry.prints++
    entry.rows.push(print)
  }
  const list = [...byNorm.values()].sort((a, b) => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0))
  return { byNorm, list, index: new SubstringIndex(list.map((e) => e.norm)), prefixes: new WordPrefixIndex(list) }
}

/* ------------------------------------------------------------------ indexes */
/* Shared by the bulk loaders and by `corpusFromFixture`, so a 20-card test
 * corpus and a 170k-printing one are the same object to everything above.   */

function indexMtg(prints) {
  const byId = new Map()
  const byCode = new Map()
  const setSizes = new Map()
  for (const p of prints) {
    byId.set(p.apiId, p)
    // Scryfall lowercases collector numbers in its own URLs; the corpus keys
    // the same way so `/cards/neo/266A` and `/cards/neo/266a` are one lookup.
    byCode.set(`${p.set}/${p.number.toLowerCase()}`, p)
    setSizes.set(p.set, (setSizes.get(p.set) ?? 0) + 1)
  }
  return { game: 'mtg', prints, byId, byCode, setSizes, names: nameSpace(prints) }
}

function indexPokemon(prints, sets) {
  const byId = new Map()
  const byCode = new Map()
  for (const p of prints) {
    byId.set(p.rawId, p)
    byCode.set(`${p.set.toLowerCase()}/${digitsOf(p.number)}`, p)
  }
  return { game: 'pokemon', prints, byId, byCode, sets, names: nameSpace(prints) }
}

/** Raw YGOPRODeck cards in, indexes out — `ygoToRows` does the printing split. */
function indexYugioh(rawCards) {
  const cards = new Map()
  const prints = []
  const byCode = new Map()
  for (const card of rawCards) {
    const id = String(card?.id ?? '')
    if (!id || !card?.name) continue
    // Trimmed to what `toCard` in ygo.ts actually reads. `desc` is dropped:
    // it is the single largest field in the feed and nothing in the matching
    // layer looks at it.
    cards.set(id, {
      id,
      name: card.name,
      type: String(card.type ?? 'Effect Monster'),
      atk: card.atk,
      def: card.def,
      level: card.level,
      race: card.race,
      attribute: card.attribute,
      card_sets: (card.card_sets ?? []).map((s) => ({
        set_name: s?.set_name,
        set_code: s?.set_code,
        set_rarity: s?.set_rarity,
        set_price: s?.set_price,
      })),
      card_prices: card.card_prices?.slice(0, 1) ?? [],
      card_images: card.card_images?.slice(0, 1) ?? [],
    })
    for (const row of ygoToRows(card)) {
      if (!row.collector_number) continue
      const printed = `${row.set_code}-${row.collector_number}`.toUpperCase()
      prints.push({ apiId: id, name: row.name, set: row.set_code, number: row.collector_number, printed, rarity: row.rarity })
      // First writer wins, as YGOPRODeck's own set-code endpoint answers with
      // one card id per code.
      if (!byCode.has(printed)) byCode.set(printed, { id, printed })
    }
  }
  const nameList = [...cards.values()].map((c) => ({ name: c.name, id: c.id }))
  return {
    game: 'yugioh',
    cards,
    prints,
    byCode,
    byExactName: new Map(nameList.map((c) => [c.name.toLowerCase(), c.id])),
    names: nameSpace(nameList),
  }
}

/**
 * A corpus from literal rows instead of 100 MB of bulk downloads — what the
 * unit tests run against, and the only way to assert the harness's own
 * behaviour on a catalog small enough to reason about by hand.
 *
 * Same index builders as the real loaders, on purpose: a fixture corpus that
 * were built by a second code path would prove things about that path.
 */
export function corpusFromFixture(fixture) {
  const corpus = { loadedAt: Date.now() }
  if (fixture.mtg) corpus.mtg = indexMtg(fixture.mtg)
  if (fixture.pokemon) {
    const sets = new Map((fixture.pokemon.sets ?? []).map((s) => [s.id, s]))
    corpus.pokemon = indexPokemon(
      fixture.pokemon.prints.map((p) => ({ ...p, rawId: p.rawId ?? p.apiId.replace(/^dex-/, '') })),
      sets,
    )
  }
  if (fixture.yugioh) corpus.yugioh = indexYugioh(fixture.yugioh)
  globalThis.__CARDSTOCK_CORPUS__ = corpus
  return corpus
}

/* ------------------------------------------------------------------ loaders */

async function loadMtg(log) {
  const { path, gz } = await scryfallBulkPath(log)
  const prints = []
  const file = createReadStream(path)
  const lines = readline.createInterface({ input: gz ? file.pipe(createGunzip()) : file, crlfDelay: Infinity })
  let batch = []
  const drain = () => {
    for (const row of scryfallToRows(batch)) {
      prints.push({
        apiId: row.api_id,
        name: row.name,
        set: row.set_code.toLowerCase(),
        number: String(row.collector_number ?? ''),
        rarity: row.rarity,
      })
    }
    batch = []
  }
  for await (const line of lines) {
    const card = parseBulkLine(line)
    if (!card) continue
    batch.push(card)
    if (batch.length >= 2000) drain()
  }
  drain()
  const indexed = indexMtg(prints)
  log?.(`  mtg: ${prints.length} printings, ${indexed.setSizes.size} sets`)
  return indexed
}

async function loadPokemon(log) {
  const sets = await dexSets(log)
  const prints = []
  const setTable = new Map()
  for (const set of sets) {
    const rows = dexSetToRows(set)
    if (!rows.length) continue
    setTable.set(String(set.id), {
      id: String(set.id),
      name: set.name ?? String(set.id),
      official: Number(set.cardCount?.official) || null,
      total: Number(set.cardCount?.total) || null,
      releaseDate: typeof set.releaseDate === 'string' ? set.releaseDate : '',
      // TCGdex publishes no PTCGO code; the corpus says so rather than
      // inventing one, and the sweeps record which arm that leaves unfed.
      ptcgoCode: typeof set.abbreviation?.official === 'string' ? set.abbreviation.official : null,
    })
    for (const row of rows) {
      // `dex-<id>`; the bare TCGdex/pokemontcg.io id is what both APIs key on.
      const dexId = row.api_id.slice('dex-'.length)
      prints.push({
        apiId: row.api_id,
        rawId: dexId,
        name: row.name,
        set: String(set.id),
        number: String(row.collector_number ?? ''),
        rarity: row.rarity,
      })
    }
  }
  log?.(`  pokemon: ${prints.length} printings, ${setTable.size} sets`)
  return indexPokemon(prints, setTable)
}

const digitsOf = (value) =>
  String(value ?? '')
    .replace(/\D+/g, '')
    .replace(/^0+(?=\d)/, '')

async function loadYugioh(log) {
  const payload = await cachedJson('ygoprodeck-cardinfo.json', YGO_API, 'ygoprodeck cardinfo', { log })
  const indexed = indexYugioh(Array.isArray(payload?.data) ? payload.data : [])
  log?.(`  yugioh: ${indexed.cards.size} cards, ${indexed.prints.length} printings`)
  return indexed
}

/* -------------------------------------------------------------------- entry */

export const CORPUS_GAMES = ['mtg', 'pokemon', 'yugioh']

/**
 * Load the games asked for and publish them on `globalThis` for the API stub.
 *
 * The stub is INLINED into each esbuild bundle (`bundleImport` has no
 * `external` for path aliases), so a module-scope singleton would give every
 * bundle its own empty copy. A global is the one place both the bundled copy
 * and this process can see.
 */
export async function loadCorpus(games = CORPUS_GAMES, { log = console.log } = {}) {
  const corpus = { loadedAt: Date.now() }
  for (const game of games) {
    log?.(`corpus: loading ${game}…`)
    const started = Date.now()
    corpus[game] = game === 'mtg' ? await loadMtg(log) : game === 'pokemon' ? await loadPokemon(log) : await loadYugioh(log)
    log?.(`  ${game} ready in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  }
  globalThis.__CARDSTOCK_CORPUS__ = corpus
  return corpus
}

/** What the corpus actually contains — asserted before anything is measured. */
export function corpusInventory(corpus) {
  const out = {}
  for (const game of CORPUS_GAMES) {
    const c = corpus[game]
    if (!c) continue
    out[game] = {
      printings: game === 'yugioh' ? c.prints.length : c.prints.length,
      names: c.names.list.length,
      sets: game === 'mtg' ? c.setSizes.size : game === 'pokemon' ? c.sets.size : new Set(c.prints.map((p) => p.set)).size,
    }
    if (game === 'pokemon') {
      out[game].setsWithPtcgoCode = [...c.sets.values()].filter((s) => s.ptcgoCode).length
      out[game].setsWithOfficialSize = [...c.sets.values()].filter((s) => s.official).length
    }
  }
  return out
}

export { norm, digitsOf }

/* Prefetch entry: warm the shared cache and print what it holds. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const games = (process.argv.find((a) => a.startsWith('--games='))?.split('=')[1] ?? CORPUS_GAMES.join(',')).split(',')
  const corpus = await loadCorpus(games)
  console.log(JSON.stringify(corpusInventory(corpus), null, 2))
  // Explicit: a node process that merely finishes waits on whatever half-open
  // sockets the bulk hosts left behind (scan-harness lesson 81).
  process.exit(0)
}
