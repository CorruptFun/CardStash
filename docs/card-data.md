# Card data, pricing and math

## The ten categories

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
| `sports` | Sports | **none — the card itself** | local recall | — none | — not a deck game | foil |

`sports` is the one entry that is not a card *game*, and it breaks the adapter
pattern in the one way that matters — see [Sports cards](#sports-cards) below.

`LIGHT_MATCH_GAMES` (`mtg, pokemon, yugioh, lorcana`) are the games with a cheap
by-name query. The no-hint OCR sweep only fans out across the *enabled* subset
of those, because a catalog-backed game would pull a whole catalog per lookup —
unless the user has turned every light game off, in which case their catalogs
are exactly what was opted into and they become the sweep.


## Sports cards

Sports is the only category here with **no catalog**. There is no free API that
publishes the set of printed sports cards: TCGplayer carries no sports singles,
so the TCGCSV path gives nothing, and the real sources (SportsCardsPro /
PriceCharting, CardHedge, Beckett) are paid products. So the usual flow inverts.

```
every other game:  OCR → name → catalog lookup → the catalog's Card
sports:            OCR → attribute parse → SYNTHESIZED Card
```

`sportsparse.ts` reads the identity off the card (pure, unit-tested);
`sports.ts` turns it into a `Card`. That single difference is behind almost
every rule below.

### The id is the contract

With no server to agree with, the only thing making two devices call the same
card the same card is that they compute the same slug from the same printed
facts:

```
sports:2023-panini-prizm-136-silver-prizm-basketball
        year  brand  product number parallel  sport
```

`sportsSlug` deliberately excludes two things people expect to see:

- **The player.** A card is a slot in a set. Two people reading the same slot
  must agree even if one of them misread the name.
- **The serial number.** Every copy of a `/99` parallel is the same card;
  99 separate ids would be 99 separate collection rows.

Changing `sportsSlug` renames every sports card anyone owns. Treat it as a
wire format, not an implementation detail.

### Refusing to invent

A TCG misread lands on the wrong *real* card. A sports misread invents a card
that does not exist, and nothing downstream can tell. Three guards exist for
exactly this:

1. **`MIN_SPORTS_CONFIDENCE` (0.5).** `parseSportsText` weights what it read —
   player .34, number .24, year .18, brand .14, sport .10 — and below the floor
   the scan is an honest miss. A year and a brand alone describe a whole set.
2. **Sports never joins the auto sweep.** `identifyFrame` only takes the sports
   path when the game is explicitly chosen (or is the only one enabled). In
   auto mode a card that matched nothing would otherwise be synthesized into a
   sports card, which is a confident wrong answer — the worst failure class the
   scan pipeline has.
3. **Vocabularies, not guesses.** A word becomes a brand, a team or a parallel
   only because it is on a list in `sportsparse.ts`. Wrong answers stay rare
   and missing answers stay obvious.

### Pricing: there isn't a feed, and that is the honest answer

A sports `Card` carries **no prices at all** — `prices.entries` is empty by
construction. Value comes from two places:

- **`CollectionItem.marketValue`** — the collector's own per-copy figure. It
  overrides every computed price for any game, and is deliberately **not**
  scaled by the condition factor: they priced the copy in front of them, so its
  condition and grade are already in the number.
- **eBay sold comps** — `sportsCompLink` builds the query a collector would
  type (year, brand, product, player, `#number`, parallel, `/run`, and the
  grade when there is one). This is what the hobby actually prices on.

A bulk price refresh **skips** sports rather than counting every row as a
failure; `refreshCards` filters them and they surface as "skipped".

Do not add a paid price API on the free path. If one is ever wired up it
belongs behind a user-supplied key (like `pokemonKey`) or the entitlement seam
in `entitlement.ts`, and scanning must keep working without it.

### Local recall is the catalog

`searchSports` / `matchSports` / `sportsById` read the cards this device has
already identified, out of the collection and scan tables — no new Dexie table,
because the full `Card` is already stored on both. `sportsById` can return null
and that is a real answer: the slug is lossy (brands slug to hyphenated words,
so it does not split back apart) and there is no service to ask.

## Grading

`CollectionItem.grade?: GradeInfo` is a **new axis on every game**, not a sports
feature — a PSA 10 Charizard is not an NM Charizard either.

It lives on the collection row and never on `Card`, because a grade describes
the copy in the holder rather than the printing. Folding it into the card id
would fork the catalog and break every price lookup.

- **Grade is part of the row's merge key** (`sameGrade` in `db.ts`): a PSA 10
  never merges into the raw row. The **cert is not** — two PSA 10s of the same
  card are interchangeable, and a row per cert would fragment the collection.
- `slab.ts` parses labels (pure, unit-tested) and owns `sanitizeGrade`, which
  both the backup path and `social.ts` reuse. One validation implementation.
- Grades travel on `SharedCard`, so a trade shows what it really is.
- CSV round-trips through a `Grade` column ("PSA 10", "BGS 9.5", "SGC 8 OC").

### PSA cert lookup

`psa.ts` calls PSA's free public API (`GetByCertNumber`, bearer token, ~100
calls/day) to resolve a scanned cert to the exact card. It is an enhancement
and never a dependency:

