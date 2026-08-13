/**
 * Fetch REAL card imagery + API datasets for the scan-pipeline harness.
 *
 * Runs where the open internet is reachable (the scan-harness GitHub Actions
 * workflow, or any dev machine): downloads real card images (TCGdex for
 * Pokémon, TCGplayer product scans for Riftbound/One Piece, Scryfall for
 * Magic, YGOPRODeck for Yu-Gi-Oh) plus the API responses the scan pipeline's
 * card lookups need, so `run-matrix.mjs` can drive the REAL identifyFrame()
 * pipeline offline with the card APIs answered by faithful local stubs
 * (see stub-apis.mjs) over this data.
 *
 * Output: tests/harness/fixtures/ (gitignored; CI publishes it to the
 * `harness-fixtures` branch — machine-generated, force-pushed, never merged).
 *
 *   images/<game>/<key>.<ext>   real card image
 *   api/…                       datasets the stubs serve
 *   manifest.json               fixture ground truth + dataset inventory
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const UA = 'CardstockScanHarness/1.0 (+https://github.com/CorruptFun/CardStash)'

const failures = []
const manifest = { generatedAt: new Date().toISOString(), fixtures: [], datasets: {}, failures }

/* ---------------------------------------------------------------- helpers */

async function fetchRetry(url, { as = 'json', tries = 3, headers = {} } = {}) {
  let lastErr
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers } })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return as === 'json' ? await res.json() : Buffer.from(await res.arrayBuffer())
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
  }
  throw lastErr
}

async function save(rel, data) {
  const path = join(ROOT, rel)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data))
  return rel
}

const IMAGE_MAGIC = [
  [0xff, 0xd8], // jpg
  [0x89, 0x50], // png
  [0x52, 0x49], // webp (RIFF)
]

async function saveImage(rel, url) {
  const buf = await fetchRetry(url, { as: 'buffer' })
  if (buf.length < 8_000 || !IMAGE_MAGIC.some(([a, b]) => buf[0] === a && buf[1] === b)) {
    throw new Error(`Not a plausible image (${buf.length}B) from ${url}`)
  }
  await save(rel, buf)
  return { rel, bytes: buf.length }
}

function fixture(row) {
  manifest.fixtures.push(row)
  console.log(
    `  ✓ [${row.game}] ${row.key}: “${row.name}”` +
      (row.number ? ` #${row.number}` : '') +
      (row.total ? `/${row.total}` : '') +
      (row.setCode ? ` (${row.setCode})` : '') +
      ` ← ${row.image}`,
  )
}

function fail(scope, err) {
  failures.push({ scope, error: String(err?.message ?? err) })
  console.error(`  ✗ ${scope}: ${err?.message ?? err}`)
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const at = next++
        out[at] = await fn(items[at], at)
      }
    }),
  )
  return out
}

/* ------------------------------------------------------------ Pokémon ---- */

const DEX = 'https://api.tcgdex.net/v2/en'
const PTCG = 'https://api.pokemontcg.io/v2'

