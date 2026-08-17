/**
 * The corpus AS the catalog: a `fetchJson` that answers Scryfall,
 * pokemontcg.io, TCGdex and YGOPRODeck out of memory, so the real matcher
 * code in `src/lib/` runs unchanged and the sweep touches no network at all.
 *
 * The whole harness stands on how faithful this file is, so the rule is
 * stated once and kept everywhere below: **each endpoint implements its
 * DOCUMENTED filter semantics and nothing else.** Exact-field equality,
 * substring `contains`, prefix wildcards, sort order, page size. Where a real
 * endpoint's behaviour is not mechanically specified — Scryfall's `fuzzy`
 * name resolver is the only one — the approximation is named at its call site
 * and every finding that depends on it is reported in its own tier, because a
 * wrong card produced by a generous stub is a fact about the stub.
 *
 * An unrecognised URL is a LOUD failure, never an empty answer: a silently
 * unanswered endpoint is how a sweep measures a path that never executed
 * (scan-harness lesson 82). Unstubbed hits are recorded and the sweeps assert
 * the list is empty.
 *
 * Two knobs live on `globalThis.__CARDSTOCK_STUB__`:
 *   `pokemonPrimary` — 'alive' | 'dead'. The dead primary (HTTP 503) is
 *     production's own increasingly common shape and the only way to exercise
 *     `rankBriefs`/`dexMatch`, which sit behind a healthy primary.
 *   `unstubbed` — the recorder above.
 */

const state = () =>
  (globalThis.__CARDSTOCK_STUB__ ??= { pokemonPrimary: 'alive', unstubbed: [], calls: 0, byHost: new Map() })

/**
 * The stub's knobs and counters. Read through the GLOBAL on purpose: this
 * module is inlined into every esbuild bundle, so a module-scope singleton
 * would give each bundle its own private (and empty) copy.
 */
export const stubState = state

const corpus = () => {
  const c = globalThis.__CARDSTOCK_CORPUS__
  if (!c) throw new Error('apistub: no corpus installed — call loadCorpus() first')
  return c
}

function httpError(status, url) {
  return Object.assign(new Error(`HTTP ${status} for ${url}`), { status })
}

function unstubbed(url) {
  state().unstubbed.push(url)
  return Object.assign(new Error(`apistub: UNSTUBBED ${url}`), { unstubbed: true })
}

const norm = (name) =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const digits = (value) =>
  String(value ?? '')
    .replace(/\D+/g, '')
    .replace(/^0+(?=\d)/, '')

/* ------------------------------------------------------------- scryfall.com */

/** A corpus print as the Scryfall JSON `toCard` reads. Prices are empty: the
 *  matching layer never looks at them and a sweep must not imply it does. */
function scryfallRaw(print) {
  return {
    id: print.apiId,
    name: print.name,
    set: print.set,
    set_name: print.set,
    collector_number: print.number,
    rarity: print.rarity ?? undefined,
    lang: 'en',
    prices: {},
    finishes: ['nonfoil'],
  }
}

/**
 * Scryfall's `/cards/named?fuzzy=` — the ONE endpoint here whose real
 * behaviour is not a documented filter. Modelled on what Scryfall documents
 * about it: a fuzzy name resolves to a single card, and an ambiguous one is a
 * 404 rather than a guess.
 *
 * The approximation, deliberately CONSERVATIVE so this file cannot manufacture
 * the wrong-card findings the sweep exists to count:
 *   1. exact normalized name  → that card
 *   2. exactly one name containing the query as a normalized substring → it
 *   3. exactly one name whose words the query's words all prefix-match → it
 *   4. anything else → 404
 * Real Scryfall is more forgiving than steps 2–3 (it tolerates typos this
 * refuses), so MTG "refused" counts here are an UPPER bound on the real
 * refusal rate and MTG confident-wrong counts are a LOWER bound. Stated in
 * the report; never quietly assumed.
 */
