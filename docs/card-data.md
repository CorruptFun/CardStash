# Card data, pricing and math

## The nine games

`Game` and the `GAMES` array live in `src/lib/games.ts`; that list plus the
per-game tables beside it is what a new game must extend.

| Game | Label | Source | Search API? | Deck boards | Deck rule | Premium finishes |
| ---- | ----- | ------ | ----------- | ----------- | --------- | ---------------- |
| `mtg` | Magic | Scryfall | yes | main, side | ≥60 main, ≤15 side, 4× (lands exempt) | foil, etched |
| `pokemon` | Pokémon | pokemontcg.io → TCGdex | yes | main | exactly 60, 4× (energy exempt) | holo, reverse, firstEd |
| `yugioh` | Yu-Gi-Oh! | YGOPRODeck | yes | main, extra, side | 40–60 main, ≤15 extra, 3× | firstEd |
| `lorcana` | Lorcana | Lorcast | yes | main | ≥60, 4× | foil |
| `riftbound` | Riftbound | TCGCSV | no — catalog | main, side | exactly 40, 3× | foil |
| `onepiece` | One Piece | TCGCSV | no — catalog | main, side | exactly 50, 4× | foil |
| `starwars` | Star Wars: Unlimited | TCGCSV | no — catalog | main, side | ≥50, ≤10 side, 3× | foil |
| `digimon` | Digimon | TCGCSV | no — catalog | main, extra | exactly 50, ≤5 egg, 4× | foil |
| `gundam` | Gundam | TCGCSV | no — catalog | main, side | exactly 50, ≤10 side, 4× | foil |

`LIGHT_MATCH_GAMES` (`mtg, pokemon, yugioh, lorcana`) are the games with a cheap
by-name query. The no-hint OCR sweep only fans out across the *enabled* subset
of those, because a catalog-backed game would pull a whole catalog per lookup —
unless the user has turned every light game off, in which case their catalogs
are exactly what was opted into and they become the sweep.

## The adapter contract

Every source module exposes some subset of:

```ts
searchGame(game, query)            // free-text search → Card[]
matchGame(game, name, set?, num?)  // best single match → Card | null
cardById(game, apiId)              // exact re-fetch → Card | null
refreshCard(card)                  // fresh prices for a stored card
printingVariants(card)             // every printing of the same name
```

`cardsearch.ts` is the facade that routes by game; nothing outside it (and the
scan pipeline's specialized collector lookups) should import a source module
directly. Each adapter's only job is to normalize a foreign payload into the
`Card` shape from [data-model.md](data-model.md) — same id scheme, same
`Prices`, same `links`.

`bestMatchAcrossGames(name, games)` is the scan pipeline's cross-game race. It
runs every game concurrently with a soft per-game budget, scores each answer
with `nameScore` (not raw similarity — a read of just "Jinx" must still clear
against "Jinx, Loose Cannon"), and resolves as soon as a perfect hit can no
longer be beaten by an earlier-ranked game. One slow API answers "no" for
itself instead of pacing every scan.

## The sources

### Scryfall (Magic) — `scryfall.ts`

`api.scryfall.com`, no key. `/cards/search`, `/cards/named?fuzzy=`,
`/cards/:set/:number`, `/cards/collection` (POST, batches of 75 — used by the
bulk price refresh and CSV import), `/sets/:code`.

Notable behaviour:

- `mtgBySetNumber` is the *language-independent* path and has **no fuzzy
  fallback**. When a printed fraction was read, the set's real `printed_size`
  must match, fail-closed.
- `pickByTraits` / `mtgMatchTraits` re-match by what the camera actually saw —
  borderless/extended/showcase/retro frame treatment and foil — for when the
  collector number wasn't legible and the fuzzy match landed on the base
  printing.

### Pokémon — `pokemon.ts`

Two APIs, deliberately.

- **Primary: pokemontcg.io.** Optional `X-Api-Key`. Lucene-ish queries:
  `name:"exact"` first, then an AND-of-prefixes over the *clean* words (one junk
  token in that query returns nothing, so junk is filtered by `queryWord`).
- **Fallback: TCGdex** (`api.tcgdex.net`, no key, open CORS). The primary has
  gone stale — its team moved on, updates lag whole set cycles and outages are
  routine — so TCGdex answers whenever the primary errors, returns nothing, or
  plainly doesn't know the printed set. Prices are best-effort there (the shape
  has shifted between releases), so the primary stays first for pricing.