async function pokemon() {
  console.log('\nPokémon (TCGdex + pokemontcg.io)…')
  const briefsByName = {}
  const fulls = new Map() // id -> full card object
  const sets = new Map() // setId -> set object (with cards briefs)

  const hydrate = async (id) => {
    if (fulls.has(id)) return fulls.get(id)
    const raw = await fetchRetry(`${DEX}/cards/${id}`).catch(() => null)
    if (raw?.id) fulls.set(id, raw)
    return raw
  }

  /** Search briefs; hydrate every brief whose name equals/startsWith the target.
   * Keep the TAIL on cap: dexMatch pools the LAST briefs (newest sets), so a
   * head-biased capture would 404 exactly the hydrations the matcher needs. */
  const searchAndHydrate = async (name) => {
    const briefs = (await fetchRetry(`${DEX}/cards?name=${encodeURIComponent(name)}`)).filter((b) => b?.id && b?.name)
    briefsByName[name] = briefs
    const target = norm(name)
    const wanted = briefs.filter((b) => norm(b.name) === target || norm(b.name).startsWith(target)).slice(-120)
    await pool(wanted, 8, (b) => hydrate(b.id))
    return briefs
  }

  const wantSet = async (setId) => {
    if (!setId || sets.has(setId)) return
    const set = await fetchRetry(`${DEX}/sets/${setId}`).catch(() => null)
    if (set?.id) sets.set(setId, set)
  }

  // Pokémon TCG *Pocket* (the mobile game) shares the TCGdex index but its
  // digital frames print NO collector line — never usable as scan imagery.
  const isPaper = (c) => !/^[ab]\d/i.test(String(c?.set?.id ?? ''))

  // --- the user's real failing card: full-art Tauros, collector 096/086 ---
  const tauros = await searchAndHydrate('tauros')
  const taurosFulls = tauros.map((b) => fulls.get(b.id)).filter((c) => c && isPaper(c))
  const exact = taurosFulls.filter(
    (c) => String(c.localId) === '96' && Number(c?.set?.cardCount?.official) === 86,
  )
  const secret = taurosFulls.filter((c) => Number(c.localId) > Number(c?.set?.cardCount?.official ?? Infinity))
  const target = exact[0] ?? secret[secret.length - 1] ?? taurosFulls[taurosFulls.length - 1]
  const picks = []
  if (target) {
    picks.push({ key: 'tauros-fa-secret', card: target })
    const plain = taurosFulls.filter((c) => c.id !== target.id)
    const sameSet = plain.filter((c) => c?.set?.id === target?.set?.id)
    const alt = sameSet[0] ?? plain[plain.length - 1]
    if (alt) picks.push({ key: 'tauros-plain', card: alt })
  } else fail('pokemon/tauros', 'no Tauros found on TCGdex')

  const byId = async (key, id) => {
    const card = await hydrate(id)
    if (card) picks.push({ key, card })
    else fail(`pokemon/${key}`, `TCGdex has no ${id}`)
  }
  await byId('charizard-base', 'base1-4') // 1999 Base Set holo — the classic frame/font
  await byId('umbreon-vmax-alt', 'swsh7-215') // dark full-art alt (hard: dark plate, busy art)
  for (const name of ['pikachu', 'iono']) {
    const briefs = await searchAndHydrate(name)
    const cards = briefs.map((b) => fulls.get(b.id)).filter((c) => c && c.image && isPaper(c))
    const modern = cards.filter((c) => /^sv/i.test(String(c?.set?.id)))
    const pick = (name === 'iono' ? cards.filter((c) => /special|ultra|full/i.test(String(c.rarity))) : modern).slice(-1)[0] ?? cards.slice(-1)[0]
    if (pick) picks.push({ key: `${name}-modern`, card: pick })
    else fail(`pokemon/${name}`, 'nothing hydrated')
  }

  for (const { card } of picks) await wantSet(card?.set?.id)

  for (const { key, card } of picks) {
    if (!card?.image) {
      fail(`pokemon/${key}`, 'card has no image base')
      continue
    }
    try {
      const img = await saveImage(`images/pokemon/${key}.webp`, `${card.image}/high.webp`).catch(() =>
        saveImage(`images/pokemon/${key}.png`, `${card.image}/high.png`),
      )
      fixture({
        game: 'pokemon',
        key,
        name: card.name,
        setCode: card?.set?.id?.toUpperCase(),
        number: String(card.localId ?? ''),
        total: card?.set?.cardCount?.official != null ? String(card.set.cardCount.official) : undefined,
        image: img.rel,
        dexId: card.id,
      })
    } catch (err) {
      fail(`pokemon/${key}/image`, err)
    }
  }

  // Primary API (pokemontcg.io) — stale/flaky in production; capture whatever
  // it answers, and record which queries FAILED so the stub can answer those
  // names with the same server error instead of a false empty result.
  const primary = { alive: false, rowsByQueryName: {}, failedQueryNames: [] }
  for (const name of [...new Set(picks.map((p) => p.card?.name).filter(Boolean))]) {
    try {
      const res = await fetchRetry(`${PTCG}/cards?q=${encodeURIComponent(`name:"${name}"`)}&pageSize=60&orderBy=-set.releaseDate`, { tries: 2 })
      const rows = (res?.data ?? []).map(trimPtcgio)
      primary.rowsByQueryName[name] = rows
      primary.alive = true
      console.log(`  pokemontcg.io: ${rows.length} rows for “${name}”`)
    } catch (err) {
      primary.failedQueryNames.push(name)
      fail(`pokemontcgio/${name}`, err)
    }
  }

  // The FULL en sets brief list (small once trimmed): the collector-only
  // sweep filters it by printed set size, and a partial list would hide the
  // size collisions the real API forces the pipeline to survive.
  const setsList = await fetchRetry(`${DEX}/sets`).catch((err) => {
    fail('pokemon/sets-list', err)
    return []
  })

  manifest.datasets.pokemon = {
    briefs: await save('api/tcgdex-briefs.json', {
      // The stub answers /cards?name=X with a contains-filter over this union.
      all: dedupeBy(
        [...Object.values(briefsByName).flat(), ...[...sets.values()].flatMap((s) => (s.cards ?? []).map((c) => ({ ...c })))],
        (b) => b.id,
      ),
    }),
    fulls: await save('api/tcgdex-cards.json', Object.fromEntries(fulls)),
    sets: await save('api/tcgdex-sets.json', Object.fromEntries([...sets.entries()].map(([id, s]) => [id, { ...s, cards: s.cards ?? [] }]))),
    setsList: await save(
      'api/tcgdex-sets-list.json',
      setsList.map(({ id, name, cardCount, releaseDate }) => ({ id, name, cardCount, releaseDate })),
    ),
    pokemontcgio: await save('api/pokemontcgio.json', primary),
  }
}

