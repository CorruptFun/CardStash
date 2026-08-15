/**
 * Reading a sports card's identity out of raw OCR text.
 *
 * Every other game in this app resolves a name against a catalog: the API
 * knows what cards exist, so the scanner only has to read well enough to pick
 * one. Sports has no such catalog — no free API publishes the set of printed
 * sports cards — so the card itself is the only source of truth, and this
 * module is where a picture becomes an identity.
 *
 * That inverts the usual failure mode. A TCG misread lands on the wrong real
 * card; a sports misread invents a card that does not exist. So everything
 * here is conservative: a field is only claimed when the text actually says
 * it, `confidence` reports how much of the identity was genuinely read, and
 * the caller decides whether that is enough to keep.
 *
 * Pure by construction — no DOM, no network, no imports but types — because
 * this is the layer that has to be exhaustively unit-testable (the same split
 * `sealedmatch.ts` uses).
 */

import type { Sport } from './types'

export interface SportsSerial {
  num: number
  of: number
}

export interface ParsedSportsCard {
  sport: Sport
  year?: number
  /** Printed as a split season ("2023-24") — hockey and basketball do this. */
  season?: string
  brand?: string
  product?: string
  player?: string
  team?: string
  parallel?: string
  serial?: SportsSerial
  number?: string
  rookie?: boolean
  auto?: boolean
  relic?: boolean
  /** 0..1 — how much of the identity was actually read off the card. */
  confidence: number
}

/* --- vocabularies --------------------------------------------------------
 * These lists are deliberately finite and boring. A sports card carries no
 * machine-readable identity, so recognition is the whole game: a word only
 * becomes a brand, a team or a parallel because it is on a list here. That
 * makes wrong answers rare and missing answers obvious, which is the right
 * way round when the alternative is inventing cards.
 */

/** Manufacturers. The brand is the company; the product line is separate. */
const BRANDS = [
  'Topps',
  'Panini',
  'Upper Deck',
  'Bowman',
  'Fleer',
  'Donruss',
  'Score',
  'Leaf',
  'Pinnacle',
  'SkyBox',
  'Playoff',
  'O-Pee-Chee',
  'Parkhurst',
  'Press Pass',
  'Sage',
  'Futera',
  'Wild Card',
  'Classic',
  'Action Packed',
  'Collector\'s Edge',
] as const

/**
 * Product lines. Ordered longest-first at match time so "Bowman Chrome" wins
 * over "Chrome" and "Donruss Optic" over "Optic".
 */
const PRODUCTS = [
  'Bowman Chrome',
  'Bowman Draft',
  'Bowman Sterling',
  'Donruss Optic',
  'Topps Chrome',
  'Topps Heritage',
  'Topps Update',
  'Topps Finest',
  'Allen & Ginter',
  'Gypsy Queen',
  'Stadium Club',
  'Museum Collection',
  'National Treasures',
  'Immaculate Collection',
  'Flawless',
  'Contenders',
  'Certified',
  'Chronicles',
  'Spectra',
  'Obsidian',
  'Illusions',
  'Absolute',
  'Revolution',
  'Origins',
  'Phoenix',
  'Mosaic',
  'Select',
  'Prizm',
  'Optic',
  'Chrome',
  'Finest',
  'Heritage',
  'Update',
  'Sterling',
  'Hoops',
  'Tribute',
  'Triple Threads',
  'Gold Label',
  'Diamond Kings',
  'Ultra',
  'Metal Universe',
  'Flair',
  'Synergy',
  'Ice',
  'Artifacts',
  'Black Diamond',
  'Young Guns',
] as const

/**
 * Parallel treatments. A bare colour is not enough — "Gold" appears in team
 * names and ad copy — so colours only count next to a treatment word, which
 * is what COLOR_PARALLEL below encodes.
 */
