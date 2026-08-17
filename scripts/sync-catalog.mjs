/**
 * Populate the catalog mirror (supabase/migrations/0021) from the three bulk
 * sources, and fill in artwork fingerprints. Operator-run with the service
 * key — this script is the ONLY writer the table has; the app never writes it.
 *
 *   SUPABASE_SECRET=sb_secret_… node scripts/sync-catalog.mjs                 # ingest all three
 *   … --source=mtg,yugioh                                                     # a subset
 *   … --sets=12                                                               # cap Pokémon sets (politeness / smoke)
 *   … --dry-run                                                               # map and count, write nothing
 *   … --hash --limit=500                                                      # fingerprint pass (resumable)
 *   … --stats                                                                 # rows + hash coverage + one anon lookup
 *
 * Node on purpose, not Python: the repo is all Node, the fixtures fetcher
 * already speaks these APIs politely, and — the part that actually matters —
 * the artwork hash MUST be computed by the same code the client runs, or the
 * distances mean nothing. The --hash pass bundles src/lib/vision.ts with
 * esbuild and runs the real `cardArtHash` in headless Chromium (both already
 * dev dependencies), so catalog-side and capture-side fingerprints can never
 * drift apart.
 *
 * Sources and the id contract (see the migration header):
 *   mtg      Scryfall bulk "default_cards"  → api_id = Scryfall uuid
 *   pokemon  TCGdex en sets                 → api_id = dex-<id> (dexApiId, en shape)
 *   yugioh   YGOPRODeck cardinfo.php        → api_id = passcode, one row per printing
 *
 * Rate limits: Scryfall asks 50-100ms between requests (bulk is ONE request);
 * TCGdex gets 150ms between set fetches; YGOPRODeck is one request. Upserts
 * batch 500 rows with a small gap. Re-running is safe and is the update
 * story: on_conflict merges, updated_at moves, hashes stay.
 */

import readline from 'node:readline'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'

const SUPABASE_URL = (process.env.SUPABASE_URL ?? 'https://xvfuyvaehtdxroyzixak.supabase.co').replace(/\/+$/, '')
const SECRET = process.env.SUPABASE_SECRET

const SCRYFALL_BULK = 'https://api.scryfall.com/bulk-data'
const DEX_API = 'https://api.tcgdex.net/v2/en'
const YGO_API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php'

const UPSERT_BATCH = 500
const UPSERT_GAP_MS = 120
const DEX_GAP_MS = 150

/* ------------------------------------------------------------ pure mappers */
/* Exported for tests/unit/catalog.test.mjs — keep them free of I/O.         */

const clip = (value, max) => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s ? s.slice(0, max) : null
}

