/**
 * fetchJson stub for the Yu-Gi-Oh print-code lookup: YGOPRODeck's set-code
 * endpoint (an EXACT string match, which is the whole reason the caller has
 * to try several spellings) plus the card-by-id endpoint it hands off to.
 *
 * Card ids here are the stub's own, not the live database's — the shape is
 * what the tests are about, and a real-looking passcode in a fixture invites
 * someone to trust it later.
 */

const CARD = {
  id: 10000085,
  name: 'I:P Masquerena',
  type: 'Link Monster',
  desc: '2 non-Link Monsters',
  atk: 800,
  race: 'Cyberse',
  attribute: 'DARK',
  card_images: [{ image_url: 'https://example.invalid/85.jpg', image_url_small: 'https://example.invalid/85s.jpg' }],
  // The generic headline is a cheap reprint's price; the secret rare is not.
  card_prices: [{ tcgplayer_price: '2.50', ebay_price: '3.00' }],
  card_sets: [
    { set_name: 'Duel Overload', set_code: 'DUOV-EN005', set_rarity: 'Ultra Rare', set_price: '4.25' },
    { set_name: 'Battles of Legend: Monstrous Revenge', set_code: 'BLMR-EN085', set_rarity: 'Secret Rare', set_price: '25.00' },
  ],
}

/** Only the exactly-printed spelling is known, as on the live endpoint. */
const SET_CODES = {
  'BLMR-EN085': CARD,
  'DUOV-EN005': CARD,
}

export const asked = []

export async function fetchJson(url) {
  asked.push(url)
  const setcode = url.match(/cardsetsinfo\.php\?setcode=([^&]+)/)
  if (setcode) {
    const card = SET_CODES[decodeURIComponent(setcode[1]).toUpperCase()]
    if (!card) throw new Error('HTTP 400')
    const printing = card.card_sets.find((s) => s.set_code === decodeURIComponent(setcode[1]).toUpperCase())
    return { id: card.id, name: card.name, ...printing }
  }
  const byId = url.match(/cardinfo\.php\?id=(\d+)/)
  if (byId) return String(CARD.id) === byId[1] ? { data: [CARD] } : { data: [] }
  const fname = url.match(/cardinfo\.php\?fname=([^&]+)/)
  if (fname) {
    // The name search knows nothing about codes — that is the gap the code
    // lookup exists to fill.
    const needle = decodeURIComponent(fname[1]).toLowerCase()
    return { data: CARD.name.toLowerCase().includes(needle) ? [CARD] : [] }
  }
  throw new Error(`ygo-net stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}