const PARALLELS = [
  'Superfractor',
  'Atomic Refractor',
  'X-Fractor',
  'Refractor',
  'Cracked Ice',
  'Tie-Dye',
  'Shimmer',
  'Sparkle',
  'Speckle',
  'Kaleidoscope',
  'Nebula',
  'Sapphire',
  'Negative',
  'Disco',
  'Pulsar',
  'Mojo',
  'Lazer',
  'Hyper',
  'Wave',
  'Scope',
  'Choice',
  'Fast Break',
  'Rainbow Foil',
  'Gold Vinyl',
  'Foilboard',
  'Holo',
  'Prizm',
] as const

/** Colour words that become a parallel when paired with a treatment word. */
const PARALLEL_COLORS = [
  'Silver',
  'Gold',
  'Green',
  'Blue',
  'Red',
  'Orange',
  'Purple',
  'Pink',
  'Black',
  'White',
  'Bronze',
  'Teal',
  'Aqua',
  'Camo',
  'Copper',
] as const

/** League marks — the strongest sport evidence a card carries. */
const LEAGUE_SPORT: [RegExp, Sport][] = [
  [/\bMLBPA\b|\bMLB\b|MAJOR LEAGUE BASEBALL|\bMiLB\b|MINOR LEAGUE BASEBALL/i, 'baseball'],
  [/\bNBAPA\b|\bNBPA\b|\bNBA\b|\bWNBA\b|NATIONAL BASKETBALL/i, 'basketball'],
  [/\bNFLPA\b|\bNFL\b|NATIONAL FOOTBALL LEAGUE|PLAYERS\s+INC/i, 'football'],
  [/\bNHLPA\b|\bNHL\b|NATIONAL HOCKEY LEAGUE/i, 'hockey'],
  [/\bMLS\b|\bFIFA\b|\bUEFA\b|PREMIER LEAGUE/i, 'soccer'],
  [/\bNASCAR\b|\bINDYCAR\b|FORMULA\s*1\b|\bF1\b/i, 'racing'],
  [/\bWWE\b|\bAEW\b|\bWWF\b/i, 'wrestling'],
]

/** Positions name the sport as reliably as a league mark, and appear on backs. */
const POSITION_SPORT: [RegExp, Sport][] = [
  [/\b(PITCHER|CATCHER|SHORTSTOP|OUTFIELD(ER)?|INFIELD(ER)?|FIRST BASE|SECOND BASE|THIRD BASE|DESIGNATED HITTER)\b/i, 'baseball'],
  [/\b(POINT GUARD|SHOOTING GUARD|SMALL FORWARD|POWER FORWARD)\b/i, 'basketball'],
  [/\b(QUARTERBACK|RUNNING BACK|WIDE RECEIVER|TIGHT END|LINEBACKER|CORNERBACK|DEFENSIVE END|OFFENSIVE TACKLE|SAFETY)\b/i, 'football'],
  [/\b(GOALTENDER|GOALIE|DEFENSEMAN|LEFT WING|RIGHT WING|CENTRE)\b/i, 'hockey'],
  [/\b(MIDFIELDER|STRIKER|GOALKEEPER|DEFENDER)\b/i, 'soccer'],
]

/** Product lines that only ever cover one sport. */
const PRODUCT_SPORT: Record<string, Sport> = {
  'Bowman Chrome': 'baseball',
  'Bowman Draft': 'baseball',
  'Bowman Sterling': 'baseball',
  'Allen & Ginter': 'baseball',
  'Gypsy Queen': 'baseball',
  'Diamond Kings': 'baseball',
  'Topps Heritage': 'baseball',
  'Topps Update': 'baseball',
  Hoops: 'basketball',
  'Young Guns': 'hockey',
  'Black Diamond': 'hockey',
  Artifacts: 'hockey',
  Synergy: 'hockey',
}

/**
 * Team nicknames → sport. Six nicknames are shared across leagues (Cardinals,
 * Giants, Rangers, Kings, Panthers, Jets), so those carry a city map instead
 * and stay unresolved until a city or another signal settles them.
 */
