/**
 * Local stand-ins for the card APIs, backed by the REAL datasets that
 * fetch-fixtures.mjs captured. The scan pipeline itself is never stubbed —
 * these answer only the network calls the pipeline's match layer makes, with
 * each service's query semantics reimplemented over its real data:
 *
 *  - tcgcsv.com               → verbatim captured JSON (categories/groups/products/prices)
 *  - api.tcgdex.net           → contains-search + hydration over captured briefs/cards
 *  - api.pokemontcg.io        → Lucene-ish name:"…" / name:tok* / number:"…" over captured rows
 *                               (served dead if the real API was dead at capture time)
 *  - api.scryfall.com         → exact/fuzzy named + prints search over captured prints,
 *                               fuzzy resolved against the real card-names catalog
 *  - cards.scryfall.io        → captured small print images (images/prints/) for the
 *                               art-hash printing re-pick; an uncaptured id answers 404
 *  - db.ygoprodeck.com        → fname contains / name exact over captured rows
 *  - api.lorcast.com          → 404 (how Lorcast reports "no cards")
 *
 * Known bias (documented, stable across before/after runs): misreads that a
 * real API might fuzzy-resolve to some OTHER card return "no match" here, so
 * both count as failures — only the failure stage label differs.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  let next = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    next[0] = i
    const code = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = code === b.charCodeAt(j - 1) ? 0 : 1
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, next] = [next, prev]
  }
  return prev[b.length]
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const similarity = (a, b) => {
  const na = norm(a)
  const nb = norm(b)
  if (!na.length || !nb.length) return 0
  return 1 - levenshtein(na, nb) / Math.max(na.length, nb.length)
}

export function createStubs(fixturesDir) {
  const maybe = (rel, fallback) => {
    const path = join(fixturesDir, rel)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
  }
  const dexBriefs = maybe('api/tcgdex-briefs.json', { all: [] }).all
  const dexFulls = maybe('api/tcgdex-cards.json', {})
  const dexSets = maybe('api/tcgdex-sets.json', {})
  // Per-language TCGdex datasets (ja, …): en keeps its legacy file names,
  // other languages use the -<lang>- infix, all captured by fetch-fixtures.
  const dexLang = (lang) =>
    lang === 'en'
      ? {
          briefs: dexBriefs,
          fulls: dexFulls,
          sets: dexSets,
          setsList: maybe('api/tcgdex-sets-list.json', []),
        }
      : {
          briefs: maybe(`api/tcgdex-${lang}-briefs.json`, { all: [] }).all,
          fulls: maybe(`api/tcgdex-${lang}-cards.json`, {}),
          sets: maybe(`api/tcgdex-${lang}-sets.json`, {}),
          setsList: maybe(`api/tcgdex-${lang}-sets-list.json`, []),
        }
  const ptcgio = maybe('api/pokemontcgio.json', { alive: false, rowsByQueryName: {} })
  const seenPtcg = new Set()
  const ptcgioRows = Object.values(ptcgio.rowsByQueryName)
    .flat()
    .filter((r) => (seenPtcg.has(r.id) ? false : (seenPtcg.add(r.id), true)))
  const scryfallPrints = maybe('api/scryfall-prints.json', {})
  const scryfallNames = maybe('api/scryfall-card-names.json', { data: [] }).data
  const scryfallSets = maybe('api/scryfall-sets.json', {})
  const ygoRows = maybe('api/ygo-cards.json', { data: [] }).data
  const allPrints = Object.values(scryfallPrints).flat()

  const stats = { calls: {}, unknown: [] }
  const count = (k) => (stats.calls[k] = (stats.calls[k] ?? 0) + 1)
  const json = (body, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
  const file = (rel) => {
    const path = join(fixturesDir, rel)
    if (!existsSync(path)) return json({ error: `no fixture ${rel}` }, 404)
    return { status: 200, contentType: 'application/json', body: readFileSync(path, 'utf8') }
  }

  /* ------------------------------------------------------------- tcgcsv - */
  function tcgcsv(url) {
    const m = url.pathname.match(/^\/tcgplayer\/(.+)$/)
    if (!m) return json({ error: 'bad path' }, 404)
    const parts = m[1].split('/')
    if (parts[0] === 'categories') return file('api/tcgcsv/categories.json')
    if (parts.length === 2 && parts[1] === 'groups') return file(`api/tcgcsv/${parts[0]}/groups.json`)
    if (parts.length === 3 && (parts[2] === 'products' || parts[2] === 'prices'))
      return file(`api/tcgcsv/${parts[0]}/${parts[1]}/${parts[2]}.json`)
    return json({ error: 'bad path' }, 404)
  }

  /* ------------------------------------------------------------- tcgdex - */
  function tcgdex(url) {
    const path = url.pathname
    const langMatch = path.match(/^\/v2\/([a-z]{2}(?:-[a-z]{2})?)(\/.*)?$/)
    if (!langMatch) return json({ error: 'not stubbed' }, 404)
    const data = dexLang(langMatch[1])
    const rest = langMatch[2] ?? ''
    let m = rest.match(/^\/cards\/([^/]+)$/)
    if (m) {
      const full = data.fulls[decodeURIComponent(m[1])]
      return full ? json(full) : json({ error: 'Card not found' }, 404)
    }
    m = rest.match(/^\/sets\/([^/]+)$/)
    if (m) {
      const set = data.sets[decodeURIComponent(m[1])]
      return set ? json(set) : json({ error: 'Set not found' }, 404)
    }
    // Real /sets always answers the full brief list; an uncaptured language
    // answers empty — the sweep then simply finds no candidate sets there.
    if (rest === '/sets') return json(data.setsList)
    if (rest === '/cards') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase().trim()
      if (!name) return json(data.briefs.slice(0, 100))
      // Real TCGdex name= is a lax case-insensitive contains.
      return json(data.briefs.filter((b) => String(b.name ?? '').toLowerCase().includes(name)))
    }
    return json({ error: 'not stubbed' }, 404)
  }

  /* ------------------------------------------------------- pokemontcg.io - */
  function pokemontcgio(url) {
    if (!ptcgio.alive) return json({ error: 'service unavailable' }, 503)
    // Queries whose capture 500'd get the same server error, not a false [].
    const q0 = url.searchParams.get('q') ?? ''
    for (const name of ptcgio.failedQueryNames ?? []) {
      if (q0.toLowerCase().includes(`"${name.toLowerCase()}"`)) return json({ error: 'internal server error' }, 500)
    }
    let m = url.pathname.match(/^\/v2\/cards\/([^/]+)$/)
    if (m) {
      const row = ptcgioRows.find((r) => r.id === decodeURIComponent(m[1]))
      return row ? json({ data: row }) : json({ error: 'not found' }, 404)
    }
    if (url.pathname !== '/v2/cards') return json({ error: 'not stubbed' }, 404)
    const q = url.searchParams.get('q') ?? ''
    const phrases = [...q.matchAll(/name:"([^"]+)"/g)].map((x) => x[1].toLowerCase())
    const prefixes = [...q.matchAll(/name:([^\s"*]+)\*/g)].map((x) => x[1].toLowerCase())
    const numbers = [...q.matchAll(/number:"([^"]+)"/g)].map((x) => x[1].toLowerCase())
    const printedTotals = [...q.matchAll(/set\.printedTotal:(\d+)/g)].map((x) => Number(x[1]))
    let rows = ptcgioRows.filter((r) => {
      const name = String(r.name ?? '').toLowerCase()
      const words = name.split(/[^a-z0-9]+/)
      if (!phrases.every((p) => name.includes(p))) return false
      if (!prefixes.every((p) => words.some((w) => w.startsWith(p)))) return false
      if (numbers.length && !numbers.some((n) => String(r.number ?? '').toLowerCase() === n)) return false
      if (printedTotals.length && !printedTotals.some((t) => Number(r.set?.printedTotal) === t)) return false
      return true
    })
    if ((url.searchParams.get('orderBy') ?? '').includes('-set.releaseDate')) {
      rows = [...rows].sort((a, b) => String(b.set?.releaseDate ?? '').localeCompare(String(a.set?.releaseDate ?? '')))
    }
    const pageSize = Number(url.searchParams.get('pageSize') ?? 250)
    return json({ data: rows.slice(0, pageSize), totalCount: rows.length })
  }

  /* ------------------------------------------------------------ scryfall - */
  // Real /cards/named resolves FLAVOR names too ("Khan, Engineered Evil" →
  // the Sheoldred print carrying it) — mirror that from the captured prints.
  const flavorIndex = new Map()
  for (const print of allPrints) {
    if (print.flavor_name) flavorIndex.set(norm(print.flavor_name), print)
  }
  const namedUniverse = [...scryfallNames, ...[...flavorIndex.keys()]]
  const namedPrint = (name) => {
    const flavored = flavorIndex.get(norm(name))
    if (flavored) return flavored
    const key = Object.keys(scryfallPrints).find((n) => norm(n) === norm(name))
    return key ? scryfallPrints[key][0] : null
  }

  function scryfall(url, request) {
    const path = url.pathname
    if (path === '/catalog/card-names') return json({ object: 'catalog', data: scryfallNames })
    if (path === '/cards/named') {
      const exact = url.searchParams.get('exact')
      const fuzzy = url.searchParams.get('fuzzy')
      const set = url.searchParams.get('set')
      let resolved = null
      if (exact) {
        resolved = namedUniverse.find((n) => norm(n) === norm(exact)) ?? null
      } else if (fuzzy) {
        // Approximation of Scryfall's fuzzy rule: best unambiguous near-match.
        let best = null
        let second = 0
        for (const n of namedUniverse) {
          const s = similarity(fuzzy, n)
          if (!best || s > best.s) {
            second = best?.s ?? 0
            best = { n, s }
          } else if (s > second) second = s
        }
        if (best && best.s >= 0.77 && best.s - second >= 0.02) resolved = best.n
      }
      if (!resolved) return json({ object: 'error', code: 'not_found', details: 'No card found.' }, 404)
      let print = namedPrint(resolved)
      if (print && set) {
        print = (scryfallPrints[print.name] ?? []).find((p) => p.set === set.toLowerCase()) ?? null
      }
      // The name exists in the catalog but we captured no prints for it — the
      // documented harness bias; report not-found rather than fake a card.
      return print ? json(print) : json({ object: 'error', code: 'not_found', details: 'No print captured.' }, 404)
    }
    if (path === '/cards/search') {
      const q = url.searchParams.get('q') ?? ''
      const bang = q.match(/!"([^"]+)"/)
      if (!bang) return json({ object: 'error', code: 'not_found', details: 'Unsupported harness query.' }, 404)
      const set = q.match(/\bset:(\S+)/)?.[1]?.toLowerCase()
      const key = Object.keys(scryfallPrints).find((n) => norm(n) === norm(bang[1]))
      let rows = key ? scryfallPrints[key] : []
      if (set) rows = rows.filter((p) => p.set === set)
      if (!rows.length) return json({ object: 'error', code: 'not_found', details: 'Your query didn’t match any cards.' }, 404)
      return json({ object: 'list', total_cards: rows.length, has_more: false, data: rows })
    }
    if (path === '/cards/collection' && request?.method?.() === 'POST') {
      let ids = []
      try {
        ids = (JSON.parse(request.postData() ?? '{}').identifiers ?? []).map((i) => i.id)
      } catch { /* empty body */ }
      const data = ids.map((id) => allPrints.find((p) => p.id === id)).filter(Boolean)
      return json({ object: 'list', data, not_found: [] })
    }
    let m = path.match(/^\/sets\/([a-z0-9]{3,6})$/)
    if (m) {
      const set = scryfallSets[m[1].toLowerCase()]
      return set ? json(set) : json({ object: 'error', code: 'not_found', details: 'No such set.' }, 404)
    }
    m = path.match(/^\/cards\/([a-z0-9]{3,5})\/([^/]+)$/)
    if (m) {
      const hit = allPrints.find(
        (p) => p.set === m[1].toLowerCase() && String(p.collector_number).toLowerCase() === decodeURIComponent(m[2]).toLowerCase(),
      )
      return hit ? json(hit) : json({ object: 'error', code: 'not_found', details: 'No such collector number.' }, 404)
    }
    m = path.match(/^\/cards\/([0-9a-f-]{36})$/)
    if (m) {
      const hit = allPrints.find((p) => p.id === m[1])
      return hit ? json(hit) : json({ object: 'error', code: 'not_found', details: 'No such id.' }, 404)
    }
    return json({ object: 'error', code: 'not_found', details: 'Not stubbed.' }, 404)
  }

  /* ---------------------------------------------------- scryfall imagery - */
  // cards.scryfall.io is the CDN behind `image_uris` — the art-hash printing
  // re-pick (arthash.ts) fetches candidate prints' `small` images and compares
  // art regions against the captured frame. The harness runs with NO egress,
  // so unless the snapshot's images are served here the art hash measures
  // nothing: every fetch would abort, every candidate would decline, and the
  // printing column would grade a mechanism that never got to run.
  // fetch-fixtures downloads each captured print's small image to
  // images/prints/<scryfall-id>.jpg; this serves exactly those bytes (the
  // cache-buster query the real URLs carry is ignored, as the CDN ignores it).
  // An id NOT in the store answers a clean 404 — a resolved, not-ok Response,
  // which is what the real CDN says about a missing image — because the
  // pipeline treats a failed image as "decline, keep the current answer" and
  // that path must be exercised honestly, not short-circuited by a simulated
  // network outage. Other sizes and faces (/normal/, /large/, /small/back/)
  // are NOT served from the small file: misstating resolution would quietly
  // skew the hash, and a pipeline drifting onto URLs the fetcher never
  // captured should surface in stats.unknown like any unstubbed traffic, not
  // be flattered — the dispatch lets them fall through to the abort path.
  function scryfallImage(url) {
    const m = url.pathname.match(/^\/small\/front\/[0-9a-f]\/[0-9a-f]\/([0-9a-f-]{36})\.jpg$/)
    if (!m) return null
    const path = join(fixturesDir, 'images', 'prints', `${m[1]}.jpg`)
    if (!existsSync(path)) return { status: 404, contentType: 'text/plain', body: 'Not found' }
    return { status: 200, contentType: 'image/jpeg', body: readFileSync(path) }
  }

  /* ---------------------------------------------------------- ygoprodeck - */
  function ygoprodeck(url) {
    if (!url.pathname.endsWith('/cardinfo.php')) return json({ error: 'not stubbed' }, 400)
    const id = url.searchParams.get('id')
    const fname = url.searchParams.get('fname')
    const name = url.searchParams.get('name')
    let rows = ygoRows
    // Live id= (the printed 8-digit passcode) is an exact numeric match. This
    // filter must come first: an id query with no name/fname previously fell
    // through to "all rows", which would flatter any passcode misread.
    if (id != null) rows = rows.filter((r) => String(r.id) === id.trim().replace(/^0+(?=\d)/, ''))
    // Live name= is EXACT (case-insensitive, punctuation significant) — a
    // laxer stub was flattering junk-suffixed reads the real API rejects.
    else if (name != null) rows = rows.filter((r) => String(r.name).toLowerCase() === name.trim().toLowerCase())
    else if (fname != null) rows = rows.filter((r) => String(r.name).toLowerCase().includes(fname.toLowerCase()))
    // Real API answers "nothing matched" with HTTP 400 + an error body.
    if (!rows.length) return json({ error: 'No card matching your query was found in the database.' }, 400)
    const num = Number(url.searchParams.get('num'))
    return json({ data: Number.isFinite(num) && num > 0 ? rows.slice(0, num) : rows })
  }

  /* ------------------------------------------------------------ dispatch - */
  function handle(urlString, request) {
    const url = new URL(urlString)
    count(url.hostname)
    const unknown = () => {
      stats.unknown.push(urlString.slice(0, 140))
      return null // caller aborts the request
    }
    switch (url.hostname) {
      case 'tcgcsv.com':
        return tcgcsv(url)
      case 'api.tcgdex.net':
        return tcgdex(url)
      case 'api.pokemontcg.io':
        return pokemontcgio(url)
      case 'api.scryfall.com':
        return scryfall(url, request)
      case 'cards.scryfall.io':
        // Only the small-front image shape is stubbed (see scryfallImage);
        // anything else on the host is unstubbed traffic and aborts loudly.
        return scryfallImage(url) ?? unknown()
      case 'db.ygoprodeck.com':
        return ygoprodeck(url)
      case 'api.lorcast.com':
        // Lorcast reports "no cards" as a 404 — the pipeline treats that as a
        // clean empty result, which is right: we capture no Lorcana fixtures.
        return json({ error: 'not found' }, 404)
      default:
        return unknown()
    }
  }

  return { handle, stats }
}