/* ----------------------------------------------- Pokémon, Japanese print - */

/**
 * A real Japanese card: the name is kanji/kana the shipped eng OCR cannot
 * read, so identification must ride the printed collector line + set code
 * ("046/066" + "SV4K") through the TCGdex ja catalog. hintedOnly — auto mode
 * has no collector-only rescue by design.
 */
async function pokemonJa() {
  console.log('\nPokémon ja (TCGdex)…')
  const list = await fetchRetry('https://api.tcgdex.net/v2/ja/sets')
  await save(
    'api/tcgdex-ja-sets-list.json',
    list.map(({ id, name, cardCount, releaseDate }) => ({ id, name, cardCount, releaseDate })),
  )
  // 古代の咆哮 (Ancient Roar, sv4K) — the set from the user's bug report —
  // else any modern SV-era ja set of plausible size.
  const brief =
    list.find((s) => /^sv4k$/i.test(String(s.id))) ??
    list.filter((s) => /^sv/i.test(String(s.id)) && Number(s?.cardCount?.official) > 40).slice(-1)[0]
  if (!brief) {
    fail('pokemon-ja/set', 'no ja SV-era set on TCGdex')
    return
  }
  const set = await fetchRetry(`https://api.tcgdex.net/v2/ja/sets/${brief.id}`)
  await save('api/tcgdex-ja-sets.json', { [set.id]: { ...set, cards: set.cards ?? [] } })
  // A mid-set card whose localId prints as a plain fraction; needs an image.
  const candidates = (set.cards ?? [])
    .filter((c) => c?.id && Number(c?.localId) >= 20 && Number(c?.localId) <= Number(set?.cardCount?.official ?? 0))
    .slice(0, 12)
  const fulls = {}
  let pick = null
  for (const candidate of candidates) {
    const full = await fetchRetry(`https://api.tcgdex.net/v2/ja/cards/${candidate.id}`).catch(() => null)
    if (full?.id) fulls[full.id] = full
    if (full?.id && full.image && !pick) pick = full
    if (pick && Object.keys(fulls).length >= 4) break
  }
  await save('api/tcgdex-ja-cards.json', fulls)
  if (!pick) {
    fail('pokemon-ja/card', `no ja card with an image in ${set.id}`)
    return
  }
  try {
    const img = await saveImage(`images/pokemon/ja-collector.webp`, `${pick.image}/high.webp`).catch(() =>
      saveImage(`images/pokemon/ja-collector.png`, `${pick.image}/high.png`),
    )
    fixture({
      game: 'pokemon',
      key: 'ja-collector',
      name: pick.name,
      setCode: set.id.toUpperCase(),
      number: String(pick.localId ?? ''),
      total: set?.cardCount?.official != null ? String(set.cardCount.official) : undefined,
      image: img.rel,
      dexId: pick.id,
      lang: 'ja',
      hintedOnly: true,
    })
  } catch (err) {
    fail('pokemon-ja/image', err)
  }
}

