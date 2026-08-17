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

import { pathToFileURL } from 'node:url'

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

async function getJson(url, what) {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
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
  const entry = (bulk.data ?? []).find((b) => b.type === 'default_cards')
  if (!entry?.download_uri) throw new Error('scryfall: no default_cards bulk entry')
  console.log(`mtg: downloading ${entry.download_uri} (~${Math.round((entry.size ?? 0) / 1e6)} MB)…`)
  const rows = scryfallToRows(await getJson(entry.download_uri, 'scryfall default_cards'))
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
      const res = await fetch(image_url).catch(() => null)
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
