/**
 * tcgcsv stub for sealed.ts unit tests: a two-category Pokémon world — the
 * English "Surging Sparks" set and the Japanese "Ancient Roar" set — with
 * one pack and one box each. Mirrors the shapes tcgcsv.ts produces.
 */

const prices = { best: null, bestFoil: null, entries: [], updatedAt: 0 }

function sealedCard(productId, name, group, categoryId, kind) {
  return {
    id: `pokemon:tp-${productId}`,
    game: 'pokemon',
    apiId: `tp-${productId}`,
    name,
    setCode: group.abbreviation,
    setName: group.name,
    typeLine: kind,
    supertype: 'Sealed',
    sealed: { categoryId, groupId: group.groupId, kind },
    prices,
    links: {},
  }
}

const EN = { groupId: 23600, categoryId: 3, name: 'SV08: Surging Sparks', abbreviation: 'SV08' }
const JP = { groupId: 23411, categoryId: 85, name: 'SV4K: Ancient Roar', abbreviation: 'SV4K' }

const CONTENTS = {
  23600: {
    group: EN,
    singles: [],
    sealed: [
      sealedCard(561001, 'Scarlet & Violet: Surging Sparks Booster Box', EN, 3, 'Booster box'),
      sealedCard(561002, 'Scarlet & Violet: Surging Sparks Booster Pack', EN, 3, 'Booster pack'),
      sealedCard(561003, 'Scarlet & Violet: Surging Sparks Elite Trainer Box', EN, 3, 'Elite Trainer Box'),
    ],
  },
  23411: {
    group: JP,
    singles: [],
    sealed: [
      sealedCard(519001, 'Scarlet & Violet: Ancient Roar Booster Box (Japanese)', JP, 85, 'Booster box'),
      sealedCard(519002, 'Scarlet & Violet: Ancient Roar Booster Pack (Japanese)', JP, 85, 'Booster pack'),
    ],
  },
}

export async function tcgplayerGroups(game) {
  if (game !== 'pokemon') return []
  return [EN, JP]
}

export async function groupContents(_game, group) {
  const contents = CONTENTS[group.groupId]
  if (!contents) throw new Error(`no such group ${group.groupId}`)
  return contents
}

export function sealedKind() {
  return 'Sealed'
}
