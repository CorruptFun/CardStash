# Testing

Layered, each covering something the others structurally cannot.

| Layer | Command | Runtime | Needs fixtures? |
| ----- | ------- | ------- | --------------- |
| Unit | `npm run test:unit` | node, seconds | no (one test self-skips without them) |
| Scan matrix | `npm run test:scan` | headless Chromium, ~5 min | **yes** |
| Capture | `npm run test:capture` | headless Chromium, seconds | no |
| Built-bundle smoke | `npm run build && node tests/harness/smoke-app.mjs` | headless Chromium, seconds | no |
| Install banner | `npm run test:install` | headless Chromium, seconds | no |
| Scan UI (upload + page review) | `npm run test:scanui` | headless Chromium, ~2 min | **yes** |
| Batch add | `npm run test:batch` | headless Chromium, ~30s | no |
| Miss chip + help panel | `npm run test:misshelp` | headless Chromium, ~90s | **yes** |
| Invite links | `npm run test:invite` | headless Chromium, ~30s | no |

## The rule

**Never change scan-pipeline code without running the matrix before and after.**
That covers `src/lib/identify.ts`, `ocr.ts`, `vision.ts`, `corner.ts`,
`pokemon.ts`, `ygo.ts`, the `tcgcsv.ts` matching paths and
`src/hooks/useScanner.ts`. The methodology — measure first, diagnose from
traces not vibes, fix one layer at a time, pair every tolerance with an evidence
gate, reproduce every verdict twice — lives in
[`.claude/skills/scan-harness/SKILL.md`](../.claude/skills/scan-harness/SKILL.md).
Read it first. It exists because synthetic tests passed while real cards failed
on-device.

The matrix reports a second number beside the pass rate: **printing** — of the
cells that identified the right card, how many landed on the printing that was
photographed. It is deliberately not part of the gate (the gate is a name gate,
and every stored baseline was measured against it), and it is only asked where
the ground truth can answer: Yu-Gi-Oh's fixture images are YGOPRODeck replicas
with no set code printed on them, so only real photographs can grade its
printings. Watch the second half of that line hardest — `N wrong while claiming
the code was read` counts printings the app got wrong *and believed*, which is
the only kind the user cannot catch (see `pinned` in
[scanning.md](scanning.md)).

Three paths the matrix cannot reach have their own checks: what the camera
captures (`test:capture`), when it is allowed to be *on* (`test:camera`), and
the built bundle (`smoke-app.mjs`). Changes to `camera.ts` or the scan screen
need those, not just the matrix.

`test:camera` is the one that answers a question no pixel test can: the scan
screen is never unmounted, so a camera released by the wrong code path keeps
running behind another tab with the OS indicator lit. It drives the real app
against a fake camera device and asserts on `MediaStreamTrack.readyState`,
twice — once as an ordinary browser, once with the app fooled into thinking it
is an iOS Home-Screen app (iPhone UA + `navigator.standalone`), which is the
only configuration where `releaseCamera()` parks a live stream at all. Run it
in both modes or it proves nothing; the bug it was written for was invisible in
the first.

`test:install` reads the built bundle in `dist/`, and two different bundles
ship from this tree. With `VITE_GOOGLE_CLIENT_ID` set — CI's deploy build, and
what a local `.env.local` gives you — the iOS banner makes a Drive backup the
primary action and tells the user to restore from Drive after installing;
without it the downloaded file is the only backup and the last step is
`Collection → Import`. The harness detects which build it is from the banner's
own buttons and asserts the matching copy either way, so **build whichever
configuration you changed and run it against that** — a green run on the
file-only build says nothing about the deploy build's copy. Buttons are
addressed by their label, not their class: Drive demotes the file backup from
`.installtip__go` to `.installtip__dismiss`, so a class selector silently
points at the wrong button or matches two.

## Unit tests (`tests/unit/`)

Plain `node --test`. App modules are TypeScript, so `bundle.mjs` bundles an
entry with esbuild (already present as a Vite dependency) into ESM the test can
import — with `alias` to stub a *sibling* module (e.g. swapping `./fetchJson`
for a canned-network stub) and `external` to keep a heavy lazy dependency out
(the Tesseract runtime).