const TEAM_SPORT: Record<string, Sport> = {}
const AMBIGUOUS_TEAMS: Record<string, Record<string, Sport>> = {
  cardinals: { arizona: 'football', 'st. louis': 'baseball', 'st louis': 'baseball' },
  giants: { 'new york': 'football', 'san francisco': 'baseball' },
  rangers: { texas: 'baseball', 'new york': 'hockey' },
  kings: { sacramento: 'basketball', 'los angeles': 'hockey' },
  panthers: { carolina: 'football', florida: 'hockey' },
  jets: { 'new york': 'football', winnipeg: 'hockey' },
}

function registerTeams(sport: Sport, names: string[]): void {
  for (const name of names) {
    const key = name.toLowerCase()
    if (!(key in AMBIGUOUS_TEAMS)) TEAM_SPORT[key] = sport
  }
}

registerTeams('baseball', [
  'Diamondbacks', 'Braves', 'Orioles', 'Red Sox', 'Cubs', 'White Sox', 'Reds', 'Guardians', 'Indians',
  'Rockies', 'Tigers', 'Astros', 'Royals', 'Angels', 'Dodgers', 'Marlins', 'Brewers', 'Twins', 'Mets',
  'Yankees', 'Athletics', 'Phillies', 'Pirates', 'Padres', 'Mariners', 'Cardinals', 'Rays', 'Rangers',
  'Blue Jays', 'Nationals', 'Expos', 'Giants',
])
registerTeams('basketball', [
  'Hawks', 'Celtics', 'Nets', 'Hornets', 'Bulls', 'Cavaliers', 'Mavericks', 'Nuggets', 'Pistons',
  'Warriors', 'Rockets', 'Pacers', 'Clippers', 'Lakers', 'Grizzlies', 'Heat', 'Bucks', 'Timberwolves',
  'Pelicans', 'Knicks', 'Thunder', 'Magic', '76ers', 'Suns', 'Trail Blazers', 'Kings', 'Spurs',
  'Raptors', 'Jazz', 'Wizards', 'Supersonics', 'Bullets',
])
registerTeams('football', [
  'Falcons', 'Ravens', 'Bills', 'Bears', 'Bengals', 'Browns', 'Cowboys', 'Broncos', 'Lions', 'Packers',
  'Texans', 'Colts', 'Jaguars', 'Chiefs', 'Raiders', 'Chargers', 'Rams', 'Dolphins', 'Vikings',
  'Patriots', 'Saints', 'Eagles', 'Steelers', '49ers', 'Seahawks', 'Buccaneers', 'Titans',
  'Commanders', 'Redskins', 'Oilers',
])
registerTeams('hockey', [
  'Ducks', 'Coyotes', 'Bruins', 'Sabres', 'Flames', 'Hurricanes', 'Blackhawks', 'Avalanche',
  'Blue Jackets', 'Stars', 'Red Wings', 'Panthers', 'Wild', 'Canadiens', 'Predators', 'Devils',
  'Islanders', 'Senators', 'Flyers', 'Penguins', 'Sharks', 'Kraken', 'Blues', 'Lightning',
  'Maple Leafs', 'Canucks', 'Golden Knights', 'Capitals', 'Whalers', 'Nordiques',
])

/** Words that disqualify a line from being a player name. */
const NON_NAME = new RegExp(
  [
    'OFFICIALLY LICENSED', 'ALL RIGHTS RESERVED', 'PRINTED IN', 'PRODUCED IN', 'MADE IN',
    'TRADEMARK', 'COPYRIGHT', 'RESERVED', 'LICENSED', 'AUTHENTIC', 'CERTIFIED', 'GUARANTEED',
    'COLLECTIBLE', 'ROOKIE', 'PROSPECT', 'DRAFT PICK', 'CAREER', 'STATISTICS', 'TOTALS',
    'COMPANY', 'INC\\b', 'LLC\\b', 'LTD\\b', 'ENTERTAINMENT', 'AMERICA',
  ].join('|'),
  'i',
)

/* --- small helpers ------------------------------------------------------- */

const CURRENT_YEAR = 2026

