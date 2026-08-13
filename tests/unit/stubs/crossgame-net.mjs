/**
 * fetchJson stub reproducing the exact real-world conditions under which a
 * Pokémon card comes back as a Yu-Gi-Oh one:
 *
 *  - pokemontcg.io is down (it 500s routinely — the fixture manifest carries
 *    three of them, one for the very "Tauros GX" query this is about),
 *  - TCGdex, the fallback, doesn't know the read either (it is not the card's
 *    name — it is an attack name OCR lifted off the card's body),
 *  - Scryfall doesn't know it,
 *  - and YGOPRODeck's `fname=` is a SUBSTRING filter over ~13k cards, so it
 *    finds something for almost any fragment.
 *
 * The Yu-Gi-Oh row below is illustrative rather than a claim about a specific
 * printing: what the test pins down is the SELECTION behaviour of the sweep —
 * that a game which answers nothing cedes its card to whichever other game's
 * catalogue happened to contain the fragment. The scan matrix cannot show this
 * because its captured Yu-Gi-Oh universe is 131 rows, small enough that every
 * cross-game match scores far below any threshold.
 */

export const requested = []

/** A fragment OCR lifts off a Pokémon card that is also somebody's card name. */
const COLLIDING_READ = 'Rage'

const YGO_ROW = {
  id: 12345678,
  name: COLLIDING_READ,
  type: 'Normal Monster',
  race: 'Beast',
  attribute: 'EARTH',
  level: 4,
  atk: 1500,
  def: 1200,
  desc: 'A stand-in for any card whose name a fragment can hit exactly.',
  card_images: [{ image_url: 'https://example.invalid/x.jpg' }],
  card_sets: [{ set_name: 'Test Set', set_code: 'TST-EN001', set_rarity: 'Common', set_price: '1.00' }],
  card_prices: [{ tcgplayer_price: '1.00' }],
}

export function isAbort(err) {
  return err?.name === 'AbortError'
}

export async function fetchJson(url) {
  requested.push(url)

  // The primary Pokémon API is down — the condition that leaves the field open.
  if (url.includes('api.pokemontcg.io')) throw new Error('HTTP 500 for ' + url)

  // TCGdex (the Pokémon fallback) has no card by this name.
  if (url.includes('api.tcgdex.net')) {
    if (/\/sets\b/.test(url) || /\/series\b/.test(url)) return []
    return []
  }

  // Scryfall answers "no card matched".
  if (url.includes('api.scryfall.com')) throw new Error('HTTP 404 for ' + url)

  // Lorcast has nothing either.
  if (url.includes('api.lorcast.com')) return { results: [] }

  if (url.includes('db.ygoprodeck.com')) {
    const query = new URL(url).searchParams
    const exact = query.get('name')
    const fname = query.get('fname')
    const id = query.get('id')
    if (id != null) return id === String(YGO_ROW.id) ? { data: [YGO_ROW] } : { data: [] }
    // Live semantics: name= is exact, fname= is a substring filter.
    if (exact != null) {
      if (exact.toLowerCase() === YGO_ROW.name.toLowerCase()) return { data: [YGO_ROW] }
      throw new Error('No card matching your query was found in the database.')
    }
    if (fname != null) {
      if (YGO_ROW.name.toLowerCase().includes(fname.toLowerCase())) return { data: [YGO_ROW] }
      throw new Error('No card matching your query was found in the database.')
    }
  }

  throw new Error('HTTP 404 for ' + url)
}

export { COLLIDING_READ }
