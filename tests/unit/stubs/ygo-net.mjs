/**
 * fetchJson stub for the Yu-Gi-Oh print-code lookup: YGOPRODeck's set-code
 * endpoint (an EXACT string match, which is the whole reason the caller has
 * to try several spellings) plus the card-by-id endpoint it hands off to.
 *
 * Card ids here are the stub's own, not the live database's — the shape is
 * what the tests are about, and a real-looking passcode in a fixture invites
 * someone to trust it later. The SET LISTS are real, because they are the
 * evidence: the region infix and the rarity split are the thing under test,
 * and inventing them would prove the tests agree with themselves.
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

/**
 * Gradius in Pharaoh's Servant, exactly as YGOPRODeck lists it (verified
 * against the feed 2026-08-17). Four rows, three spellings of one number, and
 * the printed code is the only thing a collector can type: PSV-089 and
 * PSV-E089 are different regions at different prices, and PSV-EN089 is listed
 * TWICE at two rarities, which no code can choose between.
 */
const GRADIUS = {
  id: 10000089,
  name: 'Gradius',
  type: 'Normal Monster',
  atk: 1200,
  def: 800,
  level: 4,
  race: 'Machine',
  attribute: 'LIGHT',
  card_images: [{ image_url: 'https://example.invalid/89.jpg', image_url_small: 'https://example.invalid/89s.jpg' }],
  card_prices: [{ tcgplayer_price: '0.19', ebay_price: '1.00' }],
  card_sets: [
    { set_name: "Pharaoh's Servant", set_code: 'PSV-089', set_rarity: 'Short Print', set_price: '1.74' },
    { set_name: "Pharaoh's Servant", set_code: 'PSV-E089', set_rarity: 'Short Print', set_price: '4.67' },
    { set_name: "Pharaoh's Servant", set_code: 'PSV-EN089', set_rarity: 'Common', set_price: '0' },
    { set_name: "Pharaoh's Servant", set_code: 'PSV-EN089', set_rarity: 'Short Print', set_price: '2' },
  ],
}

/**
 * 3-Hump Lacooda's Ancient Sanctuary printing, which the feed lists ONLY in
 * its region-less spelling (verified 2026-08-17). A collector who types the
 * English code for it must still be answered — that is the cross-language rule
 * `sameYgoCode` exists for, and the exact-first selection must not cost it.
 */
const LACOODA = {
  id: 10000070,
  name: '3-Hump Lacooda',
  type: 'Effect Monster',
  atk: 500,
  def: 1500,
  level: 3,
  race: 'Beast',
  attribute: 'EARTH',
  card_images: [{ image_url: 'https://example.invalid/70.jpg', image_url_small: 'https://example.invalid/70s.jpg' }],
  card_prices: [{ tcgplayer_price: '0.30' }],
  card_sets: [{ set_name: 'Ancient Sanctuary', set_code: 'AST-070', set_rarity: 'Common', set_price: '1.07' }],
}

const CARDS = [CARD, GRADIUS, LACOODA]

/**
 * Only the exactly-printed spelling is known, as on the live endpoint — so the
 * index is DERIVED from the set lists rather than hand-listed beside them,
 * and cannot drift from them as cards are added here.
 */
const SET_CODES = {}
for (const card of CARDS) {
  for (const printing of card.card_sets) SET_CODES[printing.set_code.toUpperCase()] ??= card
}

/**
 * One deliberate exception, and it is the only one: an endpoint that resolves
 * a spelling the card's own set list does not carry. The live index and
 * `card_sets` come from the same table today, so this models a disagreement
 * rather than reproducing one — it is what keeps the cross-language fallback
 * inside `printingByCode` covered, instead of merely believed.
 */
SET_CODES['AST-EN070'] = LACOODA

export const asked = []

export async function fetchJson(url) {
  asked.push(url)
  const setcode = url.match(/cardsetsinfo\.php\?setcode=([^&]+)/)
  if (setcode) {
    const code = decodeURIComponent(setcode[1]).toUpperCase()
    const card = SET_CODES[code]
    if (!card) throw new Error('HTTP 400')
    const printing = card.card_sets.find((s) => s.set_code.toUpperCase() === code)
    return { id: card.id, name: card.name, ...printing }
  }
  const byId = url.match(/cardinfo\.php\?id=(\d+)/)
  if (byId) {
    const card = CARDS.find((c) => String(c.id) === byId[1])
    return { data: card ? [card] : [] }
  }
  const fname = url.match(/cardinfo\.php\?fname=([^&]+)/)
  if (fname) {
    // The name search knows nothing about codes — that is the gap the code
    // lookup exists to fill.
    const needle = decodeURIComponent(fname[1]).toLowerCase()
    return { data: CARDS.filter((c) => c.name.toLowerCase().includes(needle)) }
  }
  throw new Error(`ygo-net stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}