function scryfallFuzzy(query, setCode) {
  const mtg = corpus().mtg
  const q = norm(query)
  if (!q) return null
  const scoped = (entry) => !setCode || entry.sample.set === setCode.toLowerCase()

  const exact = mtg.names.byNorm.get(q)
  if (exact && scoped(exact)) return exact
  if (exact && !scoped(exact)) return null

  const contains = mtg.names.index
    .find(q)
    .map((i) => mtg.names.list[i])
    .filter(scoped)
  if (contains.length === 1) return contains[0]
  if (contains.length > 1) return null

  const words = q.split(' ').filter(Boolean)
  if (!words.length) return null
  const prefixed = []
  for (const entry of mtg.names.list) {
    if (!scoped(entry)) continue
    const target = entry.norm.split(' ')
    if (words.every((w) => target.some((t) => t.startsWith(w)))) prefixed.push(entry)
    if (prefixed.length > 1) return null
  }
  return prefixed.length === 1 ? prefixed[0] : null
}

function scryfall(url, u) {
  const mtg = corpus().mtg
  if (!mtg) throw unstubbed(url)

  let m = u.pathname.match(/^\/sets\/([^/]+)$/)
  if (m) {
    const code = m[1].toLowerCase()
    const size = mtg.setSizes.get(code)
    if (!size) throw httpError(404, url)
    // `card_count` is the corpus's own count of that set's printings, which is
    // what Scryfall's field means. `printed_size` is NOT synthesized: the
    // bulk feed does not carry it, so the set-size fail-closed check in
    // mtgBySetNumber is an unfed path here and the sweeps never assert on it.
    return { code, card_count: size }
  }

  m = u.pathname.match(/^\/cards\/named$/)
  if (m) {
    const fuzzy = u.searchParams.get('fuzzy') ?? u.searchParams.get('exact')
    const entry = scryfallFuzzy(fuzzy, u.searchParams.get('set'))
    if (!entry) throw httpError(404, url)
    return scryfallRaw(entry.sample)
  }

  m = u.pathname.match(/^\/cards\/search$/)
  if (m) {
    // The only search this layer issues is `rawPrintings`: !"name" game:paper
    // [set:xx]. Exact-name by construction — an exact-name query is precisely
    // why that function is safe to expose (scryfall.ts's own docstring).
    const q = u.searchParams.get('q') ?? ''
    const exact = q.match(/!"([^"]*)"/)
    if (!exact) throw unstubbed(url)
    const set = q.match(/\bset:(\S+)/)?.[1]?.toLowerCase()
    const entry = mtg.names.byNorm.get(norm(exact[1]))
    if (!entry) throw httpError(404, url)
    const rows = set ? entry.rows.filter((p) => p.set === set) : entry.rows
    if (!rows.length) throw httpError(404, url)
    return { data: rows.map(scryfallRaw) }
  }

  m = u.pathname.match(/^\/cards\/([^/]+)\/([^/]+)$/)
  if (m) {
    const print = mtg.byCode.get(`${m[1].toLowerCase()}/${decodeURIComponent(m[2]).toLowerCase()}`)
    if (!print) throw httpError(404, url)
    return scryfallRaw(print)
  }

  m = u.pathname.match(/^\/cards\/([^/]+)$/)
  if (m) {
    const print = mtg.byId.get(m[1])
    if (!print) throw httpError(404, url)
    return scryfallRaw(print)
  }
  throw unstubbed(url)
}

/* ---------------------------------------------------------- pokemontcg.io */

/**
 * The primary's Lucene `q=`, restricted to the clauses `src/lib/pokemon.ts`
 * actually emits: `name:"exact phrase"`, `name:prefix*`, `number:"n"`,
 * `set.ptcgoCode:"x"`, `set.id:"x"`, `set.printedTotal:n`. ANDed, which is
 * what the API does with space-separated clauses. Anything else is a loud
 * failure rather than a silent empty page — a clause this cannot parse is a
 * change in the caller, and swallowing it would make the sweep measure a
 * query that never ran.
 */
function parseLucene(query) {
  const clauses = []
  const re = /(\S+?):(?:"([^"]*)"|(\S+))/g
  let m
  let consumed = 0
  while ((m = re.exec(query))) {
    clauses.push({ field: m[1], value: m[2] ?? m[3] })
    consumed += m[0].length
  }
  if (!clauses.length) return null
  // Bare words outside a field clause would change the meaning; refuse.
  if (query.replace(/\s+/g, '').length > consumed) return null
  return clauses
}