Ranking rules that are load-bearing: `matchPokemon` ranks by *name fit* with
newest as the tiebreak (the primary's newest-first page returned "Mega Charizard
Y ex" for a read of "Charizard"), and cross-checks TCGdex whenever the best fit
is under 0.98. `rankBriefs` puts a matching printed collector number **above**
every name tier, and dex pools keep their tail (newest last) — the scored tier
sorts ascending on purpose.

`DEX_COLLECTOR_LANGS = ['en','ja']` drives the collector sweep;
`DEX_NAME_LANGS = ['de','fr','es','it','pt']` drives localized-name resolution.

**The staleness has a second victim: the EDITION.** A Pokémon name answers to
twenty years of reprints, so when the printed line does not reach the match
layer, the answer is whichever printing the catalog listed first — measured on
the matrix, 16 of 43 identified Pokémon cells, a Base Set Charizard among them,
reported as a Celebrations promo. Two rules exist because of that:

- **`matchPokemon` fails closed on the printed set size.** When a
  `printedTotal` was read and neither catalog knows a set of that size, every
  remaining candidate *contradicts* the card in frame, so it returns null
  rather than a printing at another printing's price — the same rule
  `mtgBySetNumber` has always held. `dexMatch` applies it one level down, but
  refuses only when **both** printed halves miss: TCGdex's `cardCount.official`
  and a card's printed denominator do drift, and the number is the harder
  evidence.
- **`pokemonPrintings` merges TCGdex's editions in** (`dexExtraPrintings`,
  bounded, newest first, TCG Pocket filtered out by the `^[ab]\d` set-id rule
  the fixture fetcher uses). Without it the sheet's "Printings & variants" list
  — where a user goes precisely when the scan picked the wrong edition — could
  not contain a card printed after the primary went stale, so a wrong guess on
  a current set was uncorrectable in-app. English set ids are shared between
  the two catalogs (`swsh8-168`), which is what makes the subtraction exact.

### YGOPRODeck (Yu-Gi-Oh) — `ygo.ts`

`db.ygoprodeck.com/api/v7/cardinfo.php` with `name=` (exact), `fname=`
(substring), `id=` (the printed passcode). One YGO api id covers every reprint,
so `ygoPrintingVariants(card)` expands `card.printings` into one selectable
`Card` per printing — and swaps in that printing's own price, because rarity
moves YGO prices by orders of magnitude.

`fname` has zero tolerance, so one OCR-eaten hyphen finds nothing. The recovery
is to re-query on the longest clean *words* (plural — the longest token is
regularly the garbled one) and let name similarity pick from the pooled
results. The second query only runs in `thorough` mode: inside the auto fan-out
every extra serial request taxes every other game's wait.

### Lorcast (Lorcana) — `lorcast.ts`

`api.lorcast.com/v0`, no key, daily TCGplayer-derived USD prices. Printed names
are "Name - Version"; `fullName()` reconstructs that and matching scores both
forms. Which prices exist tells us which finishes exist (Enchanted is foil-only).
An empty search answers 404 — that's "no cards", not an outage.

### TCGCSV (five games + all sealed product) — `tcgcsv.ts`

`tcgcsv.com/tcgplayer` mirrors TCGplayer's catalog and daily prices as static
JSON with open CORS. Category ids are resolved *by name at runtime*, so nothing
breaks when TCGplayer shuffles ids.

Games with no search API load their whole catalog once (a few hundred KB for
young games), cache it in Dexie for ~20 h, and search locally.

**Catalog caching rules** — several of these exist because of specific outages:

- **All-or-nothing per set.** A set that fails to download marks the catalog
  incomplete: it is served for the moment, retried in 5 minutes, and **never
  persisted**. Otherwise the missing set's cards read as "doesn't exist" until
  the day cache expired.
- **Incremental refresh.** Product lists are the heavy files and barely change
  once a set matures, so a product pass under 7 days old is reused and only
  prices (small, daily) are refetched. Sets younger than 45 days, and undated
  promo sets, still get a full fetch — those are the ones that grow and get
  backfilled.
- **One shared, signal-free load per game.** The search box aborts on every
  keystroke; that must not cancel or truncate the catalog every later lookup
  reuses. An aborted caller just stops waiting.
- **Stale beats broken.** On a fetch failure, an expired cache is served
  (backdated for a quick retry) rather than surfacing an error.
- `CATALOG_VERSION` invalidates caches whose *shape* predates a logic change.

**Warmers.** `warmCatalog(game)` preloads one game (called when the scan filter
names intent); `warmOwnedCatalogs()` runs 3.5s after boot over the games the
user demonstrably plays (collection ∪ decks ∩ enabled), one at a time, skipped
under Data Saver.

**Sealed products** exist on TCGplayer for *every* game, including the ones
whose singles come from dedicated APIs. `tcgplayerGroups(game)` builds the set
index (merging aux categories — "Pokemon Japan" — with the same
served-but-not-persisted treatment when a merge is incomplete), and
`groupContents(game, group)` splits one set's products into `singles` and
`sealed`. `isSingle()` decides by card data (Number/Rarity, or any card-facing
stat, since TCGplayer lists young sets sparsely and backfills later), falling
back to a packaging-name regex; `NOT_SEALED` keeps sleeves, playmats and binders
out of "sealed products".