function clean(line: string): string {
  return line.replace(/\s+/g, ' ').trim()
}

/**
 * Normalize a read to title case. Mixed-case text is left exactly as it came:
 * the card already told us how the name is written, and "McGwire" or "LeBron"
 * would not survive a round trip through a naive title-caser.
 */
function titleCase(text: string): string {
  const hasUpper = /[A-Z]/.test(text)
  const hasLower = /[a-z]/.test(text)
  if (hasUpper && hasLower) return text
  return text
    .toLowerCase()
    .replace(/(^|[\s'\-.])([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
}

/** URL/id-safe slug for one identity component. */
export function slugPart(value: string | number | undefined): string {
  if (value == null || value === '') return ''
  return String(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/* --- field readers -------------------------------------------------------
 * Each is exported so the unit tests can hold them individually — a parse
 * that regresses on one field is much easier to see than a whole-card diff.
 */

/**
 * The print year. A copyright line is definitive, so it wins outright; a bare
 * four-digit year is only accepted when it is plausible as a print date, which
 * keeps stat-table years (a career column runs to dozens of them) out.
 */
export function parseYear(text: string): { year?: number; season?: string } {
  const season = text.match(/\b(19|20)(\d{2})\s*[-–]\s*(\d{2})\b/)
  const copyright = text.match(/(?:©|\(c\)|copyright)\s*(19|20)(\d{2})/i)
  if (copyright) {
    const year = Number(copyright[1] + copyright[2])
    return { year, season: season ? `${season[1]}${season[2]}-${season[3]}` : undefined }
  }
  if (season) {
    return { year: Number(season[1] + season[2]), season: `${season[1]}${season[2]}-${season[3]}` }
  }
  const years = [...text.matchAll(/\b(19[2-9]\d|20[0-2]\d|203[0-6])\b/g)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1920 && y <= CURRENT_YEAR + 1)
  if (!years.length) return {}
  // Backs list a career of seasons then the print year; the print year is the
  // latest thing on the card, which is exactly what we want.
  return { year: Math.max(...years) }
}

/**
 * Serial numbering ("23/99"). Print runs are the reason this matters — a /99
 * parallel is a different card from the base — so the pattern is kept tight:
 * a plausible run size, a number inside it, and no decimal point nearby
 * (which would make it a stat line rather than a serial).
 */
export function parseSerial(text: string): SportsSerial | undefined {
  let best: SportsSerial | undefined
  for (const m of text.matchAll(/(?<![\d.])(\d{1,4})\s*\/\s*(\d{1,4})(?![\d.])/g)) {
    const num = Number(m[1])
    const of = Number(m[2])
    if (of < 2 || of > 5_000 || num < 1 || num > of) continue
    // Prefer the smallest print run seen: the scarcer number is the one that
    // identifies the card, and stat fractions are large and unround.
    if (!best || of < best.of) best = { num, of }
  }
  return best
}

/**
 * The card number as printed. Sports numbering is far less regular than a TCG
 * collector line — plain digits, insert prefixes ("BCP-25"), update sets
 * ("US150") — so an explicit `#`/`No.` marker is trusted first and a bare
 * token only when it looks like a number rather than a year or a stat.
 */
export function parseCardNumber(text: string): string | undefined {
  const marked = text.match(/(?:#|\bNo\.?\s*)\s*([A-Z]{0,4}-?\d{1,4}[A-Z]?)\b/i)
  if (marked) return marked[1].toUpperCase()
  // Insert and update sets prefix with letters, hyphenated ("BCP-25") or not
  // ("US150"); both are the printed number and must survive as written.
  const prefixed = text.match(/\b([A-Z]{2,4}-?\d{1,4}[A-Z]?)\b/)
  if (prefixed) return prefixed[1].toUpperCase()
  return undefined
}

/** The manufacturer, if one of the known ones is printed anywhere. */
export function detectBrand(text: string): string | undefined {
  for (const brand of BRANDS) {
    const pattern = new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (pattern.test(text)) return brand
  }
  return undefined
}

/** The product line, matched longest-first so compounds beat their suffixes. */
export function detectProduct(text: string): string | undefined {
  const ordered = [...PRODUCTS].sort((a, b) => b.length - a.length)
  for (const product of ordered) {
    const pattern = new RegExp(`\\b${product.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (pattern.test(text)) return product
  }
  return undefined
}

/**
 * The parallel treatment. Colour alone never qualifies — half the teams in
 * these leagues have a colour in their branding — so a colour is only picked
 * up as the qualifier of a treatment word that is already present.
 */
export function detectParallel(text: string): string | undefined {
  const ordered = [...PARALLELS].sort((a, b) => b.length - a.length)
  for (const parallel of ordered) {
    const escaped = parallel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const withColor = new RegExp(`\\b(${PARALLEL_COLORS.join('|')})\\s+${escaped}\\b`, 'i')
    const colored = text.match(withColor)
    if (colored) return `${titleCase(colored[1])} ${parallel}`
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) return parallel
  }
  return undefined
}

/** The team nickname, and whether the read settles which league it is from. */
export function detectTeam(text: string): { team?: string; sport?: Sport } {
  const lower = text.toLowerCase()
  for (const [nickname, cities] of Object.entries(AMBIGUOUS_TEAMS)) {
    if (!new RegExp(`\\b${nickname}\\b`).test(lower)) continue
    for (const [city, sport] of Object.entries(cities)) {
      if (lower.includes(city)) return { team: titleCase(nickname), sport }
    }
    // Named but unresolved: the team is real, the league is not yet known.
    return { team: titleCase(nickname) }
  }
  // Longest first so "Red Sox" and "Blue Jays" beat nothing, and "White Sox"
  // is not shadowed by a stray "Sox".
  const names = Object.keys(TEAM_SPORT).sort((a, b) => b.length - a.length)
  for (const name of names) {
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      return { team: titleCase(name), sport: TEAM_SPORT[name] }
    }
  }
  return {}
}

/**
 * Which sport this is, from the strongest available evidence. League marks
 * and positions are printed statements; a team is nearly as good; a product
 * line is a hint of last resort. Nothing matches → 'other', which is honest
 * and still lets the card be collected.
 */
export function detectSport(text: string, hints: { team?: Sport; product?: string } = {}): Sport {
  for (const [pattern, sport] of LEAGUE_SPORT) if (pattern.test(text)) return sport
  for (const [pattern, sport] of POSITION_SPORT) if (pattern.test(text)) return sport
  if (hints.team) return hints.team
  if (hints.product && PRODUCT_SPORT[hints.product]) return PRODUCT_SPORT[hints.product]
  return 'other'
}

/**
 * The player name — the one field with no vocabulary to match against, so it
 * is chosen by elimination: the most name-shaped line that is not already
 * spoken for by some other field.
 */
export function detectPlayer(lines: string[], known: { team?: string; brand?: string; product?: string }): string | undefined {
  let best: { text: string; score: number } | undefined
  for (const raw of lines) {
    const line = clean(raw).replace(/[^A-Za-z'\-. ]/g, ' ').replace(/\s+/g, ' ').trim()
    if (line.length < 4 || line.length > 30) continue
    if (NON_NAME.test(line)) continue
    const words = line.split(' ').filter(Boolean)
    if (words.length < 2 || words.length > 4) continue
    // Anything already identified as something else is not the player.
    const lower = line.toLowerCase()
    if (known.team && lower.includes(known.team.toLowerCase())) continue
    if (known.brand && lower.includes(known.brand.toLowerCase())) continue
    if (known.product && lower.includes(known.product.toLowerCase())) continue
    if (detectTeam(line).team || detectBrand(line) || detectProduct(line)) continue
    if (LEAGUE_SPORT.some(([p]) => p.test(line)) || POSITION_SPORT.some(([p]) => p.test(line))) continue

    // Name-shaped: every word starts with a capital and is mostly letters.
    const shaped = words.every((w) => /^[A-Z][A-Za-z'\-.]*$/.test(w) || /^[A-Z.'\-]+$/.test(w))
    if (!shaped) continue
    let score = 1
    if (words.length === 2) score += 0.5
    if (/\b(Jr|Sr|II|III|IV)\.?$/.test(line)) score += 0.3
    score += Math.min(0.4, line.length / 60)
    if (!best || score > best.score) best = { text: titleCase(line), score }
  }
  return best?.text
}

/* --- the whole card ------------------------------------------------------ */

const ROOKIE = /\b(RC|ROOKIE CARD|ROOKIE|RATED ROOKIE|1ST BOWMAN|FIRST BOWMAN)\b/i
const AUTO = /\b(AUTO(GRAPH(ED)?)?|SIGNATURES?|ON[- ]CARD AUTO|CERTIFIED AUTOGRAPH)\b/i
const RELIC = /\b(RELIC|JERSEY|PATCH|GAME[- ]?USED|GAME[- ]?WORN|MEMORABILIA|SWATCH|BAT BARREL)\b/i

/**
 * Turn OCR lines into an identity. Fields are read independently and then
 * cross-checked, because the evidence for one often rules out another: a line
 * that is the team is not the player, and a product line narrows the sport.
 */
export function parseSportsText(lines: string[]): ParsedSportsCard {
  const cleaned = lines.map(clean).filter(Boolean)
  const text = cleaned.join('\n')

  const { year, season } = parseYear(text)
  const brand = detectBrand(text)
  const product = detectProduct(text)
  const { team, sport: teamSport } = detectTeam(text)
  const sport = detectSport(text, { team: teamSport, product })
  const parallel = detectParallel(text)
  const serial = parseSerial(text)
  const number = parseCardNumber(text)
  const player = detectPlayer(cleaned, { team, brand, product })

  // What the identity is actually made of. Player and number carry the most
  // weight because they are what separates two cards in the same set; a year
  // and a brand alone describe thousands of cards equally well.
  const confidence =
    (player ? 0.34 : 0) +
    (number ? 0.24 : 0) +
    (year ? 0.18 : 0) +
    (brand ? 0.14 : 0) +
    (sport !== 'other' ? 0.1 : 0)

  return {
    sport,
    year,
    season,
    brand,
    product,
    player,
    team,
    parallel,
    serial,
    number,
    rookie: ROOKIE.test(text) || undefined,
    auto: AUTO.test(text) || undefined,
    relic: RELIC.test(text) || undefined,
    confidence: Math.round(confidence * 100) / 100,
  }
}

/**
 * The stable id for a parsed card. Sports cards have no catalog id, so this
 * IS the identity: the same physical card read on two devices must produce
 * the same string, or trades, wants and dedup all quietly break.
 *
 * Only the fields that distinguish one printing from another go in. The
 * player deliberately does not: a card is the slot in the set, and two people
 * reading the same slot must agree even if one of them misread the name. The
 * serial number is likewise excluded — every copy of a /99 parallel is the
 * same card, and 99 separate ids would be 99 separate collection rows.
 */
export function sportsSlug(parsed: Pick<ParsedSportsCard, 'sport' | 'year' | 'brand' | 'product' | 'number' | 'parallel'>): string {
  const parts = [
    slugPart(parsed.year) || 'undated',
    slugPart(parsed.brand) || 'unknown',
    slugPart(parsed.product) || 'base',
    slugPart(parsed.number) || 'nn',
    slugPart(parsed.parallel) || 'base',
    slugPart(parsed.sport),
  ]
  return parts.join('-')
}

/** Human label for the set a sports card belongs to: "2023 Panini Prizm". */
export function sportsSetName(parsed: Pick<ParsedSportsCard, 'year' | 'season' | 'brand' | 'product'>): string {
  const era = parsed.season ?? (parsed.year != null ? String(parsed.year) : '')
  return [era, parsed.brand, parsed.product].filter(Boolean).join(' ').trim()
}