function pokemonPrimaryRaw(print, set) {
  return {
    id: print.rawId,
    name: print.name,
    number: print.number,
    rarity: print.rarity ?? undefined,
    supertype: 'Pokémon',
    set: {
      id: set?.id ?? print.set,
      name: set?.name ?? print.set,
      ptcgoCode: set?.ptcgoCode ?? undefined,
      printedTotal: set?.official ?? undefined,
      releaseDate: set?.releaseDate ?? '',
    },
    images: {},
    tcgplayer: undefined,
  }
}

function pokemonPrimarySearch(url, u) {
  const pokemon = corpus().pokemon
  if (!pokemon) throw unstubbed(url)
  if (u.pathname.startsWith('/v2/cards/')) {
    const print = pokemon.byId.get(decodeURIComponent(u.pathname.slice('/v2/cards/'.length)))
    if (!print) throw httpError(404, url)
    return { data: pokemonPrimaryRaw(print, pokemon.sets.get(print.set)) }
  }
  if (u.pathname !== '/v2/cards') throw unstubbed(url)
  const clauses = parseLucene(u.searchParams.get('q') ?? '')
  if (!clauses) throw unstubbed(`${url} (unparsed lucene)`)

  // AND semantics, but name clauses are applied FIRST so the pool starts at
  // one name's printings instead of the whole game — the difference between a
  // sweep that finishes and one that does not.
  const named = clauses.filter((c) => c.field === 'name')
  let pool = null
  for (const { value } of named) {
    const v = value.toLowerCase()
    const wildcard = v.endsWith('*')
    const q = norm(wildcard ? v.slice(0, -1) : v)
    let hit
    if (wildcard) {
      hit = []
      for (const entry of pokemon.names.list) {
        if (entry.norm.split(' ').some((w) => w.startsWith(q))) hit.push(...entry.rows)
      }
    } else {
      hit = pokemon.names.byNorm.get(q)?.rows ?? []
    }
    if (pool) {
      const keep = new Set(hit)
      pool = pool.filter((p) => keep.has(p))
    } else pool = hit
    if (!pool.length) break
  }
  pool ??= pokemon.prints
  for (const { field, value } of clauses) {
    if (!pool.length) break
    const v = value.toLowerCase()
    switch (field) {
      case 'name':
        break // applied above
      case 'number':
        pool = pool.filter((p) => p.number.toLowerCase() === v)
        break
      case 'set.ptcgoCode':
        pool = pool.filter((p) => (pokemon.sets.get(p.set)?.ptcgoCode ?? '').toLowerCase() === v)
        break
      case 'set.id':
        pool = pool.filter((p) => p.set.toLowerCase() === v)
        break
      case 'set.printedTotal':
        pool = pool.filter((p) => Number(pokemon.sets.get(p.set)?.official) === Number(value))
        break
      default:
        throw unstubbed(`${url} (unknown field ${field})`)
    }
  }
  const size = Number(u.searchParams.get('pageSize') ?? 30)
  // `orderBy=-set.releaseDate` — newest first, which matchPokemon relies on.
  const ordered = [...pool].sort((a, b) =>
    String(pokemon.sets.get(b.set)?.releaseDate ?? '').localeCompare(String(pokemon.sets.get(a.set)?.releaseDate ?? '')),
  )
  return { data: ordered.slice(0, size).map((p) => pokemonPrimaryRaw(p, pokemon.sets.get(p.set))) }
}

/* --------------------------------------------------------------- tcgdex */

function dexRaw(print, set) {
  return {
    id: print.rawId,
    localId: print.number,
    name: print.name,
    rarity: print.rarity ?? undefined,
    category: 'Pokemon',
    variants: { normal: true },
    set: {
      id: set?.id ?? print.set,
      name: set?.name ?? print.set,
      cardCount: { official: set?.official ?? undefined, total: set?.total ?? undefined },
    },
  }
}