const price = (value) => {
  const n = typeof value === 'string' ? Number.parseFloat(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null
}

const httpsUrl = (value) => {
  const s = clip(value, 500)
  return s && s.startsWith('https://') ? s : null
}

function row(game, apiId, name, rest = {}) {
  if (!apiId || !name) return null
  return {
    game,
    api_id: String(apiId).slice(0, 120),
    name: name.slice(0, 200),
    slug: name.toLowerCase().trim().slice(0, 200),
    set_code: rest.setCode ?? '',
    collector_number: rest.number ?? null,
    rarity: rest.rarity ?? null,
    language: 'en',
    image_url: rest.imageUrl ?? null,
    price_usd: rest.priceUsd ?? null,
  }
}

/**
 * One line of a bulk download as an object, or null. Tolerant of both eras:
 * a JSON Lines row (the jsonl_download_uri shape Scryfall ships now), and a
 * pretty-printed array's element line with its trailing comma or bare
 * brackets (the old download_uri shape). A malformed line — the classic cut
 * short final row — loses itself, never the file. Line-wise ON PURPOSE:
 * default_cards inflates past Node's maximum string length, so the whole
 * payload can never be held as one string, only streamed.
 */
export function parseBulkLine(line) {
  let t = String(line ?? '').trim()
  if (!t || t === '[' || t === ']') return null
  if (t.endsWith(',')) t = t.slice(0, -1)
  if (!t.startsWith('{')) return null
  try {
    const parsed = JSON.parse(t)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** Scryfall default_cards: paper English printings with a picture. */
export function scryfallToRows(cards) {
  const rows = []
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card?.lang !== 'en' || card?.digital) continue
    const image = httpsUrl(card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal)
    const mapped = row('mtg', card.id, clip(card.name, 200), {
      setCode: (clip(card.set, 24) ?? '').toUpperCase(),
      number: clip(card.collector_number, 24),
      rarity: clip(card.rarity, 40),
      imageUrl: image,
      priceUsd: price(card.prices?.usd),
    })
    if (mapped) rows.push(mapped)
  }
  return rows
}

/**
 * TCGdex indexes TCG Pocket beside paper (set ids A1/B1/P-A…); its digital
 * frames print no collector line and must not enter a mirror that exists to
 * answer printed codes — same filter the fixtures fetcher applies.
 */
export function isPaperDexSet(setId) {
  return !/^(?:[AB]\d|P-A)/i.test(String(setId ?? ''))
}

/** One TCGdex set payload (with its cards array) into mirror rows. */
export function dexSetToRows(set) {
  const rows = []
  if (!set?.id || !isPaperDexSet(set.id)) return rows
  for (const card of Array.isArray(set.cards) ? set.cards : []) {
    const name = clip(card?.name, 200)
    // dexApiId('en', id) in pokemon.ts — the en shape, verbatim.
    const mapped = row('pokemon', card?.id ? `dex-${card.id}` : null, name, {
      setCode: (clip(set.id, 24) ?? '').toUpperCase(),
      number: clip(String(card?.localId ?? ''), 24),
      imageUrl: card?.image ? httpsUrl(`${card.image}/high.webp`) : null,
    })
    if (mapped) rows.push(mapped)
  }
  return rows
}

/**
 * One YGOPRODeck card into one row PER PRINTING. The passcode covers every
 * reprint (it is the app's apiId), so set_code is what tells rows apart —
 * split the printed code ("BLMR-EN085") at its first dash into the set half
 * and the collector half, which is how cardcode.ts parses what people type.
 */
export function ygoToRows(card) {
  const rows = []
  const name = clip(card?.name, 200)
  const image = httpsUrl(card?.card_images?.[0]?.image_url)
  const sets = Array.isArray(card?.card_sets) && card.card_sets.length ? card.card_sets : [null]
  for (const printing of sets) {
    const code = clip(printing?.set_code, 49)
    const dash = code?.indexOf('-') ?? -1
    const mapped = row('yugioh', card?.id, name, {
      setCode: (dash > 0 ? code.slice(0, dash) : (code ?? '')).slice(0, 24).toUpperCase(),
      number: dash > 0 ? code.slice(dash + 1).slice(0, 24) : null,
      rarity: clip(printing?.set_rarity, 40),
      imageUrl: image,
      priceUsd: price(printing?.set_price),
    })
    if (mapped) rows.push(mapped)
  }
  // Reprints of one passcode share art: hash once, serve every row.
  return rows
}

/* --------------------------------------------------------------- transport */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Scryfall REJECTS anonymous requests: no User-Agent means HTTP 400 (their
 * API guidelines require one), which the first CI dry-run found the hard
 * way. Same convention as the fixtures fetcher, and sent everywhere — the
 * other sources don't require it, but a bulk consumer should say who it is.
 */
const UA = 'CardstockCatalogSync/1.0 (+https://github.com/CorruptFun/CardStash)'

async function getJson(url, what) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } })
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`)
  return res.json()
}

function serviceHeaders() {
  return { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
}

async function upsert(rows, dryRun) {
  if (dryRun || !rows.length) return
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/catalog_printings?on_conflict=game,api_id,set_code`, {
      method: 'POST',
      headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch.map((r) => ({ ...r, updated_at: new Date().toISOString() }))),
    })
    if (!res.ok) throw new Error(`upsert: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`)
    if (i + UPSERT_BATCH < rows.length) await sleep(UPSERT_GAP_MS)
  }
}

/* ----------------------------------------------------------------- ingest */

