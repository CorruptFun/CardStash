/**
 * fetchJson stub for the "right card, wrong edition" case: pokemontcg.io
 * ALIVE but stale — it answers for the name and has never heard of the set
 * actually printed on the card — while TCGdex carries the current print.
 *
 * Modelled on the real report: a Trubbish printed "056/086" (Chaos Rising,
 * an 86-card set the primary does not index) came back as Fusion Strike #168,
 * because #168 is simply the newest Trubbish the stale catalog knows.
 */

export const requested = []

/** Newest-first, the way `orderBy=-set.releaseDate` returns them. */
const PRIMARY = [
  { id: 'swsh8-168', name: 'Trubbish', number: '168', rarity: 'Common',
    set: { id: 'swsh8', name: 'Fusion Strike', ptcgoCode: 'FST', printedTotal: 264, releaseDate: '2021/11/12' } },
  { id: 'swsh6-119', name: 'Trubbish', number: '119',
    set: { id: 'swsh6', name: 'Chilling Reign', ptcgoCode: 'CRE', printedTotal: 198, releaseDate: '2021/06/18' } },
  { id: 'sm9-56', name: 'Trubbish', number: '56',
    set: { id: 'sm9', name: 'Team Up', ptcgoCode: 'TEU', printedTotal: 181, releaseDate: '2019/02/01' } },
]

const DEX_BRIEFS = [
  { id: 'sm9-56', localId: '56', name: 'Trubbish', image: 'https://assets.tcgdex.net/en/sm/sm9/56' },
  { id: 'A1-097', localId: '097', name: 'Trubbish', image: 'https://assets.tcgdex.net/en/tcgp/A1/097' },
  { id: 'me04-056', localId: '056', name: 'Trubbish', image: 'https://assets.tcgdex.net/en/me/me04/056' },
]

const CHAOS_RISING = { id: 'me04', name: 'Chaos Rising', cardCount: { official: 86, total: 120 } }

const DEX_CARDS = {
  'me04-056': {
    id: 'me04-056', localId: '056', name: 'Trubbish', category: 'Pokemon', stage: 'Basic', rarity: 'Common',
    image: 'https://assets.tcgdex.net/en/me/me04/056', set: CHAOS_RISING,
    variants: { normal: true, reverse: true },
  },
  'sm9-56': {
    id: 'sm9-56', localId: '56', name: 'Trubbish', category: 'Pokemon',
    set: { id: 'sm9', name: 'Team Up', cardCount: { official: 181, total: 196 } },
  },
  // Pokémon TCG Pocket — digital only, never a printing of a paper card.
  'A1-097': {
    id: 'A1-097', localId: '097', name: 'Trubbish', category: 'Pokemon',
    set: { id: 'A1', name: 'Genetic Apex', cardCount: { official: 226, total: 286 } },
  },
}

export async function fetchJson(url) {
  requested.push(url)
  const u = new URL(url)
  if (u.hostname === 'api.pokemontcg.io') {
    const q = u.searchParams.get('q') ?? ''
    const name = (q.match(/name:"([^"]+)"/) ?? q.match(/name:([^\s*]+)\*/))?.[1] ?? ''
    const number = q.match(/number:"([^"]+)"/)?.[1]
    const total = q.match(/set\.printedTotal:(\d+)/)?.[1]
    let rows = PRIMARY.filter((r) => r.name.toLowerCase().startsWith(name.toLowerCase()))
    if (number) rows = rows.filter((r) => r.number === number)
    if (total) rows = rows.filter((r) => String(r.set.printedTotal) === total)
    return { data: rows }
  }
  if (u.hostname !== 'api.tcgdex.net') throw new Error(`pokemon-stale stub: unexpected host ${u.hostname}`)
  const [, , lang, kind, rawId] = u.pathname.split('/')
  const id = rawId ? decodeURIComponent(rawId) : ''
  if (kind === 'cards' && id) {
    const card = lang === 'en' ? DEX_CARDS[id] : null
    if (card) return card
    throw new Error(`HTTP 404 for ${url}`)
  }
  if (kind === 'cards') {
    const name = (u.searchParams.get('name') ?? '').toLowerCase()
    return lang === 'en' ? DEX_BRIEFS.filter((b) => b.name.toLowerCase().includes(name)) : []
  }
  if (kind === 'sets' && !id) return lang === 'en' ? [CHAOS_RISING] : []
  if (kind === 'sets' && id === 'me04' && lang === 'en') return { ...CHAOS_RISING, cards: [DEX_BRIEFS[2]] }
  if (kind === 'sets') throw new Error(`HTTP 404 for ${url}`)
  throw new Error(`pokemon-stale stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}