function tcgdex(url, u) {
  const pokemon = corpus().pokemon
  if (!pokemon) throw unstubbed(url)
  const [, , lang, kind, ...rest] = u.pathname.split('/') // /v2/<lang>/<kind>[/<id>]
  const id = rest.length ? decodeURIComponent(rest.join('/')) : ''
  // The corpus is TCGdex's ENGLISH catalog only. Every other language answers
  // empty, and the sweeps record the localized-name arm as unfed rather than
  // reporting its silence as a result (lesson 82).
  if (lang !== 'en') return kind === 'sets' && !id ? [] : []

  if (kind === 'sets' && !id) {
    return [...pokemon.sets.values()].map((s) => ({
      id: s.id,
      name: s.name,
      cardCount: { official: s.official ?? undefined, total: s.total ?? undefined },
      releaseDate: s.releaseDate,
    }))
  }
  if (kind === 'sets' && id) {
    const set = pokemon.sets.get(id)
    if (!set) throw httpError(404, url)
    return {
      id: set.id,
      name: set.name,
      cardCount: { official: set.official ?? undefined, total: set.total ?? undefined },
      cards: pokemon.prints.filter((p) => p.set === id).map((p) => ({ id: p.rawId, localId: p.number, name: p.name })),
    }
  }
  if (kind === 'cards' && id) {
    const print = pokemon.byId.get(id)
    if (!print) throw httpError(404, url)
    return dexRaw(print, pokemon.sets.get(print.set))
  }
  if (kind === 'cards' && !id) {
    // Documented as a `contains` filter, which is exactly what pokemon.ts's
    // own comment relies on ("The contains-search has zero tolerance").
    const name = norm(u.searchParams.get('name') ?? '')
    if (!name) return []
    return pokemon.names.index
      .find(name)
      .flatMap((i) => pokemon.names.list[i].rows)
      .map((p) => ({ id: p.rawId, localId: p.number, name: p.name }))
  }
  throw unstubbed(url)
}

/* ------------------------------------------------------------ ygoprodeck */

function ygoRaw(card) {
  return card
}

function ygoprodeck(url, u) {
  const ygo = corpus().yugioh
  if (!ygo) throw unstubbed(url)

  if (u.pathname.endsWith('/cardsetsinfo.php')) {
    const hit = ygo.byCode.get((u.searchParams.get('setcode') ?? '').toUpperCase())
    // The real endpoint 400s an unknown code rather than answering empty —
    // ygoBySetCode's candidate loop depends on that shape.
    if (!hit) throw httpError(400, url)
    return { id: Number(hit.id) }
  }
  if (!u.pathname.endsWith('/cardinfo.php')) throw unstubbed(url)

  const id = u.searchParams.get('id')
  if (id != null) {
    const card = ygo.cards.get(String(Number(id)))
    if (!card) throw httpError(400, url)
    return { data: [ygoRaw(card)] }
  }
  const exact = u.searchParams.get('name')
  if (exact != null) {
    const cardId = ygo.byExactName.get(exact.toLowerCase())
    if (!cardId) throw httpError(400, url)
    return { data: [ygoRaw(ygo.cards.get(cardId))] }
  }
  const fname = u.searchParams.get('fname')
  if (fname != null) {
    const q = norm(fname)
    if (!q) throw httpError(400, url)
    const hits = ygo.names.index.find(q).map((i) => ygo.names.list[i])
    if (!hits.length) throw httpError(400, url)
    const limit = Number(u.searchParams.get('num') ?? hits.length)
    // The feed's own order, which is what "unranked" means in matchYgo's
    // docstring — the guard there depends on NOT being handed a best fit.
    return { data: hits.slice(0, limit).map((entry) => ygoRaw(ygo.cards.get(entry.sample.id))) }
  }
  throw unstubbed(url)
}

/* ------------------------------------------------------------------ door */

const HOSTS = {
  'api.scryfall.com': scryfall,
  'api.pokemontcg.io': pokemonPrimarySearch,
  'api.tcgdex.net': tcgdex,
  'db.ygoprodeck.com': ygoprodeck,
}

export async function fetchJson(url, options) {
  const s = state()
  s.calls++
  if (options?.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
  const u = new URL(url)
  s.byHost.set(u.hostname, (s.byHost.get(u.hostname) ?? 0) + 1)
  if (u.hostname === 'api.pokemontcg.io' && s.pokemonPrimary === 'dead') {
    // The shape production meets: the primary has gone stale and 5xxs.
    throw httpError(503, url)
  }
  const handler = HOSTS[u.hostname]
  if (!handler) throw unstubbed(url)
  return handler(url, u)
}

export function isAbort(err) {
  return err?.name === 'AbortError' || /aborted/i.test(String(err?.message ?? ''))
}

export function httpStatus(err) {
  return typeof err?.status === 'number' ? err.status : null
}

export function linkAbort() {
  return () => {}
}