- **The token is ours**, compiled in from `VITE_PSA_TOKEN`, so cert lookup works
  with nothing for the user to configure. There is no Settings field. A build
  with an empty value is dormant and **never contacts PSA at all** — the same
  shape `drive.ts` uses for its OAuth client id.
- **The token is not safe in a bundle, and the quota is the reason.** Unlike the
  Google client id (origin-allowlisted) and the Supabase publishable key (RLS),
  a bearer token has no backstop behind it: it is readable in the static bundle
  and the ~100/day free tier is now shared across every user rather than
  per-person. Certs cache for months and a 429 stands lookups down for hours,
  but neither changes the arithmetic. Point `VITE_PSA_ENDPOINT` at a proxy that
  holds the token server-side to fix it properly — `ENDPOINT` is the only thing
  that changes.
- Every failure is non-fatal — the label alone already yields the grade, the
  cert and usually the whole card, so a refused, rate-limited or unreachable
  API downgrades the scan instead of breaking it.
- Slab scanning is **not** sports-only: with a TCG selected, the label is
  matched against that game's catalog and the grade is attached to the result.
- **CORS is the known risk.** PSA does not document the endpoint as
  CORS-enabled for browser origins; if the header is absent the call fails in
  the page regardless of the token. That is why `PsaOutcome` makes every
  failure mode a first-class value rather than a thrown error.

## Cards the catalogs got wrong, and cards they never had

Every source above assumes the card exists upstream. Two holes make that false
often enough to be ordinary rather than exotic:

- **A card with no picture.** TCGCSV rows ship without an image constantly,
  promos and Japanese prints frequently have none, and a binder of grey
  rectangles reads to a user as a broken app rather than as a gap in someone
  else's database.
- **A card in no catalog at all.** Regional promos, prereleases before the API
  catches up, error prints, playtest cards, unlisted sealed product. The scan
  misses, search finds nothing, and the collection cannot hold the card the
  user is physically holding.

`lib/cardpatch.ts` closes both with a **`CardPatch`**: a user-supplied image
plus the fields they filled in, stored in Dexie keyed by the card id it
patches. Two things about its shape are load-bearing:

- **It is an overlay, not a replacement.** `mergePatch` lays the patch over
  whatever the catalog said, so prices keep refreshing underneath it, a
  correction upstream still arrives, and one tap puts the original back.
  `fieldsDiff` stores only what actually changed, and `base` remembers what
  each changed key said before — which is what makes undo exact and offline
  (`unmergePatch`). Prices are never patchable.
- **The id is the contract**, exactly as it is for sports. For a card that
  exists upstream the key is the catalog's own id. For a card that exists
  nowhere, `customSlug` mints `custom-<set>-<number>-<name>` from the printed
  facts, so two devices describing the same card agree on what it is called.
  Changing that slug renames every custom card anyone owns.

A **custom card carries no prices at all**, for the same reason a sports card
does not: no feed exists for a card nobody lists, and inventing a number about
someone's money is worse than showing none. Value comes from
`CollectionItem.marketValue`. `refreshCard` and the bulk refresh both skip
custom cards rather than counting them as failures.

