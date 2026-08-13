/**
 * fetchJson stub for the champion-lead guard: a tiny Riftbound mirror whose
 * shape is the point — one champion carrying two epithets across several
 * printings, and one champion carrying exactly one. The guard has to tell
 * those apart, and a three-card universe cannot show that (lesson 20: a small
 * stub hides danger as readily as it flatters).
 */

const CATEGORIES = [{ categoryId: 89, name: 'Riftbound', displayName: 'Riftbound: League of Legends TCG' }]

const GROUPS = [
  { groupId: 24560, name: 'Unleashed', abbreviation: 'UNL', publishedOn: '2026-05-01T00:00:00' },
]

const card = (productId, name, number) => ({
  productId,
  name,
  imageUrl: `https://example.invalid/${productId}.jpg`,
  url: `https://example.invalid/${productId}`,
  extendedData: [
    { name: 'Number', value: number },
    { name: 'Rarity', value: 'Rare' },
  ],
})

const PRODUCTS = [
  // Two distinct epithets, three printings — ONE of these is not a second answer.
  card(1, 'Ahri - Alluring', '040/219'),
  card(2, 'Ahri - Alluring (Alternate Art)', '040/219'),
  card(3, 'Ahri - Alluring (Launch Exclusive)', '040/219'),
  card(4, 'Ahri - Inquisitive', '041/219'),
  // A champion with exactly one card: a bare lead IS decisive here.
  card(5, 'Nilah - Joyful Ascetic', '115/219'),
  // No epithet at all.
  card(6, 'Body Rune', 'R04'),
]

const PRICES = PRODUCTS.map((p) => ({ productId: p.productId, subTypeName: 'Normal', marketPrice: 1.5 }))

export async function fetchJson(url) {
  if (/\/tcgplayer\/categories$/.test(url)) return { results: CATEGORIES }
  if (/\/tcgplayer\/89\/groups$/.test(url)) return { results: GROUPS }
  if (/\/tcgplayer\/89\/24560\/products$/.test(url)) return { results: PRODUCTS }
  if (/\/tcgplayer\/89\/24560\/prices$/.test(url)) return { results: PRICES }
  throw new Error(`riftbound-net stub: unexpected url ${url}`)
}

export function isAbort() {
  return false
}
