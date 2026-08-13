import { db } from './db'
import { mergePrices } from './prices'
import type {
  Card,
  CollectionItem,
  Condition,
  Deck,
  DeckCard,
  Finish,
  Friend,
  PriceEntry,
  PricePoint,
  SharedCard,
  TradeRecord,
  WantRow,
} from './types'
import { tcgplayerSearchLink, uid, ymd } from './util'

/** `?demo=1` / Settings → Demo data: a believable starter collection. */

type DemoSpec = Omit<Card, 'prices' | 'links'> & {
  usd?: number
  usdFoil?: number
}

function demoCard(spec: DemoSpec): Card {
  const { usd, usdFoil, ...card } = spec
  const entries: PriceEntry[] = []
  if (usd) entries.push({ source: 'tcgplayer', kind: 'market', finish: 'nonfoil', currency: 'USD', value: usd })
  if (usdFoil) entries.push({ source: 'tcgplayer', kind: 'market', finish: 'foil', currency: 'USD', value: usdFoil })
  return {
    ...card,
    prices: mergePrices(entries),
    links: {
      tcgplayer: tcgplayerSearchLink(card.name),
      ebaySold: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(card.name)}&LH_Sold=1&LH_Complete=1`,
    },
  }
}

const scry = (id: string, size: 'small' | 'large') =>
  `https://cards.scryfall.io/${size === 'small' ? 'small' : 'large'}/front/${id[0]}/${id[1]}/${id}.jpg`

const MTG_DEMO: Card[] = [
  demoCard({
    id: 'mtg:demo-bolt',
    game: 'mtg',
    apiId: 'demo-bolt',
    name: 'Lightning Bolt',
    setCode: 'CLB',
    setName: 'Battle for Baldur\'s Gate',
    number: '187',
    rarity: 'uncommon',
    typeLine: 'Instant',
    subtext: 'Lightning Bolt deals 3 damage to any target.',
    manaCost: '{R}',
    cmc: 1,
    colors: ['R'],
    supertype: 'Instant',
    usd: 1.85,
    usdFoil: 4.2,
    imageSmall: scry('f29ba16f-c8fb-42fe-aabf-87089cb214a7', 'small'),
    imageLarge: scry('f29ba16f-c8fb-42fe-aabf-87089cb214a7', 'large'),
  }),
  demoCard({
    id: 'mtg:demo-ragavan',
    game: 'mtg',
    apiId: 'demo-ragavan',
    name: 'Ragavan, Nimble Pilferer',
    setCode: 'MH2',
    setName: 'Modern Horizons 2',
    number: '138',
    rarity: 'mythic',
    typeLine: 'Legendary Creature — Monkey Pirate',
    subtext: 'Whenever Ragavan deals combat damage to a player, create a Treasure token…',
    manaCost: '{R}',
    cmc: 1,
    colors: ['R'],
    supertype: 'Creature',
    usd: 38.5,
    usdFoil: 55,
    imageSmall: scry('a1b48479-b249-4a51-a8a5-8f4c76a1e433', 'small'),
    imageLarge: scry('a1b48479-b249-4a51-a8a5-8f4c76a1e433', 'large'),
  }),
  demoCard({
    id: 'mtg:demo-sheoldred',
    game: 'mtg',
    apiId: 'demo-sheoldred',
    name: 'Sheoldred, the Apocalypse',
    setCode: 'DMU',
    setName: 'Dominaria United',
    number: '107',
    rarity: 'mythic',
    typeLine: 'Legendary Creature — Phyrexian Praetor',
    subtext: 'Whenever you draw a card, you gain 2 life. Whenever an opponent draws a card, they lose 2 life.',
    manaCost: '{2}{B}{B}',
    cmc: 4,
    colors: ['B'],
    supertype: 'Creature',
    usd: 52,
    usdFoil: 68.9,
    imageSmall: scry('d67be074-cdd4-41d9-ac89-0a0456c4e4b2', 'small'),
    imageLarge: scry('d67be074-cdd4-41d9-ac89-0a0456c4e4b2', 'large'),
  }),
  demoCard({
    id: 'mtg:demo-orcish',
    game: 'mtg',
    apiId: 'demo-orcish',
    name: 'Orcish Bowmasters',
    setCode: 'LTR',
    setName: 'Tales of Middle-earth',
    number: '103',
    rarity: 'rare',
    typeLine: 'Creature — Orc Archer',
    subtext: 'Flash. When Orcish Bowmasters enters… amass Orcs 1.',
    manaCost: '{1}{B}',
    cmc: 2,
    colors: ['B'],
    supertype: 'Creature',
    usd: 21.4,
    imageSmall: scry('703e7ecf-3d73-40c1-8cfe-0758ba817101', 'small'),
    imageLarge: scry('703e7ecf-3d73-40c1-8cfe-0758ba817101', 'large'),
  }),
  demoCard({
    id: 'mtg:demo-swamp',
    game: 'mtg',
    apiId: 'demo-swamp',
    name: 'Swamp',
    setCode: 'DMU',
    setName: 'Dominaria United',
    number: '272',
    rarity: 'common',
    typeLine: 'Basic Land — Swamp',
    manaCost: '',
    cmc: 0,
    colors: [],
    supertype: 'Land',
    usd: 0.2,
    imageSmall: scry('91d3d1fe-9f7b-42ce-be76-9f1b921b8bcc', 'small'),
    imageLarge: scry('91d3d1fe-9f7b-42ce-be76-9f1b921b8bcc', 'large'),
  }),
]

const pkmImg = (id: string, size: 'small' | 'large') =>
  `https://images.pokemontcg.io/${id.replace('-', '/')}${size === 'large' ? '_hires' : ''}.png`

const POKEMON_DEMO: Card[] = [
  demoCard({
    id: 'pokemon:demo-zard',
    game: 'pokemon',
    apiId: 'demo-zard',
    name: 'Charizard ex',
    setCode: 'OBF',
    setName: 'Obsidian Flames',
    number: '125',
    rarity: 'Double Rare',
    typeLine: 'Pokémon — Stage 2 · ex',
    subtext: 'Ability: Infernal Reign — When you play this Pokémon… attach up to 3 Basic Fire Energy.',
    supertype: 'Pokémon',
    usd: 42.7,
    usdFoil: 42.7,
    imageSmall: pkmImg('sv3-125', 'small'),
    imageLarge: pkmImg('sv3-125', 'large'),
  }),
  demoCard({
    id: 'pokemon:demo-pika',
    game: 'pokemon',
    apiId: 'demo-pika',
    name: 'Pikachu',
    setCode: 'MEW',
    setName: 'Scarlet & Violet 151',
    number: '25',
    rarity: 'Common',
    typeLine: 'Pokémon — Basic',
    supertype: 'Pokémon',
    usd: 0.9,
    imageSmall: pkmImg('sv3pt5-25', 'small'),
    imageLarge: pkmImg('sv3pt5-25', 'large'),
  }),
  demoCard({
    id: 'pokemon:demo-iono',
    game: 'pokemon',
    apiId: 'demo-iono',
    name: 'Iono',
    setCode: 'PAL',
    setName: 'Paldea Evolved',
    number: '185',
    rarity: 'Ultra Rare',
    typeLine: 'Trainer — Supporter',
    subtext:
      'Each player shuffles their hand into their deck, then draws a card for each of their remaining prize cards.',
    supertype: 'Trainer',
    usd: 16.8,
    imageSmall: pkmImg('sv2-185', 'small'),
    imageLarge: pkmImg('sv2-185', 'large'),
  }),
]

const ygoLarge = (id: string) => `https://images.ygoprodeck.com/images/cards/${id}.jpg`
const ygoSmall = (id: string) => `https://images.ygoprodeck.com/images/cards_small/${id}.jpg`

const YGO_DEMO: Card[] = [
  demoCard({
    id: 'yugioh:demo-dm',
    game: 'yugioh',
    apiId: '46986414',
    name: 'Dark Magician',
    setCode: 'LOB',
    setName: 'Legend of Blue Eyes White Dragon',
    number: 'LOB-005',
    rarity: 'Ultra Rare',
    typeLine: 'Normal Monster — DARK Spellcaster · Lv.7 · ATK 2500 · DEF 2100',
    subtext: 'The ultimate wizard in terms of attack and defense.',
    supertype: 'Monster',
    usd: 7.4,
    imageSmall: ygoSmall('46986414'),
    imageLarge: ygoLarge('46986414'),
  }),
  demoCard({
    id: 'yugioh:demo-ash',
    game: 'yugioh',
    apiId: '14558127',
    name: 'Ash Blossom & Joyous Spring',
    setCode: 'MACR',
    setName: 'Maximum Crisis',
    number: 'MACR-EN036',
    rarity: 'Secret Rare',
    typeLine: 'Tuner/Effect Monster — FIRE Zombie · Lv.3 · ATK 0 · DEF 1800',
    subtext:
      'When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.',
    supertype: 'Monster',
    usd: 3.9,
    imageSmall: ygoSmall('14558127'),
    imageLarge: ygoLarge('14558127'),
  }),
]

const DEMO_CARDS: Card[] = [...MTG_DEMO, ...POKEMON_DEMO, ...YGO_DEMO]

/** Deterministic wandering price history ending at today's price. */
function demoHistory(cardId: string, endPrice: number, days = 30): PricePoint[] {
  let seed = 0
  for (const ch of cardId) seed = (seed * 31 + ch.charCodeAt(0)) & 0x7fffffff
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const points: PricePoint[] = []
  let price = endPrice * (0.86 + random() * 0.1)
  for (let back = days; back >= 0; back--) {
    price = Math.max(0.05, price * (0.985 + random() * 0.036))
    points.push({ cardId, date: ymd(Date.now() - back * 86_400_000), best: price, foil: null, currency: 'USD' })
  }
  const scale = endPrice / points[points.length - 1].best!
  for (const point of points) point.best = Math.round(point.best! * scale * 100) / 100
  return points
}

export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const purchasePrices: Record<string, number> = {
    'Ragavan, Nimble Pilferer': 45,
    'Sheoldred, the Apocalypse': 31.5,
    'Charizard ex': 24,
    'Lightning Bolt': 0.75,
    Iono: 21,
  }
  // Spares flagged for trade, so the Friends tab has a binder to share.
  const forTradeByName: Record<string, number> = { 'Lightning Bolt': 3, Swamp: 4, Iono: 1 }
  const collection: CollectionItem[] = DEMO_CARDS.map((card, index) => ({
    id: `demo-item-${index}`,
    cardId: card.id,
    game: card.game,
    name: card.name,
    setCode: card.setCode,
    number: card.number,
    finish: card.name === 'Charizard ex' || card.name === 'Ash Blossom & Joyous Spring' ? 'holo' : 'nonfoil',
    condition: 'NM',
    qty: card.name === 'Swamp' ? 8 : card.name === 'Lightning Bolt' ? 4 : card.supertype === 'Trainer' ? 2 : 1,
    forTrade: forTradeByName[card.name],
    purchasePrice: purchasePrices[card.name],
    addedAt: now - DEMO_CARDS.indexOf(card) * 3_600_000,
    card,
  }))

  // One sealed product, still unopened, to show off pack tracking.
  const sealedDemo = demoCard({
    id: 'mtg:tp-demo-mh3-box',
    game: 'mtg',
    apiId: 'tp-demo-mh3-box',
    name: 'Modern Horizons 3 - Play Booster Box',
    setCode: 'MH3',
    setName: 'Modern Horizons 3',
    releasedAt: '2024-06-14',
    typeLine: 'Booster box',
    supertype: 'Sealed',
    sealed: { categoryId: 1, groupId: 23332, kind: 'Booster box' },
    usd: 289.99,
  })
  collection.push({
    id: 'demo-item-sealed',
    cardId: sealedDemo.id,
    game: 'mtg',
    name: sealedDemo.name,
    setCode: sealedDemo.setCode,
    setName: sealedDemo.setName,
    finish: 'nonfoil',
    condition: 'NM',
    qty: 1,
    opened: false,
    purchasePrice: 240,
    addedAt: now - 5 * 3_600_000,
    card: sealedDemo,
  })

  const deck: Deck = {
    id: 'demo-deck-rakdos',
    game: 'mtg',
    name: 'Rakdos Scam',
    format: 'Modern',
    createdAt: now - 86_400_000 * 3,
    updatedAt: now - 3_600_000,
    coverCardId: 'mtg:demo-ragavan',
  }
  const byName = (name: string) => DEMO_CARDS.find((card) => card.name === name)!
  const deckCards: DeckCard[] = [
    { id: uid(), deckId: deck.id, cardId: 'mtg:demo-ragavan', qty: 4, board: 'main', card: byName('Ragavan, Nimble Pilferer') },
    { id: uid(), deckId: deck.id, cardId: 'mtg:demo-bolt', qty: 4, board: 'main', card: byName('Lightning Bolt') },
    { id: uid(), deckId: deck.id, cardId: 'mtg:demo-orcish', qty: 4, board: 'main', card: byName('Orcish Bowmasters') },
    { id: uid(), deckId: deck.id, cardId: 'mtg:demo-sheoldred', qty: 2, board: 'main', card: byName('Sheoldred, the Apocalypse') },
    { id: uid(), deckId: deck.id, cardId: 'mtg:demo-swamp', qty: 6, board: 'main', card: byName('Swamp') },
  ]

  const history = DEMO_CARDS.filter((card) => (card.prices.best ?? 0) > 1).flatMap((card) =>
    demoHistory(card.id, card.prices.best!),
  )

  /* A followed friend + an incoming offer, so the Friends tab demos itself. */
  const share = (
    name: string,
    opts: { qty?: number; forTrade?: number; condition?: Condition; finish?: Finish } = {},
  ): SharedCard => {
    const card = byName(name)
    const qty = opts.qty ?? 1
    return {
      cardId: card.id,
      game: card.game,
      name: card.name,
      setCode: card.setCode,
      setName: card.setName,
      number: card.number,
      rarity: card.rarity,
      finish: opts.finish ?? 'nonfoil',
      condition: opts.condition ?? 'NM',
      qty,
      forTrade: Math.min(qty, opts.forTrade ?? 0),
      image: card.imageSmall,
      price: card.prices.best ?? card.prices.bestFoil ?? undefined,
    }
  }
  const demoFriend: Friend = {
    id: 'demo-friend-rae',
    name: 'Rae',
    note: 'LGS on Fridays — DM me for shipping trades',
    scope: 'all',
    addedAt: now - 6 * 86_400_000,
    updatedAt: now - 20 * 3_600_000,
    exportedAt: now - 20 * 3_600_000,
    cards: [
      share('Sheoldred, the Apocalypse', { qty: 1, forTrade: 1 }),
      share('Iono', { qty: 2, forTrade: 2 }),
      share('Pikachu', { qty: 3, forTrade: 2 }),
      share('Dark Magician', { qty: 1, forTrade: 1, condition: 'LP' }),
      share('Charizard ex', { qty: 1, finish: 'holo' }),
    ],
  }
  // Wants: Sheoldred matches Rae's for-trade copy, so matchmaking demos too.
  const demoWants: WantRow[] = [
    {
      key: 'mtg|sheoldred the apocalypse',
      cardId: 'mtg:demo-sheoldred',
      game: 'mtg',
      name: 'Sheoldred, the Apocalypse',
      setCode: 'DMU',
      image: byName('Sheoldred, the Apocalypse').imageSmall,
      price: 52,
      addedAt: now - 2 * 86_400_000,
    },
  ]
  demoFriend.wants = [
    {
      cardId: 'mtg:demo-ragavan',
      game: 'mtg',
      name: 'Ragavan, Nimble Pilferer',
      image: byName('Ragavan, Nimble Pilferer').imageSmall,
      price: 38.5,
    },
  ]

  const demoTrade: TradeRecord = {
    id: 'demo-trade-rae',
    friendId: demoFriend.id,
    friendName: demoFriend.name,
    direction: 'in',
    status: 'proposed',
    createdAt: now - 5 * 3_600_000,
    updatedAt: now - 5 * 3_600_000,
    note: 'Your Ragavan for my Sheoldred + Iono?',
    give: [share('Ragavan, Nimble Pilferer', { qty: 1 })],
    get: [share('Sheoldred, the Apocalypse', { qty: 1 }), share('Iono', { qty: 1 })],
  }

  await db.transaction(
    'rw',
    [db.collection, db.decks, db.deckCards, db.history, db.friends, db.trades, db.wants],
    async () => {
      await db.collection.bulkPut(collection)
      await db.decks.put(deck)
      await db.deckCards.where('deckId').equals(deck.id).delete()
      await db.deckCards.bulkAdd(deckCards)
      await db.history.bulkPut(history)
      await db.friends.put(demoFriend)
      await db.trades.put(demoTrade)
      await db.wants.bulkPut(demoWants)
    },
  )
}

export async function hasAnyData(): Promise<boolean> {
  return (await db.collection.count()) > 0 || (await db.decks.count()) > 0
}