function trimPtcgio(raw) {
  const { id, name, number, rarity, supertype, subtypes, images, rules, flavorText } = raw
  return {
    id, name, number, rarity, supertype, subtypes, images, rules, flavorText,
    set: raw.set && {
      id: raw.set.id, name: raw.set.name, ptcgoCode: raw.set.ptcgoCode,
      releaseDate: raw.set.releaseDate, printedTotal: raw.set.printedTotal,
    },
    tcgplayer: raw.tcgplayer && { url: raw.tcgplayer.url, prices: raw.tcgplayer.prices },
  }
}

function dedupeBy(rows, keyOf) {
  const seen = new Set()
  return rows.filter((r) => {
    const k = keyOf(r)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/* ------------------------------------------- TCGCSV (Riftbound, One Piece) */

const TCGCSV = 'https://tcgcsv.com/tcgplayer'

const extValue = (product, ...names) => {
  for (const name of names) {
    const hit = (product?.extendedData ?? []).find((r) => String(r?.name ?? '').toLowerCase() === name.toLowerCase())
    if (hit?.value != null && String(hit.value).trim()) return String(hit.value).trim()
  }
  return undefined
}

async function tcgcsvGame(game, categoryRe, wantGroups, pickFixtures) {
  console.log(`\n${game} (tcgcsv.com / TCGplayer)…`)
  const categories = await fetchRetry(`${TCGCSV}/categories`)
  const catRows = (Array.isArray(categories) ? categories : categories?.results) ?? []
  const hits = catRows.filter((c) => categoryRe.test(c?.name ?? '') || categoryRe.test(c?.displayName ?? ''))
  hits.sort((a, b) => String(a?.name ?? '').length - String(b?.name ?? '').length)
  const categoryId = Number(hits[0]?.categoryId)
  if (!Number.isFinite(categoryId)) throw new Error(`no TCGplayer category matches ${categoryRe}`)
  console.log(`  category ${categoryId} (“${hits[0]?.name}”)`)
  await save('api/tcgcsv/categories.json', { results: catRows })

  const groupsRes = await fetchRetry(`${TCGCSV}/${categoryId}/groups`)
  const allGroups = ((Array.isArray(groupsRes) ? groupsRes : groupsRes?.results) ?? []).filter((g) => Number.isFinite(Number(g?.groupId)))
  const groups = wantGroups(allGroups)
  console.log(`  groups: ${groups.map((g) => `${g.groupId}:${g.abbreviation ?? g.name}`).join(', ')}`)

  const perGroup = await pool(groups, 4, async (group) => {
    const products = await fetchRetry(`${TCGCSV}/${categoryId}/${group.groupId}/products`)
    const prices = await fetchRetry(`${TCGCSV}/${categoryId}/${group.groupId}/prices`).catch(() => ({ results: [] }))
    const productRows = (Array.isArray(products) ? products : products?.results) ?? []
    await save(`api/tcgcsv/${categoryId}/${group.groupId}/products.json`, { results: productRows })
    await save(`api/tcgcsv/${categoryId}/${group.groupId}/prices.json`, {
      results: (Array.isArray(prices) ? prices : prices?.results) ?? [],
    })
    return { group, products: productRows }
  })
  // The stub serves ONLY the groups fetched here — trim the group list to match
  // so the catalog builder sees a complete (not partial) catalog.
  await save(`api/tcgcsv/${categoryId}/groups.json`, { results: groups })

  const picked = pickFixtures(perGroup)
  for (const { key, product, group } of picked) {
    const url = String(product.imageUrl ?? '').replace(/_(?:\d+w|in_\d+x\d+)(\.\w+)$/, '_in_1000x1000$1')
    if (!url) {
      fail(`${game}/${key}`, `no imageUrl on ${product.name}`)
      continue
    }
    try {
      const img = await saveImage(`images/${game}/${key}.jpg`, url)
      fixture({
        game, key,
        name: product.name,
        setCode: group.abbreviation || undefined,
        number: extValue(product, 'Number', 'Card Number'),
        image: img.rel,
        productId: product.productId,
      })
    } catch (err) {
      fail(`${game}/${key}/image`, err)
    }
  }
  manifest.datasets[game] = { tcgcsvCategoryId: categoryId, groups: groups.map((g) => g.groupId) }
}

const isSingleProduct = (p) => extValue(p, 'Number', 'Card Number') != null || extValue(p, 'Rarity') != null

function pickRiftbound(perGroup) {
  const singles = perGroup.flatMap(({ group, products }) =>
    products.filter((p) => isSingleProduct(p) && p.imageUrl && !/\(/.test(p.name)).map((p) => ({ product: p, group })),
  )
  const used = new Set()
  const take = (key, pred) => {
    const hit = singles.find((s) => !used.has(s.product.productId) && pred(s.product))
    if (!hit) return null
    used.add(hit.product.productId)
    return { key, ...hit }
  }
  return [
    take('jinx-split', (p) => /^jinx,/i.test(p.name)) ?? take('champion-split-1', (p) => p.name.includes(',')),
    take('champion-split-2', (p) => p.name.includes(',')),
    take('short-name-1', (p) => !p.name.includes(',') && p.name.length <= 12),
    take('short-name-2', (p) => !p.name.includes(',') && p.name.length <= 16),
    take('long-name', (p) => p.name.length >= 24),
    take('mid-name', (p) => p.name.length > 12 && p.name.length < 24),
  ].filter(Boolean)
}

function pickOnePiece(perGroup) {
  const singles = perGroup.flatMap(({ group, products }) =>
    products.filter((p) => isSingleProduct(p) && p.imageUrl && !/\(/.test(p.name)).map((p) => ({ product: p, group })),
  )
  const used = new Set()
  const take = (key, pred) => {
    const hit = singles.find((s) => !used.has(s.product.productId) && pred(s.product))
    if (hit) used.add(hit.product.productId)
    return hit ? { key, ...hit } : null
  }
  return [
    take('luffy', (p) => /luffy/i.test(p.name)),
    take('short-name', (p) => p.name.length <= 10),
    take('leader-long', (p) => p.name.length >= 16),
  ].filter(Boolean)
}

/* ---------------------------------------------------------------- Magic -- */

const SCRYFALL = 'https://api.scryfall.com'

async function mtg() {
  console.log('\nMagic (Scryfall)…')
  const NAMES = ['Lightning Bolt', 'Sheoldred, the Apocalypse', 'Counterspell', 'Llanowar Elves']
  const printsByName = {}
  for (const name of NAMES) {
    let url = `${SCRYFALL}/cards/search?q=${encodeURIComponent(`!"${name}" game:paper`)}&unique=prints&order=released&dir=desc`
    const prints = []
    while (url && prints.length < 350) {
      const res = await fetchRetry(url)
      prints.push(...(res?.data ?? []).map(trimScryfall))
      url = res?.has_more ? res.next_page : null
      await new Promise((r) => setTimeout(r, 120))
    }
    printsByName[name] = prints
    console.log(`  ${prints.length} prints of “${name}”`)
  }

  const withImage = (prints) => prints.filter((p) => p.image_uris?.large && !p.digital)
  const newestRegular = (prints) =>
    withImage(prints).find((p) => p.frame === '2015' && !p.full_art && p.border_color === 'black' && !(p.frame_effects ?? []).length) ??
    withImage(prints)[0]
  const picks = [
    { key: 'bolt-modern', card: newestRegular(printsByName['Lightning Bolt']) },
    { key: 'sheoldred-dark', card: newestRegular(printsByName['Sheoldred, the Apocalypse']) },
    {
      key: 'counterspell-retro',
      card: withImage(printsByName['Counterspell']).find((p) => p.frame === '1997' || p.frame === '1993') ??
        newestRegular(printsByName['Counterspell']),
    },
    {
      // Whichever of the captured names has a borderless/full-art print —
      // the KEY is honest about that (a prior run shipped a borderless
      // Lightning Bolt under an "elves-" key).
      key: 'borderless-any',
      card:
        NAMES.map((n) => withImage(printsByName[n]).find((p) => p.border_color === 'borderless' || p.full_art)).find(Boolean) ??
        newestRegular(printsByName['Llanowar Elves']),
    },
  ]
  for (const { key, card } of picks) {
    if (!card) {
      fail(`mtg/${key}`, 'no print with an image')
      continue
    }
    try {
      const img = await saveImage(`images/mtg/${key}.jpg`, card.image_uris.large)
      fixture({
        game: 'mtg', key,
        name: card.name,
        setCode: card.set?.toUpperCase(),
        number: card.collector_number,
        image: img.rel,
        scryfallId: card.id,
      })
      await new Promise((r) => setTimeout(r, 120))
    } catch (err) {
      fail(`mtg/${key}/image`, err)
    }
  }

  // A real Japanese print: the name line is kanji, so identification must
  // ride the corner's "0266 R … NEO・JA" through the exact set+number lookup.
  // The EN print of the same collector number is captured FIRST so the stub's
  // /cards/:set/:number answers with it, like the real API's default-language
  // resolution. hintedOnly — auto mode has no collector-only rescue.
  try {
    const en = trimScryfall(await fetchRetry(`${SCRYFALL}/cards/neo/266`))
    await new Promise((r) => setTimeout(r, 120))
    const ja = trimScryfall(await fetchRetry(`${SCRYFALL}/cards/neo/266/ja`))
    printsByName[en.name] = dedupeBy([...(printsByName[en.name] ?? []), en, ja], (p) => p.id)
    const img = await saveImage('images/mtg/ja-collector.jpg', ja.image_uris.large)
    fixture({
      game: 'mtg',
      key: 'ja-collector',
      name: en.name,
      setCode: en.set?.toUpperCase(),
      number: en.collector_number,
      image: img.rel,
      scryfallId: ja.id,
      lang: 'ja',
      hintedOnly: true,
    })
  } catch (err) {
    fail('mtg/ja-collector', err)
  }

  const names = await fetchRetry(`${SCRYFALL}/catalog/card-names`)
  manifest.datasets.mtg = {
    prints: await save('api/scryfall-prints.json', printsByName),
    cardNames: await save('api/scryfall-card-names.json', { data: names?.data ?? [] }),
  }
  console.log(`  card-names catalog: ${names?.data?.length ?? 0} names`)
}

function trimScryfall(raw) {
  const pick = ({ id, name, flavor_name, set, set_name, collector_number, rarity, released_at, finishes, image_uris, type_line, oracle_text, mana_cost, cmc, colors, color_identity, prices, purchase_uris, scryfall_uri, frame, frame_effects, border_color, full_art, digital }) => ({
    id, name, flavor_name, set, set_name, collector_number, rarity, released_at, finishes, image_uris, type_line, oracle_text, mana_cost, cmc, colors, color_identity, prices, purchase_uris, scryfall_uri, frame, frame_effects, border_color, full_art, digital,
  })
  const out = pick(raw)
  if (Array.isArray(raw.card_faces)) {
    out.card_faces = raw.card_faces.map((f) => ({
      name: f.name, type_line: f.type_line, oracle_text: f.oracle_text, mana_cost: f.mana_cost, image_uris: f.image_uris,
    }))
  }
  return out
}

/* -------------------------------------------------------------- Yu-Gi-Oh - */

const YGO = 'https://db.ygoprodeck.com/api/v7'

async function yugioh() {
  console.log('\nYu-Gi-Oh (YGOPRODeck)…')
  const NAMES = ['Blue-Eyes White Dragon', 'Dark Magician', 'Ash Blossom & Joyous Spring']
  const rows = []
  const seen = new Set()
  const push = (raw) => {
    if (raw && !seen.has(raw.id)) {
      seen.add(raw.id)
      rows.push(trimYgo(raw))
    }
  }
  const named = []
  for (const name of NAMES) {
    try {
      const res = await fetchRetry(`${YGO}/cardinfo.php?name=${encodeURIComponent(name)}`)
      if (res?.data?.[0]) {
        push(res.data[0])
        named.push(trimYgo(res.data[0]))
      } else fail(`yugioh/${name}`, 'no data')
    } catch (err) {
      fail(`yugioh/${name}`, err)
    }
  }
  // A stub universe of 3 cards flatters substring retrieval — capture the
  // realistic fname pools the app's longest-word fallback would face.
  for (const word of ['dragon', 'magician', 'blossom']) {
    try {
      const res = await fetchRetry(`${YGO}/cardinfo.php?fname=${encodeURIComponent(word)}&num=60&offset=0`)
      for (const raw of res?.data ?? []) push(raw)
      console.log(`  fname pool “${word}”: ${res?.data?.length ?? 0} rows`)
    } catch (err) {
      fail(`yugioh/pool-${word}`, err)
    }
  }
  for (const raw of named) {
    const key = norm(raw.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
    const url = raw.card_images?.[0]?.image_url
    if (!url) {
      fail(`yugioh/${key}`, 'no image url')
      continue
    }
    try {
      const img = await saveImage(`images/yugioh/${key}.jpg`, url)
      fixture({
        game: 'yugioh', key,
        name: raw.name,
        number: raw.card_sets?.[0]?.set_code,
        image: img.rel,
        ygoId: raw.id,
      })
    } catch (err) {
      fail(`yugioh/${key}/image`, err)
    }
  }
  manifest.datasets.yugioh = { cards: await save('api/ygo-cards.json', { data: rows }) }
}

function trimYgo(raw) {
  return {
    id: raw.id, name: raw.name, type: raw.type, desc: raw.desc, race: raw.race,
    attribute: raw.attribute, level: raw.level, atk: raw.atk, def: raw.def,
    card_sets: raw.card_sets, card_images: (raw.card_images ?? []).slice(0, 1), card_prices: (raw.card_prices ?? []).slice(0, 1),
  }
}

/* ------------------------------------------------------------------ main - */

const steps = [
  ['pokemon', pokemon],
  ['pokemon-ja', pokemonJa],
  ['riftbound', () => tcgcsvGame('riftbound', /riftbound/i, (groups) => groups, pickRiftbound)],
  [
    'onepiece',
    () =>
      tcgcsvGame(
        'onepiece',
        /one\s*piece/i,
        (groups) => {
          const dated = groups
            .filter((g) => typeof g?.publishedOn === 'string')
            .sort((a, b) => String(b.publishedOn).localeCompare(String(a.publishedOn)))
          const op01 = groups.find((g) => /OP-?01|Romance Dawn/i.test(`${g.abbreviation} ${g.name}`))
          const keep = dedupeBy([...(op01 ? [op01] : []), ...dated.slice(0, 3)], (g) => g.groupId)
          return keep.length ? keep : groups.slice(0, 3)
        },
        pickOnePiece,
      ),
  ],
  ['mtg', mtg],
  ['yugioh', yugioh],
]

for (const [name, step] of steps) {
  try {
    await step()
  } catch (err) {
    fail(name, err)
  }
}

await save('manifest.json', manifest)
console.log(`\n${manifest.fixtures.length} fixtures, ${failures.length} failures.`)
console.log(failures.length ? failures.map((f) => ` - ${f.scope}: ${f.error}`).join('\n') : 'All clean.')
// A partial run must not clobber a good snapshot: a whole-game failure or a
// thin fixture set fails the job, so the workflow's force-push never ships it.
const FIXTURE_FLOOR = 15
const wholeGameFailures = failures.filter((f) => steps.some(([name]) => name === f.scope))
if (manifest.fixtures.length < FIXTURE_FLOOR || wholeGameFailures.length) {
  console.error(
    `Refusing to publish: ${manifest.fixtures.length}/${FIXTURE_FLOOR} fixtures` +
      (wholeGameFailures.length ? `, whole games failed: ${wholeGameFailures.map((f) => f.scope).join(', ')}` : ''),
  )
  process.exit(1)
}
