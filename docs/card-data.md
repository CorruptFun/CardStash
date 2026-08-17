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
- **A live comp spread** — the same query, run against eBay's *active*
  listings, described below.

A bulk price refresh **skips** sports rather than counting every row as a
failure; `refreshCards` filters them and they surface as "skipped".

Do not add a paid price API on the free path. If one is ever wired up it
belongs behind a user-supplied key (like `pokemonKey`) or the entitlement seam
in `entitlement.ts`, and scanning must keep working without it.

### The comp lookup (`ebaycomps.ts` + `ebay-comps`)

The link above was the whole answer until a number could be put beside it
honestly. It can now, with a narrow definition of "honestly" — decision 17a.

**What it is.** `supabase/functions/ebay-comps` searches eBay's Browse API for
the card and returns `{ count, scanned, low, median, high, kind: 'asking' }`.
`lib/ebaycomps.ts` asks for it, caches it and hands it to `PriceCheck.tsx`.

**What it is not.** eBay's sold-comp feed (Buy → Marketplace Insights) is a
limited release that is not open to new applications, so these are **asking
prices on active listings** — what sellers want, not what anyone paid. Every
layer says so: the field is called `kind: 'asking'`, the UI prints "asking
prices, not sales" under the spread, and the sold-comps link sits beside it.

Five properties are load-bearing:

