/**
 * fetchJson stub for pokemon.ts unit tests: a dead pokemontcg.io primary and
 * a tiny multi-language TCGdex — the ja "Ancient Roar" pair (sv4K/sv4M, both
 * 66 cards, mirroring the real paired-release size collision) plus a German
 * localized name for a Base Set card.
 */

export const requested = []

const JA_SETS = [
  { id: 'sv4K', name: '古代の咆哮', cardCount: { official: 66, total: 88 } },
  { id: 'sv4M', name: '未来の一閃', cardCount: { official: 66, total: 89 } },
]

const JA_SET_CARDS = {
  sv4K: [
    { id: 'sv4K-045', localId: '045', name: 'ドンファン' },
    { id: 'sv4K-046', localId: '046', name: 'トドロクツキex' },
  ],
  sv4M: [{ id: 'sv4M-046', localId: '046', name: 'テツノブジンex' }],
}

const JA_CARDS = {
  'sv4K-045': {
    id: 'sv4K-045',
    localId: '045',
    name: 'ドンファン',
    category: 'Pokemon',
    image: 'https://assets.tcgdex.net/ja/sv/sv4K/045',
    set: { id: 'sv4K', name: '古代の咆哮', cardCount: { official: 66, total: 88 } },
  },
  'sv4K-046': {
    id: 'sv4K-046',
    localId: '046',
    name: 'トドロクツキex',
    category: 'Pokemon',
    image: 'https://assets.tcgdex.net/ja/sv/sv4K/046',
    set: { id: 'sv4K', name: '古代の咆哮', cardCount: { official: 66, total: 88 } },
  },
  'sv4M-046': {
    id: 'sv4M-046',
    localId: '046',
    name: 'テツノブジンex',
    category: 'Pokemon',
    image: 'https://assets.tcgdex.net/ja/sv/sv4M/046',
    set: { id: 'sv4M', name: '未来の一閃', cardCount: { official: 66, total: 89 } },
  },
}

const DE_BRIEFS = [{ id: 'base1-4', localId: '4', name: 'Glurak' }]

const EN_CARDS = {
  'base1-4': {
    id: 'base1-4',
    localId: '4',
    name: 'Charizard',
    category: 'Pokemon',
    image: 'https://assets.tcgdex.net/en/base/base1/4',
    set: { id: 'base1', name: 'Base Set', cardCount: { official: 102, total: 102 } },
    variants: { holo: true },
  },
}

export async function fetchJson(url) {
  requested.push(url)
  const u = new URL(url)
  if (u.hostname === 'api.pokemontcg.io') {
    throw Object.assign(new Error('HTTP 503 for stubbed pokemontcg.io (primary is dead)'), { status: 503 })
  }
  if (u.hostname !== 'api.tcgdex.net') throw new Error(`tcgdex-net stub: unexpected host ${u.hostname}`)
  const [, , lang, kind, id] = u.pathname.split('/') // /v2/<lang>/<kind>[/<id>]
  if (kind === 'sets' && !id) {
    if (lang === 'ja') return JA_SETS
    if (lang === 'en') return [{ id: 'base1', name: 'Base Set', cardCount: { official: 102, total: 102 } }]
    return []
  }
  if (kind === 'sets' && id) {
    const brief = JA_SETS.find((s) => s.id === id)
    if (lang === 'ja' && brief) return { ...brief, cards: JA_SET_CARDS[id] ?? [] }
    throw Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 })
  }
  if (kind === 'cards' && id) {
    const card = lang === 'ja' ? JA_CARDS[id] : lang === 'en' ? EN_CARDS[id] : null
    if (card) return card
    throw Object.assign(new Error(`HTTP 404 for ${url}`), { status: 404 })
  }
  if (kind === 'cards' && !id) {
    const name = (u.searchParams.get('name') ?? '').toLowerCase()
    if (lang === 'de') return DE_BRIEFS.filter((b) => b.name.toLowerCase().includes(name))
    return []
  }
  throw new Error(`tcgdex-net stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}

/** Mirrors fetchJson's real export: the status rides on the rejection. */
export function httpStatus(err) {
  return typeof err?.status === 'number' ? err.status : null
}