## Pricing (`lib/prices.ts`)

**USD only.** `usdOnly()` filters every read; a legacy €-value must never
surface labelled as dollars.

`pickEntry(entries, finishes)` picks the most trustworthy entry in priority
order: TCGplayer market → any market → anything that isn't `high` → anything.
`bestEntry`/`mergePrices` derive the `best` / `bestFoil` headlines from that.

`itemUnitPrice(item)` is the per-copy value of a collection row:

1. an **opened** sealed product returns `null` — it isn't the sealed product any
   more;
2. the finish-specific price, falling back nonfoil → premium (or premium →
   nonfoil for a premium row);
3. recomputed from `entries`, not the stored headline, so a legacy EUR-only card
   reads as unpriced;
4. entry-less hand-rolled imports fall back to the stored headline;
5. multiplied by the condition factor: **M/NM 1.0, LP 0.85, MP 0.70, HP 0.55,
   DMG 0.40**.

**Freshness.** `Prices.updatedAt` is stamped on every fetch. The card sheet
silently re-fetches when a card's prices are older than 6 hours and pushes the
result through `applyCardUpdate` (which also records a history point), so simply
opening a card keeps both the price and the portfolio series current. The
collection screen's explicit refresh does the same in bulk, batching MTG through
Scryfall's collection endpoint and pacing the rest at ~110 ms.

Also here: `groupComps` (pivots entries into the comps table, ordered by finish
then source), `netProceeds` (a 13 % default marketplace fee), and `parseMoney`
(handles `$12.50`, `1.234,56`, `1,234.56` — used by CSV import and the cost
basis field).

## Portfolio math (`lib/portfolio.ts`)

Everything is reconstructed from per-card price history; USD points only.

- `valueSeries(items, points, days)` — step-interpolates each card's history
  onto the window's dates and sums, weighting by `qty × conditionFactor`. Cards
  with no history use their current price flat.
- `valueWindow` adds `snapshots` (how many *distinct days* in the window
  actually hold a price for an owned card) and `ready` — the chart refuses to
  draw a trend line from fewer than two real data days rather than implying a
  trend it can't support.
- `costBasis` — cost, value, profit, profit %, plus `covered`/`uncovered` copy
  counts so the UI can say how much of the collection has cost data.
- `movers` — per-card 30-day delta, weighted the same way, needing ≥2 history
  points; sorted by absolute dollar move.
- `cardTrend` — the single-card sparkline header figure.

## Deck math (`lib/deckstats.ts`)

- `GAME_BOARDS` defines which boards a game has; `boardForCard` routes cards
  that live in a separate pile (YGO Extra-Deck monsters, Digimon Digi-Eggs) when
  you add "to the deck".
- `DECK_RULES` drives `deckWarnings`: main-deck floor/exact/ceiling, sideboard
  and extra-deck caps, and a copy limit with per-game exemptions (basic lands,
  basic energy). Sideboards are exempt from the copy limit.
- `deckStats` also computes the MTG mana curve (0..7+, non-land, main board
  only), colour counts, type breakdown, and **owned vs missing** — it walks a
  copy of `ownedNameCounts()` and claims copies as it goes, so two decks asking
  for the same card don't both count it as owned within one deck's tally.
- `deckRowUnitPrice` prices deck rows at the headline (NM, non-foil-ish) price —
  deck rows have no finish/condition of their own.
- `groupBoards` / `decklistText` / `deckCoverCard` are the presentation helpers.

## CSV import / export (`lib/importexport.ts`, `lib/csv.ts`)

Import is header-flexible, aimed at Dragon Shield-style tracker exports.
Recognized columns (first match wins): name/card name, game/tcg,
set code/set/edition, collector number/card number/number, api id/scryfall id,
quantity/qty/count, finish/foil/printing, condition, language/lang,
purchase price/price paid/cost, for trade/trade/for_trade/trade quantity.
Only *Name* is required.

Values are normalized through alias tables: `normalizeGame` (30+ aliases),
`normalizeFinish` (foil/holo/reverse/1st-edition spellings, plus `yes/1/true`),
`normalizeCondition` (word forms → the six-letter codes). `parseForTrade`
accepts a count or `yes`/`all`. `parsePurchasePrice` refuses ranges and
parenthesized negatives — those are not a unit cost basis.

Rows are then resolved to live cards by `resolveImportRows` (MTG ids batched up
front through the collection endpoint, everything else one-by-one with a polite
110ms gap), and each resolved row is added through the normal
`addToCollection` path.

Export (`collectionToCsv`) writes a stable 15-column header including the
computed unit price, the for-trade count and the sealed/opened state, and is
re-importable by the same parser. `csv.ts` is an RFC-4180-ish parser (quotes,
escaped quotes, CRLF) plus `downloadFile`/`readFileText` helpers.