async function ingestMtg(dryRun) {
  const bulk = await getJson(SCRYFALL_BULK, 'scryfall bulk index')
  // The index is documented as {data:[{type,…}]} but the exact vocabulary is
  // the server's to change — so match generously and, when nothing matches,
  // FAIL NAMING WHAT WAS THERE: this script's errors are read in CI logs
  // where the live response cannot be poked at by hand. (That diagnostic is
  // how the first runs found the User-Agent rule and the move from
  // download_uri to jsonl_download_uri.)
  const list = Array.isArray(bulk?.data) ? bulk.data : Array.isArray(bulk) ? bulk : []
  const entry =
    list.find((b) => b?.type === 'default_cards') ??
    list.find((b) => /default/i.test(String(b?.type ?? b?.name ?? '')))
  const uri = entry?.download_uri ?? entry?.jsonl_download_uri
  if (!uri)
    throw new Error(
      `scryfall: no default_cards bulk entry among [${list.map((b) => b?.type ?? b?.name).join(', ') || 'nothing'}]` +
        (entry ? ` (entry keys: ${Object.keys(entry).join(',')})` : ` (index keys: ${Object.keys(bulk ?? {}).join(',')})`),
    )
  const size = entry.size ?? entry.compressed_size ?? 0
  console.log(`mtg: downloading ${uri} (~${Math.round(size / 1e6)} MB)…`)
  const res = await fetch(uri, { headers: { 'User-Agent': UA } })
  if (!res.ok || !res.body) throw new Error(`scryfall default_cards: HTTP ${res.status}`)
  // Streamed, not buffered: the inflated file is bigger than the largest
  // string Node can make (the third CI dry-run proved it the hard way), so
  // gunzip and split as it arrives and keep only the mapped rows. A .gz
  // SUFFIX means gzip bytes; a plain body's Content-Encoding is already
  // undone by fetch itself.
  const body = Readable.fromWeb(res.body)
  const lines = readline.createInterface({
    input: uri.endsWith('.gz') ? body.pipe(createGunzip()) : body,
    crlfDelay: Infinity,
  })
  const rows = []
  let batch = []
  for await (const line of lines) {
    const card = parseBulkLine(line)
    if (!card) continue
    batch.push(card)
    if (batch.length >= 2000) {
      rows.push(...scryfallToRows(batch))
      batch = []
    }
  }
  rows.push(...scryfallToRows(batch))
  console.log(`mtg: ${rows.length} printings`)
  await upsert(rows, dryRun)
  return rows.length
}

async function ingestPokemon(dryRun, setCap) {
  const sets = (await getJson(`${DEX_API}/sets`, 'tcgdex sets')).filter((s) => isPaperDexSet(s?.id))
  const chosen = setCap ? sets.slice(-setCap) : sets
  console.log(`pokemon: ${chosen.length} paper sets${setCap ? ` (of ${sets.length})` : ''}`)
  let total = 0
  for (const brief of chosen) {
    await sleep(DEX_GAP_MS)
    const set = await getJson(`${DEX_API}/sets/${encodeURIComponent(brief.id)}`, `tcgdex set ${brief.id}`).catch((err) => {
      console.warn(`  pokemon ${brief.id}: ${err.message} — skipped`)
      return null
    })
    if (!set) continue
    const rows = dexSetToRows(set)
    await upsert(rows, dryRun)
    total += rows.length
  }
  console.log(`pokemon: ${total} printings`)
  return total
}

async function ingestYugioh(dryRun) {
  console.log('yugioh: downloading cardinfo.php…')
  const payload = await getJson(YGO_API, 'ygoprodeck cardinfo')
  const rows = (payload.data ?? []).flatMap((card) => ygoToRows(card))
  console.log(`yugioh: ${rows.length} printings`)
  await upsert(rows, dryRun)
  return rows.length
}

/* -------------------------------------------------------------- hash pass */

/**
 * Fill art_hash where it is missing, newest rows first — resumable by
 * construction (finished rows stop matching the filter). Yu-Gi-Oh reprints
 * share one image per passcode; the per-row PATCH below still writes each,
 * which costs a few redundant hashes and keeps the pass dumb enough to trust.
 */