| Test | Covers |
| ---- | ------ |
| `analytics.test.mjs` | The analytics contract: events carry counts, never content — the redactor every `track()` call passes through, the hash that groups failing cards without naming them, and the aggregators the diagnostics screen and the ingest read. |
| `arthash.test.mjs` | The art-hash re-pick's **decision** layer (the pixels are measured in the harness): which arts get compared, and when a win is decisive enough to move an answer. The refusals are the load-bearing cases — a false swap is a manufactured wrong printing at full confidence. |
| `authsession.test.mjs` | The session surviving its own app being busy: refresh tokens rotate, so the concurrent refreshes one screen-load fires must coalesce — the losers' 400s used to `signOut()` a real returning user. |
| `binders.test.mjs` | Custom binders as pure rules: quantities clamp to what is still owned, `isDiscoverable` needs both halves (public **and** tradeable), a binder payload is its own `kind`, an opened sealed product never travels, page grouping, and the label URL a printed QR carries. |
| `card-regions.test.mjs` | `detectCardRegions` — the 2D, explicitly rectangular detector behind page scanning *and* single cards on cluttered backgrounds — pinned on synthetic frames where the truth is known exactly; the real binder photo lives in `tests/harness/photos`. |
| `cardcode.test.mjs` | `parseCardCode` — reading a printed set/batch number ("BLMR-EN085") out of a search query. The **refusals** are the point: an ordinary card name must never be mistaken for a code. |
| `cardcode-search.test.mjs` | `ygoBySetCode` against a stubbed YGOPRODeck (exact-match set-code endpoint, region/padding spellings, the printing's own price) and `catalogByCode` over a stubbed catalog. |
| `cardimage.test.mjs` | The compression contract's pure arithmetic: how an encoded size is reported, and which patches a size-bounded backup carries — the rule that protects a photo from a merge (over-budget rows are omitted **whole**, never gutted). |
| `cardpatch.test.mjs` | User-supplied card data: the sanitizers between an untrusted document and an `<img src>`, the overlay rules for what a patch may and may not change, and the slug that IS a custom card's identity — changing it renames every custom card anyone owns. |
| `catalog.test.mjs` | The catalog mirror's pure layer: the row sanitizer a server answer must pass, the `Card` it becomes, and the sync worker's source mappers. The guards get tested harder than the happy path. |
| `champion-lead.test.mjs` | Riftbound siblings sharing a champion lead ("Ambessa - Respected and Feared" vs "Ambessa - The Wolf"): a lead-only read parks at exactly 0.95 by design, so these pin the evidence that separates one epithet from another. |
| `chroma-sat.test.mjs` | Foil printed on the NAME itself (Yu-Gi-Oh Ultra/Secret Rares): metal glyphs straddle the bar's own luma, so these pin the chroma-range preprocessing that keeps such names readable. |
| `cloudsync.test.mjs` | The two pure halves of cloud sync: the AES-GCM envelope (encrypt/decrypt round trip, wrong-passphrase detection) and the device merge — network-free and clock-free, because a merge bug silently eats a user's cards. |
| `corner.test.mjs` | `parseCornerInfo` per game, `parsePasscode`, `sameYgoCode` — the collector-line parsers, including the fused-fraction reconstruction and its bounds. |
| `crossgame.test.mjs` | The two guards that stop a Pokémon card coming back as a Yu-Gi-Oh one when the auto sweep compares games at once: the printed collector line as a veto (`collectorLineAllows`) and name-candidate quality. |
| `crossgame-sweep.test.mjs` | The auto sweep's cross-game failure end to end, against stubbed networks: a game whose API fails to answer must not cede its card to whatever other catalog fuzzy-matched the read. |
| `ebaycomps.test.mjs` | What counts as an eBay comparable — mostly what gets **thrown away** (a lot of thirty cards, a repack, one seller asking $9,999 for a common), because those make a median wrong invisibly — plus `asSummary` as the door on our own server's answer. |
| `estimate.test.mjs` | The soft sports estimate: provenance over arithmetic — what is NOT allowed to influence the number (a different year, a slab against a raw copy, the card counting itself) — and the basis sentence as a disclosure, tested beside the figures. |
| `fetch-retry.test.mjs` | The transport rules behind "it's not in the database… but it is if I come back later": Scryfall's 429 blocks, request spacing, retries, and telling a throttle apart from a genuine miss. |
| `marketplace.test.mjs` | The marketplace is OFF — written to fail loudly if anyone deletes the flag — plus the sanitizers between the server and anything describing money. (The server's own `MARKETPLACE_ENABLED` switch is only observable by asking the deployed function.) |
| `messaging.test.mjs` | What a server's message row may become on screen: a bounded body, malformed rows dropped rather than half-rendered, the attached card through `sanitizeSharedCard` — the same door a `#/x?d=…` link uses — and no analytics event that says who was messaged. |
| `mirror-transport.test.mjs` | The catalog mirror's transport end to end with fetch stubbed at the boundary: the switch respected before any request, server rows sanitized on the way to Cards, a 404 standing the mirror down at once, and flipping the switch clearing the stand-down. |
| `mtg-treatment.test.mjs` | The frame-treatment vocabulary the printing tie-break trades in: `treatmentOf`, `asTreatment`, `pickByTraits` — and the guard that a re-pick only happens when a print with the SEEN frame exists. |
| `names.test.mjs` | `nameCandidates` ranking, `nameScore`/`similarity`/`normalizeName` — including split champion names and the lead-segment tolerance. |
| `orientation.test.mjs` | `looksSideways` and `latinWordCount` — the two pure decisions behind sideways handling. |
| `pokemon-lang.test.mjs` | `matchPokemon` / `pokemonByCollector` / `pokemonById` against a stubbed network: dead primary, multi-language TCGdex, and the real Japanese size collision (sv4K/sv4M both 66) that must **refuse**. |
| `pokemon-printing.test.mjs` | "Right card, wrong version," which the matrix cannot see because it grades the name: pokemontcg.io answers stale printings, and these pin printing selection against a deliberately stale stub. |
| `pokemon-variant.test.mjs` | Pokémon suffix variants ("Tauros" vs "Tauros GX") — a perfect-score match to the wrong card that no threshold can see, arbitrated by the rules-box declaration the pipeline was already reading and throwing away. |
| `profilelinks.test.mjs` | Social profile links: a stored link can never point somewhere its icon does not claim — handles are stored and URLs rebuilt from a table — plus the forgiving input half (`@rae` and a pasted profile URL mean the same collector). |
| `psa.test.mjs` | The PSA response normalizer: keys read case-insensitively, missing halves tolerated, so a renamed or absent field degrades to a blank rather than to a wrong card. |
| `psaproxy.test.mjs` | The psa-proxy's pure half — the two things standing between the open internet and our PSA credential, since the function is anonymous by design: cert validation (nothing but bare, bounded digits rides upstream under our bearer) and the found/empty classification that picks a cache TTL, because a found cert is immutable but "no record" must be allowed to go stale. |
| `qr.test.mjs` | The QR encoder, held to the only bar that matters: a **real decoder** (`jsqr`) reads back exactly what went in, at every version this app emits. A wrong generator polynomial or a mis-numbered format bit still renders a plausible square, and the artefact is a sticker glued to a binder — the failure would surface weeks later. |
| `referral.test.mjs` | Referrals: a collector with no handle keeps getting byte-identical share links, a payload is never mistaken for a referral (or vice versa), the first link wins, the server is asked once, and offline is a retry rather than an answer. |
| `scryfall-corner.test.mjs` | `mtgBySetNumber` — the MTG sole-evidence path. Its *refusals* matter as much as its hits. |
| `sealed.test.mjs` | `identifySealedText` end to end over a stubbed two-set catalog — the Japanese-pack scenario where only the brand word and the printed set code survive OCR. |
| `sealedmatch.test.mjs` | The pure scoring rules: code-prefix stripping, set-code qualification, score ordering against sealed.ts's 0.72 threshold. |
| `slab.test.mjs` | The slab label parser, mostly refusals: missing a slab costs a scan, but inventing one puts a grade on a raw card and misprices it by an order of magnitude. |
| `sportsparse.test.mjs` | The sports parser, whose risk no TCG matcher has: with no catalog, a bad read invents a card rather than picking a wrong one — so as much about what it REFUSES to claim (a stat fraction is not a serial, a team is not a player) as about what it reads. |
| `stripe-billing.test.mjs` | The Stripe billing webhook's pure decisions: only Stripe can grant an entitlement, and a grant lasts exactly as long as was paid for — signature vectors computed with node's own HMAC, never with the function under test. |
| `stripe-escrow.test.mjs` | The escrow function's pure decisions: only Stripe can move an order, and the money splits the way we say. Which state transitions are LEGAL lives in migration 0006, proven by `tests/harness/escrow-rls.mjs` — deliberately no second copy here. |
| `stubs.test.mjs` | That the **harness's** stub APIs honour each real service's query semantics. Skips when the fixture snapshot isn't present. A stub that answers wrong would grade the pipeline against fiction. |
| `tcgcsv-groups.test.mjs` | The group-index merge (primary + "Pokemon Japan" categories) with the network stubbed. |

Stub modules live in `tests/unit/stubs/`.

## The scan matrix (`tests/harness/`)

Real card photographs run through the **real** `identifyFrame()` in headless
Chromium, graded against ground truth, with per-stage failure attribution. Only
the card APIs are stubbed — each service's query semantics reimplemented over
captured real responses — so a run is deterministic and needs no network.

A **cell** is `fixture × degradation × hint-mode`. It passes only if the pipeline
lands on the right card (right game, normalized-name similarity ≥ 0.9). **A
confident wrong answer is a failure**, tracked separately as `wrong-card` —
that is the worst failure class, because in collect mode it silently adds the
wrong card at the wrong price.

Failure stages, read from the pipeline's own trace: `ocr-noread`,
`ocr-misread`, `match-none`, `match-low`, `wrong-card`, `api-error`.

**Printings are graded separately, and a pass can still be wrong.** `graded()`
asks only for the name, deliberately — but "right card, wrong edition" is its
own failure (a different price on a card the user is told they own), and it was
invisible here until a user reported one. `printingOf()` compares the fixture's
printed collector number against the identified card's for every cell that
passed, and the run prints `=== printings: n/m … WRONG k ===` with each
offender's wanted-vs-got. Cells that pass but land on the wrong edition are
marked `~` rather than `✓`. It is reported apart from the pass rate on purpose:
it is not a scanning failure, it is a pricing one, and it is fixed in the match
layer rather than in OCR. Against a `--baseline` it **warns** (`PRINTINGS
DOWN`) instead of failing the run: it is a ratio over only the cells that
passed, so one flapping cell moves numerator and denominator together, and a
flaky gate on a secondary axis would train everyone to ignore the primary one.
Confirm a move over two runs, as with every other number here.

Standard degradation battery (all deterministic, seeded): `clean`,
`small-offset`, `soft-focus`, `rot+5`, `rot-5`, `perspective`, `glare`,
`lowlight`, `worst`. Opt-in extras, kept out of the standard set so per-game
regression gates stay comparable across reports: `dim`, `dark`, `sideways`,
`sideways-ccw`.

### Running it

```sh
# Fixtures (one-time per sandbox). With open internet:
node tests/harness/fetch-fixtures.mjs
# In a restricted sandbox, pull the CI-generated branch — git archive, NEVER a
# --work-tree checkout (that stages 60 fixture files into the source index):
git fetch origin harness-fixtures
mkdir -p tests/harness/fixtures
git archive origin/harness-fixtures | tar -x -C tests/harness/fixtures

npm run test:scan                     # everything (~5 min, 282 cells)
npm run test:lowlight                 # harsh low light + 3-frame stack

node tests/harness/run-matrix.mjs \
  --games=pokemon,riftbound --degradations=clean,glare \
  --mode=hinted --keys=tauros-fa-secret --pages=3 --verbose

node tests/harness/run-matrix.mjs --baseline=tests/harness/report/baseline.json
```

`--baseline` exits non-zero on **any** per-game pass-rate drop; `--min-rate`
sets an absolute floor. Reports land in `tests/harness/report/` (gitignored) —
keep the pre-change report as your baseline. Chromium resolves from
`$CHROMIUM_PATH` → `/opt/pw-browsers/chromium` → playwright's registry.

### Pieces

`fetch-fixtures.mjs` (downloads imagery + API datasets) → the
`harness-fixtures` branch → `stub-apis.mjs` (per-service query semantics) →
`page.html` (loads the real `/src` modules through the Vite dev server, exposes
`window.__harness.runCell`) → `augment.mjs` (the degradation battery) →
`run-matrix.mjs` (orchestrates, grades, reports).

### Two traps

- **Do not edit `src/lib/**` while a matrix run is live.** Any module in the
  harness page's import graph triggers a Vite full reload that wipes
  `window.__harness` mid-run. Views and styles are safe.
- **Matrix numbers are only comparable within one fixture snapshot.** The dying
  pokemontcg.io answers differently every capture round, so re-baseline after
  every fixture refresh rather than comparing against an older report.

Known stub bias, stable across runs so before/after deltas still hold: an OCR
misread that a *real* API might fuzzy-resolve to some other card returns "no
match" here — both grade as failures, only the stage label differs.

## Real photographs and clips (`tests/harness/photos/`)

The matrix composes its inputs. Real cameras do not, and the difference is not
cosmetic — **it is where the wrong cards live.**

- `npm run test:photos` — hand-curated real photographs, plus binder pages
  (`--binders-only`) graded against an unordered multiset of names.
- Clips: frames extracted from ordinary handheld video at ingest
  (`ingest-clip.mjs`) and committed, in **bursts** — across bursts answers "does
  any frame identify" (frame selection), within a burst answers "does averaging
  beat the best of them" (stacking). Frames 5s apart cannot answer the second;
  three frames 33ms apart cannot answer the first.

These images **are committed to this repo**, unlike the matrix fixtures. CI
force-pushes `harness-fixtures`, and a photograph cannot be regenerated.

Two results worth carrying in your head before you quote a number:

1. In the round that produced the clips numbers, the standard matrix reported
   **zero** wrong cards across its 282 cells while two ordinary clips produced
   **10 wrong in 40 identifications**. A battery of stills cannot bound the
   wrong-card rate of a live scanner. (The current baseline of record and the
   rescue-assisted numbers live in [scanning.md](scanning.md) and the
   scan-harness skill's lessons.)
2. Consecutive frames disagree. In one burst, frames 0 and 1 read "Krookodile
   ex" and identified correctly; frame 2, 33ms later, read "Krookodile" and
   matched a real, different, far cheaper card at score 1.0. The scanner commits
   to one frame with no corroboration.

**Ingest resolution is a silent ceiling.** `ingest.mjs` capped every photo at
`CAPTURE_MAX_EDGE` (1600), which is right for one card and wrong for a page —
cards reached the pipeline ~370px wide, well under the ~790px where a collector
line stops being legible. Pages now ingest at `PAGE_MAX_EDGE` (3200). When a
tool normalises an input, check its constant against the consumer that will
actually read it.

## Capture check (`test:capture`)

The matrix composes stacked frames in-page; the phone runs
`captureFrameStacked()` against a live `<video>`. This test drives that real
function through the dev server and asserts the physics it exists for —
averaging N noisy frames must reduce measured noise — plus that it degrades
safely when the camera dies mid-stack.

## Built-bundle smoke (`smoke-app.mjs`)

Serves `dist/` with `vite preview` and drives the real bundle headless: the scan
gate must render, tabs must navigate, Settings must show the version, and the
console must stay clean. It catches wiring the type checker can't — JSX
structure, store subscriptions, dead imports — in the artifact users actually
get.

## Invite links (`test:invite`)

An invite is two halves that never run on the same device — `InvitePanel`
writes the URL, `captureReferral()` reads it back on a stranger's phone at boot
— and the second half is invisible to every other test: it is the first
statement of `boot()`, it writes a settings key nothing displays, and it fires
long before there is an account. A regression there is silent and permanent.

So this harness copies the link off the real screen and then opens **that
string** in a fresh browser context with no storage, which is as close to the
actual journey as a local run can get. It also pins the rule that costs money
to get wrong: a second link must not overwrite the first, because
`claim_referral()` records one referrer per account for ever and the app must
not credit someone the database does not.

It cannot reach the server half — `befriend_referrer()` needs a real project
and a real account. That is `tests/harness/social-rls.mjs` §6b, which needs
`SUPABASE_SECRET`.

Two things it deliberately fakes, both for the same reason (a real one hangs
rather than fails in headless): `navigator.clipboard.writeText` is stubbed so
the assertion is what the button hands over, and the signed-in account is stood
in for by seeding `socialHandle` — the localStorage cache every "are they set
up?" check already reads.

## The two review screens (`test:scanui`, `test:batch`)

Both drive the real app to a Dexie write, and between them they cover every
path that files a card without the card sheet.

`test:scanui` is the only check that a picked file reaches the pipeline, that
the page-review screen shows what was found, and that confirming files exactly
the ticked rows. It also drives a **second page** into the same review — the
parked screen, the resume bar, the page headings, the ticks surviving the trip
back to the camera — and names a binder on the way out, so the session's cards
land in that binder with the page they were read from. Its second page is the same photograph
deliberately: it pins the merge, where a card already filed keeps the page it
was first seen on and becomes a second copy rather than a second row. It needs the matrix fixtures and a fake camera device. It also
carries two traps worth knowing, because both once made it fail while the app
was fine: the mode pills are **one** "Modes" button opening a sheet of switches,
so the Page toggle is reached through that sheet, not a pill of its own; and the
welcome dialog is modal and a harness is a first-time visitor on every run, so
the page must be loaded with `?welcome=0`.

`test:batch` covers batch add and needs neither fixtures nor a camera: what it
checks starts *after* identification, so it seeds `db.scans` straight into
IndexedDB from the demo collection's own cards and aborts every external
request. The invariant is that what the screen shows and what gets filed are
the same set in both directions — an unticked row must not land, and a row
already filed by Collect mode must not arrive ticked again. Run it after
touching the scan tray, `ScanBatch`, or `db.scans`.

## The miss surfaces (`test:misshelp`)

The one harness whose subject is a **lifetime** rather than an outcome. When a
card will not read, the chip states and the panel acts (see `ui.md`); what has
to hold is that the panel is still there — and still clickable — after the
scanner has flipped status underneath it, because the bug this replaced was
buttons that were gone before a thumb could land on them. Nothing about that is
visible to a type, a unit test or a screenshot.

Misses are manufactured, not waited for: chromium's fake camera device is a
rolling test pattern, so every identification of it fails, and the viewfinder's
own tap-to-scan forces the attempts rather than hoping the motion gate lets one
through. It runs three passes because the offer's whole design is that three
users see different things — signed out (never asked for money), signed in with
cloud rescue off (offered the **free** switch, no price quoted at all), and
signed in with it on (offered the discounted year). The checkout is answered
with the 503 a deployment with no offer price configured would send, which both
keeps the browser on the page and exercises the refusal that exists so a panel
quoting $10.99 can never end at a $11.99 till.

Run it after touching `ScanChip`, `MissHelp`, `MissOffer`, `missRun`, or
anything in `lib/billing.ts`. It needs the matrix fixtures and starts vite with
`VITE_SCAN_OFFER=on` itself — the deployed build has that switch off, so the
money half of the panel is not otherwise reachable.

## Binders and the printed label (`test:binder`)

Drives the real screens with no camera and no fixtures — the cards come from
the demo seed, every external request is aborted — through the whole life of a
label: filing a selection from the collection, the binder list, the detail
screen, **Print label**, the link that label carries, an unknown code, and the
delete.

Three invariants, all about a label outliving the session that made it:
filing writes `binderCards` rows pointing at the collection rows; the printed code
and the QR resolve back to *that* binder through the app's own router; and
deleting a binder unfiles its cards and deletes none of them. `qr.test.mjs`
proves the symbol decodes — this proves the screen around it is wired to the
right binder.

Run it after touching `BindersView`, `BinderLabel`, `lib/qr.ts`, `lib/binders.ts`
or the binder writes in `db.ts`.

## Live Supabase harnesses (`test:cloud`, `test:social`, `test:escrow`)

Two harnesses that can only fail in production, so neither is in CI and both
need `SUPABASE_SECRET`:

```sh
SUPABASE_SECRET=sb_secret_… npm run test:cloud    # the encrypted vault transport
SUPABASE_SECRET=sb_secret_… npm run test:social   # hosted-social RLS
SUPABASE_SECRET=sb_secret_… npm run test:escrow   # marketplace escrow RLS
```

Each creates its own throwaway users and deletes them on the way out, including
after a failure — deleting an auth user cascades every row it wrote, so a green
*or* red run leaves the project as it found it. Point them at a local stack
with `SUPABASE_URL` / `SUPABASE_KEY`.

**Why these exist rather than a schema review.** `psql` as `postgres` bypasses
row-level security entirely, so it can only prove that tables and policies
exist — never that they do what they say. Both harnesses drive the real REST
surface with genuine user JWTs, which is the only way an RLS claim is testable
at all.

`test:social` is the regression guard on decision 16's visibility rule: 43
assertions covering a stranger blocked from an `all` binder, a requester unable
to accept their own friend request, the offers index refusing a direct dump,
eviction from global matching on a scope flip, and `erase_social()` leaving the
vault intact. It ends with control tests, so a refusal is provably a refusal
and not a missing object.

**Run `test:social` after any migration touching `binders`, `friendships`,
`trade_offers` or `inbox`.** Those policies look correct in review whether or
not they are.

`test:escrow` is the same instrument pointed at money: 45 assertions over a
buyer, a seller, a stranger and an anonymous caller, guarding the sentence
migration 0006 is built around — **nobody may write an order's state or its
amounts through PostgREST**, and nobody may repoint a seller's Stripe account
id, which is where the money goes.

It also holds the escrow state machine to its own table. Migration 0006 is the
only place that graph is written down — `logic.ts` deliberately keeps no second
copy — so this harness is what proves the edges, including that a disputed
order cannot be released and that releasing twice is a no-op rather than a
double payout.

**Run `test:escrow` after any migration touching `orders` or
`seller_accounts`.** Two cleanup notes, both learned the hard way: it deletes
its own orders explicitly, because `orders.buyer`/`seller` are `on delete set
null` rather than `cascade` (decision 19) and deleting the users would orphan
rows rather than remove them; and it creates friendships **as the users**,
because `friendships` grants DML to `authenticated` only, so a service-role
insert 42501s silently and every downstream assertion goes red for the wrong
reason.

Neither of these covers Stripe itself. The pure decisions — signature
verification, event mapping, fee arithmetic, the sweep timers — are in
`tests/unit/stripe-escrow.test.mjs` and need no account. The HTTP calls to
Stripe are exercised only by hand in test mode, and that gap is real: see
docs/decisions.md decision 19.

## CI

| Workflow | Trigger | Does |
| -------- | ------- | ---- |
| `deploy.yml` | push to `main`, manual | `npm ci && npm run build`, force-push `dist/` to `gh-pages`. |
| `scan-harness.yml` | push to `claude/**` touching the fetcher or the workflow, manual | Runs the fixture fetcher where egress is open and force-pushes the result to `harness-fixtures`. Refuses to publish a partial fetch (fixture floor + whole-game failure gate), so a bad run can't clobber a good snapshot. Also uploads the fixtures as a 14-day artifact. |

There is no CI job that runs the matrix itself — it needs the fixtures and ~5
minutes of browser time, so it is a local pre-merge gate, enforced by the rule
above rather than by a check.

## A pre-merge checklist for scan work

```sh
node tests/harness/run-matrix.mjs --out=report/before.json   # baseline FIRST
# … make the change …
node tests/harness/run-matrix.mjs --baseline=report/before.json
npm run test:unit
npm run test:photos         # real photographs — where wrong cards show up
npm run build && node tests/harness/smoke-app.mjs
npm run test:capture        # only if camera.ts or the scan screen changed
npm run test:camera         # ditto — camera on/off lifecycle, both platforms
npm run test:install        # only if the install banner or its triggers changed
npm run test:batch          # only if the scan tray, batch add or db.scans changed
npm run test:invite         # only if invites, referrals or the Friends screen changed
```

If the change touches `detectCardRegions` or anything multi-card, also run
`node tests/harness/run-matrix.mjs --binders-only` and
`node tests/harness/preview.mjs --detect` — **always look at the boxes, never
trust the count.**