Where patches are applied: `cardsearch.ts` patches everything it returns
(`searchGame`, `matchGame`, `cardById`, `printingVariants`), `db.ts` re-stamps
the denormalized copies in collection/deck/scan rows whenever a patch changes,
and `CardImg` applies the index at render as the last backstop for cards that
never went through the facade (a friend's binder, the demo seed). The index
itself is in-memory and loaded at boot, because `CardImg` renders in a hundred
places and cannot await Dexie to decide whether a picture exists.

Images are bounded on the way in by `lib/cardimage.ts`: EXIF-correct decode
through the scan pipeline's own decoder, downscaled to 720px on the long edge
(catalog art is ~745; nothing in the app paints a card wider than ~200 CSS px,
so that is ~3x headroom over the largest real render), encoded WebP where
available and JPEG otherwise.

**The byte budget is a target, not a ceiling, and that is the whole design of
the ladder.** Accepting the first encoding that fits the hard cap means every
picture lands just under the cap, because essentially every picture fits:
measured on the committed card photographs, q0.82/720px gives a median of 78 KB
and a p90 of 105 KB, all of it "fitting" a 220 KB limit. So the ladder steps
down through quality — and then through scale — until it reaches
`TARGET_IMAGE_BYTES` (64 KB of data-URL characters), falling back to the hard
cap only for an image that genuinely will not compress. Measured result on the
same photographs: **median 57 KB, max 62 KB**, in a flat band rather than one
that scales with how busy the photo is, at a cost of ~0.9 dB PSNR at the size a
card is actually painted. Roughly 27 MB for 500 patched cards.

They are `data:` URLs rather than Blobs because a patched card has to render
offline from a plain `<img src>`, survive a JSON export, and mean the same
thing after a sync — base64's ~33% overhead is the price, and it is counted in
the budget. Patches ride the backup and the vault; they are deliberately
**stripped from binder shares and want lists** (`httpsImage` in `social.ts`) —
a photo taken in someone's home is not a side effect of sharing a binder.

**The vault carries pictures up to a bound** (`VAULT_IMAGE_BUDGET`, ~6 MB, the
newest first) because it is one Postgres text column rewritten on every sync;
unbounded, backup would get slower and eventually fail for exactly the users
who had put the most into it. Rows past the budget are omitted **whole**, never
stripped of their image: `mergeBackups` is a union, so an omitted row costs
nothing, while a row arriving image-less could win on `updatedAt` and delete a
photo that existed nowhere else. The JSON export and the Drive backup are real
file writes and pass no budget, so the complete set always has somewhere to
live. Settings states the total, so the cost is never discovered.

### The shared card index (`lib/cardsource.ts`)

The same fixes, pooled: `supabase/migrations/0013` holds `card_data`, and the
app becomes a source of card information rather than only a consumer of five.
Four rules, all deliberate:

1. **Lookups are anonymous.** `lookup_card_data()` is granted to `anon` and
   called with the publishable key, never the session JWT — the decision 20
   rule, for the same reason. It also has to work signed out, because the free
   path is signed out.
2. **Writes are attributed.** `submit_card_data()` requires `auth.uid()`, is
   rate limited, and upserts one row per person per card. Contributing is the
   only operation here that can hurt anyone.
3. **Everything returned is untrusted** and goes through `sanitizePatch`, the
   same door a pasted link uses (decision 7).
4. **A local patch always beats a fetched one.** Community rows land as
   `origin: 'community'` and are skipped whenever the user has said something
   themselves.

Lookups fire only for cards with no image at all, driven by what is on screen
(`noteMissingImage` in `CardImg`), debounced and batched, with misses cached
for three days. Answers are saved as local patch rows, so a card the index
solved keeps its picture on the next flight. `flag_card_data()` is the
correction path: one vote per account, three hides a row, and flagging drops
the local copy immediately.

Two switches, never one: `cardSourceLookup` (on) and `cardSourceShare` (off),
the same split as `socialConfigured()` vs `socialPublishing()`.

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