async function hashPass(limit) {
  const { build } = await import('esbuild')
  const { chromium } = await import('playwright-core')

  const query =
    `${SUPABASE_URL}/rest/v1/catalog_printings` +
    `?select=id,image_url&art_hash=is.null&image_url=not.is.null&order=updated_at.desc&limit=${limit}`
  const rows = await (await fetch(query, { headers: serviceHeaders() })).json()
  if (!Array.isArray(rows) || !rows.length) {
    console.log('hash: nothing to do')
    return
  }
  console.log(`hash: ${rows.length} rows`)

  const bundle = await build({
    entryPoints: [new URL('../src/lib/vision.ts', import.meta.url).pathname],
    bundle: true,
    format: 'iife',
    globalName: 'vision',
    write: false,
    logLevel: 'silent',
  })
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    headless: true,
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.addScriptTag({ content: bundle.outputFiles[0].text })

  let done = 0
  try {
    for (const { id, image_url } of rows) {
      const res = await fetch(image_url, { headers: { 'User-Agent': UA } }).catch(() => null)
      if (!res?.ok) continue
      const mime = res.headers.get('content-type') ?? 'image/jpeg'
      const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
      const hash = await page
        .evaluate(async ([dataUrl]) => {
          const img = await new Promise((resolve, reject) => {
            const el = new Image()
            el.onload = () => resolve(el)
            el.onerror = reject
            el.src = dataUrl
          })
          return vision.cardArtHash(img, img.naturalWidth, img.naturalHeight)
        }, [`data:${mime};base64,${b64}`])
        .catch(() => null)
      if (!hash) continue
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/catalog_printings?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...serviceHeaders(), Prefer: 'return=minimal' },
        body: JSON.stringify({ art_hash: hash }),
      })
      if (patch.ok) done++
      if (done % 50 === 0 && done) console.log(`  hash: ${done}/${rows.length}`)
      await sleep(60)
    }
  } finally {
    await browser.close()
  }
  console.log(`hash: ${done} rows fingerprinted`)
}

/* ------------------------------------------------------------------ stats */

/**
 * The post-sync sanity report: rows and artwork coverage per game, plus one
 * anonymous lookup through the same RPC the app calls — because "the table
 * has rows" and "an anon client gets answers" are different claims, and the
 * second is the one the app depends on.
 */
async function stats() {
  const count = async (filter) => {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/catalog_printings?select=id&${filter}`, {
      headers: { ...serviceHeaders(), Prefer: 'count=exact', Range: '0-0' },
    })
    if (!res.ok) return NaN
    return Number((res.headers.get('content-range') ?? '/0').split('/')[1])
  }
  console.log('game      rows      with art_hash')
  let sampleGame = null
  let sampleName = null
  for (const game of ['mtg', 'pokemon', 'yugioh']) {
    const total = await count(`game=eq.${game}`)
    const hashed = await count(`game=eq.${game}&art_hash=not.is.null`)
    const pct = total > 0 ? ` (${Math.round((hashed / total) * 100)}%)` : ''
    console.log(`${game.padEnd(9)} ${String(total).padEnd(9)} ${hashed}${pct}`)
    if (!sampleGame && total > 0) {
      const row = await (
        await fetch(`${SUPABASE_URL}/rest/v1/catalog_printings?select=name&game=eq.${game}&limit=1`, {
          headers: serviceHeaders(),
        })
      ).json()
      sampleGame = game
      sampleName = row?.[0]?.name ?? null
    }
  }
  if (sampleGame && sampleName) {
    // The app's own door, with the app's own credentials: anon key, no JWT.
    const anonKey = process.env.SUPABASE_KEY ?? 'sb_publishable_G3bgfYDZWuFYzEufHf793A_i4Po9Y3E'
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/catalog_by_name`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_game: sampleGame, p_query: sampleName.slice(0, 40) }),
    })
    const hits = res.ok ? await res.json() : []
    console.log(
      res.ok && Array.isArray(hits) && hits.length
        ? `anon lookup: "${sampleName}" answers through catalog_by_name ✓`
        : `anon lookup FAILED (HTTP ${res.status}) — has 0021 been applied? has test:mirror been run?`,
    )
    if (!res.ok) process.exitCode = 1
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = process.argv.slice(2)
  const flag = (name) => args.includes(`--${name}`)
  const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
  const dryRun = flag('dry-run')
  const sources = (value('source') ?? 'mtg,pokemon,yugioh').split(',').map((s) => s.trim())

  if (!SECRET && !dryRun) {
    console.error('SUPABASE_SECRET is required (service key) — or pass --dry-run to map without writing.')
    process.exit(2)
  }

  if (flag('stats')) {
    await stats()
    return
  }

  if (flag('hash')) {
    await hashPass(Number.parseInt(value('limit') ?? '500', 10) || 500)
    return
  }

  let total = 0
  if (sources.includes('mtg')) total += await ingestMtg(dryRun)
  if (sources.includes('pokemon')) total += await ingestPokemon(dryRun, Number.parseInt(value('sets') ?? '0', 10) || 0)
  if (sources.includes('yugioh')) total += await ingestYugioh(dryRun)
  console.log(`${dryRun ? '[dry-run] ' : ''}${total} printings ${dryRun ? 'mapped' : 'upserted'}. Now run --hash to fingerprint artwork.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
  })
}