| Property | Why |
| -------- | --- |
| It never writes `card.prices` | An asking price in `prices.entries` would enter portfolio totals, price history and every shared binder, for cards nobody looked at. It becomes `CollectionItem.marketValue` **only** when the collector taps "Use $X". |
| Nothing is fetched until tapped | No prefetch, no bulk sweep, no background refresh. Which cards someone is pricing is not a stream this app should emit by default — and a tap is consent, which is why there is no settings switch (`cardSourceLookup` needed one because it fires automatically). |
| The proxy is not optional | eBay sends no CORS headers, and the client-credentials grant needs a client **secret** — unlike the PSA token, that cannot ship in a bundle at all. |
| It is called anonymously | Publishable key, `verify_jwt = false`, no session token. The free path is signed out, and what card someone is pricing should not be tied to a user id (decision 20's rule). |
| A thin sample is refused | `MIN_COMPARABLES` is 3, after lots/repacks/reprints are dropped by title and outliers by a five-fold band around the median. Below that the answer is "too few listings", not a number. |

**Turning it on — two switches, server first**, the same shape as the
marketplace (decision 2a):

1. Deploy `ebay-comps` with `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` (an eBay
   developer account, production keyset — the Browse API needs no special
   approval). Missing either, it answers 503. **This is the real switch.**
2. Build with `VITE_EBAY_COMPS=on`. This only hides the button, which is all a
   client can do — but without it a deployed build would offer a price check
   against a function that is not there, and a button that can only fail reads
   as a broken app rather than an absent feature.

Optional: `EBAY_MARKETPLACE` (`EBAY_US`), `EBAY_CATEGORY` (`261328`, "Sports
Trading Card Singles" — the scoping that keeps a player name from returning
jerseys and posters).

**It ships off**, so today the estimate below is the whole sports answer and
the eBay *link* is the manual check, exactly as before 17a.

### The soft estimate (`estimate.ts`)

The comp lookup needs credentials, a network and a card with enough printed
facts to search on. None of that is true offline, on a promo nobody lists, or
in a build with no eBay keyset — so beside it there is an estimate that needs
none of them, and it is the answer to "what do we *think* this goes for?"
(decision 17b).

**Where the numbers come from.** Cards the collector has already priced —
`CollectionItem.marketValue`, falling back to `purchasePrice`. That is real
evidence, specific to the corner of the hobby they actually collect, and every
dollar in it traces back to something they typed. What it is emphatically NOT
is a model of card attributes: "rookie + auto + /25 ≈ $200" would produce a
confident figure for a card nobody has ever priced, which is the exact thing
decision 17 refuses.

**Three tiers, strongest only, never blended:**

| Tier | Comparables | Why not wider |
| ---- | ----------- | ------------- |
| `player` | same player, same year | Different years are different markets — a 1989 rookie against a 1994 base is the comparison that produces an invisible error |
| `set` | same year + brand + product | The set's own price band |
| `brand` | same year + brand | Last resort, and it says so |

Three comparables minimum (the comps floor again), outliers dropped by the same
five-fold band, slabs compared only with slabs (decision 18). The strongest
tier that clears the floor wins outright — averaging three same-player cards in
with twenty commons from the set buries the good evidence in the weak.

**Three ways it says "estimate", on purpose.** The word, the range instead of a
figure, and the basis line naming the comparables ("Rough guess from 4 Ken
Griffey Jr cards from 1989 you've priced"). A number this soft gets read by
whichever cue the user notices first, so it carries all three. Figures round to
a step that widens with size — `$34.17` claims a precision this cannot have.

**Nothing is adjusted.** No rookie multiplier, no parallel premium, no
condition curve. Each would be a number we invented, and one is enough to make
the output untraceable to anything the user said.

**It compounds.** Accepting an estimate or a comp writes `marketValue`, which
is corpus for the next card — so a collection gets easier to price the more of
it is priced. A new collector sees nothing, which is the honest cold start.

**The quota.** eBay's default Browse allowance is a few thousand calls a day
for the *application*, shared across all users — the same arithmetic as the PSA
token. Two caches answer it: an hour in the function's isolate, a day on the
device (three days for "too few"), so a popular card costs eBay one call an
hour for everybody. A 429 stands the device down for six hours.

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

`psa.ts` resolves a scanned cert to the exact card through PSA's free public
API (`GetByCertNumber`, ~100 calls/day for the whole account). It is an
enhancement and never a dependency:

- **Two build shapes, and the proxy is the deployed one.**
  `supabase/functions/psa-proxy` holds our token server-side; a build learns
  the proxy's URL from `VITE_PSA_ENDPOINT` and ships **no token at all**,
  calling it keyless — a bare `GET {endpoint}/{cert}` with no headers, so the
  request stays a CORS simple request and nothing secret exists in the page.
  The legacy shape compiles the token in from `VITE_PSA_TOKEN` and talks to
  PSA directly — fine for dev, unwise deployed: a bearer token has no backstop
  (unlike the origin-allowlisted Google client id and the RLS-backed
  publishable key) and is readable by anyone in the static bundle. If both
  values are set the endpoint wins and psa.ts never sends the token to the
  proxy host. With neither, the module is dormant and **never contacts anyone
  at all** — the same shape `drive.ts` uses for its OAuth client id. There is
  no Settings field either way.
- **Bringing it live takes two values and no code.** Set the server secret:
  `supabase secrets set PSA_TOKEN=<token> --project-ref xvfuyvaehtdxroyzixak`,
  then point builds at the deployed function: `gh variable set
  VITE_PSA_ENDPOINT --body
  "https://xvfuyvaehtdxroyzixak.supabase.co/functions/v1/psa-proxy"`, then
  re-run the deploy workflow (or push to `main`). Until the secret exists the
  function answers 503 "not configured" and the client treats lookup as
  unavailable — the standard dormant posture. Leave the `VITE_PSA_TOKEN`
  Actions secret unset; it is the legacy shape only.
- **The quota arithmetic does not change — the exposure does.** ~100/day is
  still one shared allowance across every user. The proxy validates certs to
  bare bounded digits (nothing arbitrary rides upstream under our bearer),
  caches found certs long (a cert is immutable — PSA issues a new number
  rather than regrade an old one) and empty answers briefly (certs are minted
  every day), and forwards PSA's 429 honestly so the client's six-hour
  stand-down still engages. What nobody can do any more is read the
  credential out of the bundle.
- Every failure is non-fatal — the label alone already yields the grade, the
  cert and usually the whole card, so a refused, rate-limited or unreachable
  API downgrades the scan instead of breaking it.
- Slab scanning is **not** sports-only: with a TCG selected, the label is
  matched against that game's catalog and the grade is attached to the result.
- **CORS was the known risk of the direct shape, and the proxy retires it.**
  PSA does not document its endpoint as CORS-enabled for browser origins; if
  the header is absent a direct call fails in the page regardless of the
  token. The proxy answers with explicit CORS headers of its own. Either way,
  `PsaOutcome` keeps every failure mode a first-class value rather than a
  thrown error.

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

`npm run test:cardsource` (`tests/harness/cardsource-rls.mjs`) proves the
grants against the live project with real JWTs — that `anon` can read and
cannot write, that neither role can touch the tables directly, that
`submitted_by` never comes back, and that a re-submission updates one row
rather than adding a second. Run it after applying `0013` and after any
migration touching the index; a schema read cannot show any of it.

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

## Search by printed card number

The number printed on the card — "BLMR-EN085" on Yu-Gi-Oh, "OP01-016" on One
Piece, "NEO 266" on Magic, "SVI 123/198" on Pokémon — is a first-class search
query, not only scan evidence. It is the one identifier that names **one
printing** where a name names a dozen, and the one a collector can read off a
card whose name the app can't spell (or whose language it can't read).

`cardcode.ts` is the pure parser (`parseCardCode`, node-tested), and
`searchByCode` in `cardsearch.ts` routes the parse to whichever primitive that
game already uses to pin an exact printing:

| Game | Answered by |
| --- | --- |
| Magic | `mtgBySetNumber` (`/cards/:set/:number`), padded and unpadded |
| Pokémon | `pokemonBySetNumber` (`set.ptcgoCode` then `set.id`), or `pokemonByCollector` when a `/198` set size was typed |
| Yu-Gi-Oh | `ygoBySetCode` (`cardsetsinfo.php`), or `ygoById` for an 8-digit passcode |
| Lorcana | `lorcanaBySetNumber` (`/cards/:set/:number`, then the set list filtered locally) |
| TCGCSV games | `catalogByCode` — an array scan over the day-cached catalog, so it works offline |
| Sports | nothing: the card is synthesized from the photo, there is no catalog (see [decision 17](decisions.md)) |

Three rules hold this together:

- **A code query still runs the name search.** Both go out, the code's answer
  leads, results dedupe by id. That is what makes it safe for the parser to
  accept "MEW 25" — which is both a real Pokémon printing and something a
  person might type meaning the Pokémon.
- **The parser is conservative and the failure is soft.** A separator is
  required, the set prefix caps at six characters, fractions need a
  denominator of 45+ (below that it's a power/toughness box), and anything
  longer than a code is prose. A miss costs one wasted request, never a wrong
  card.
- **A typed code is intent; a read code is evidence.** The scan pipeline's
  collector lookups fail closed and demand corroboration because a misread
  digit lands on a real neighbouring card. Nothing here needs that — the user
  is asserting the number, so `ygoBySetCode` may cheerfully try four spellings
  of it (region infix present or absent, digits padded or not).

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
- **Every request goes through the `scryfall()` queue** — one in flight, a
  `MIN_REQUEST_GAP_MS` floor between starts. Scryfall asks all clients for
  50–100ms of spacing and answers 429 with a block that outlives the burst
  that earned it. Nothing here spaced requests, and a scan session is the
  opposite of spaced (a lookup per OCR candidate, per band, per orientation),
  so a user working through a stack could earn a block and then be told a card
  in their hand "isn't in the database" — which came back on its own later,
  the signature of a temporary block. The gap is measured from each request's
  START, so a request slower than the gap has already paid it: measured on the
  scan matrix, the queue changed **zero cells** and did not move mean cell
  time. The queue must never propagate a rejection, or one failed lookup would
  reject everything behind it.
- **Retries are opt-in, and only user-facing calls opt in** (`retries` in
  `fetchJson`: 429 and 5xx only, honouring a clamped `Retry-After`). Search
  and the printings picker retry because someone is watching the screen; the
  scan matchers do not, because a retry there is spent out of the shared
  lookup budget every other game is waiting on.
- **404 is an answer, not a fault**, and `httpStatus()` is how that is told
  apart from a throttle. The old test was `err.message.includes('404')`, which
  would read a 404 out of any response body that mentioned one — and left a
  rate-limited search reporting itself to the user as `HTTP 429: {json}`.

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
(substring), `id=` (the printed passcode), plus `cardsetsinfo.php?setcode=` for
the print code. One YGO api id covers every reprint, so
`ygoPrintingVariants(card)` expands `card.printings` into one selectable `Card`
per printing — and swaps in that printing's own price, because rarity moves YGO
prices by orders of magnitude.

`ygoBySetCode('BLMR-EN085')` is that expansion put to work: the set-code
endpoint returns the card id (which is the passcode), the id endpoint returns
the card, and the printing carrying the asked-for code is selected out of the
set list — so a secret rare's code answers with the secret rare's price, not
the reprint's headline. The endpoint is an **exact string match**, so the
caller supplies the spellings: region infix present or absent, digits padded to
three or not.

**Selecting that printing is two-pass, and the order is load-bearing.**
`sameYgoCode` (`corner.ts`) folds the region infix away on purpose — LOB-EN001
≡ LOB-001 — because a scan reads Latin digits off a card in any language and
still has to find it. That rule is right for *comparing* and wrong for
*choosing*: asked first, it answered a typed "IOC-EN017" with whichever row the
feed listed earliest, which is the right card wearing another region's rarity
and another region's price. YGOPRODeck lists PSV-089, PSV-E089 and PSV-EN089 as
separate rows, and Blue-Eyes' LOB-001 is $62 where its LOB-E001 is $681 — the
infix is not decoration. So `printingByCode` prefers an **exactly spelled**
row (case, whitespace and zero-padding normalised, region infix *not*) and
falls back to the cross-language set only when the card has no exact row, so a
regional print the catalog lists only region-lessly still answers. Every exact
key is also a `sameYgoCode` match, so the first pass can only narrow the
second. Measured on the corpus sweep: yugioh codes exact 39,313 → 40,661,
wrong-printing 1,348 → 0, with mtg and pokemon unmoved.

The scan pipeline selects through the same door. `ygoVariantByCode` is the
exported two-pass core `printingByCode` wraps — it answers null where search
falls back to the card itself — and it is what `identify.ts` asks both when a
passcode has named the card and the mid-card code read off the face picks the
printing, and when its refine checks a printed code against a name match. One
rule, one implementation, so search and scan cannot drift back apart; the
cross-language fallback is also what keeps a French card's Latin digits
confirming a region-less catalog row.

The residual is a card listing the **same** code twice at different rarities
(PSV-EN089 is both Common and Short Print — 9,442 of the 40,670 codes the sweep
asks are in that shape). No printed code can choose between those rows, so feed
order does, deterministically; the variant picker is where a user corrects it.
The sweep scores them `exact` either way — it compares api id and printed
number, and both rows answer to both — so that number comes from counting the
feed, not from the verdict table.

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

### The catalog mirror — `catalog.ts`, `catalogmatch.ts` (migration 0022)

Our own copy of the big three catalogs, consulted only AFTER a game's own API
failed or answered empty — read decision 28 before touching it. One table,
`catalog_printings`, filled by the operator-run `scripts/sync-catalog.mjs`
(service key, the table's only writer) from Scryfall bulk data, TCGdex en sets
(TCG Pocket filtered out) and YGOPRODeck; read anonymously through three RPCs
(`catalog_by_code`, `catalog_by_name`, `catalog_printings_of`) with the
publishable key and never the session JWT (decision 20), under the existing
`cardSourceLookup` switch. The mirror stores each game's own api-id namespace
(Scryfall uuid, `dex-…`, YGO passcode) so its answers dedupe with the live
APIs'; `cardFromCatalog` synthesizes cards WITHOUT prices — `refreshCard`
fills real ones because the api id is real. Wiring:
`searchByCodeWithMirror` / the empty-or-failed branches of `searchGame`,
`matchGame` and `printingVariants` in cardsearch.ts — the scan pipeline
reaches the mirror only through those matchers; `identify.ts` has no mirror
arm of its own. The table's `art_hash` column is RESERVED and unpopulated:
its fingerprint format is deliberately not yet a contract, the sync worker
never writes it and no client code reads it (see decision 28). RLS proof:
`npm run test:mirror`
(tests/harness/catalog-rls.mjs) — run it after applying 0022 and after any
migration touching `catalog_printings`.

**Turning it on** (operator, in this order — every client is dormant until
the first two steps land, at the cost of two stood-down requests per
session):

1. `supabase db push` applies 0022. If every project-scoped call answers
   "does not have the necessary privileges", the CLI is signed in as the
   wrong account — see the hosted-social notes in CLAUDE.md before touching
   anything else.
2. `SUPABASE_SECRET=sb_secret_… npm run test:mirror` — proves anon can read,
   no user role can write, and the code normalization holds. Do not skip it:
   a schema read cannot show any of that.
3. `SUPABASE_SECRET=… node scripts/sync-catalog.mjs` — fills the table from
   all three sources (re-runnable; re-running IS the update story).
4. `SUPABASE_SECRET=… node scripts/sync-catalog.mjs --stats` — per-game rows
   and one lookup through the anonymous RPC the app itself calls, which is
   the claim that actually matters.

The recurring half can ride CI: `.github/workflows/sync-catalog.yml`
dry-runs the mappers against the live bulk APIs on any push touching the
worker (catching upstream shape drift with no secret at all — the push
trigger runs nothing but the dry-run, even with the secret configured), and
once the repo has a `SUPABASE_SECRET` Actions secret, the schedule and a
manual dispatch from the default branch run the real sync **daily at 09:23
UTC** and report coverage.

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
