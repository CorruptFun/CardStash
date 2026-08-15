# Testing

Four layers, each covering something the others structurally cannot.

| Layer | Command | Runtime | Needs fixtures? |
| ----- | ------- | ------- | --------------- |
| Unit | `npm run test:unit` | node, seconds | no (one test self-skips without them) |
| Scan matrix | `npm run test:scan` | headless Chromium, ~5 min | **yes** |
| Capture | `npm run test:capture` | headless Chromium, seconds | no |
| Built-bundle smoke | `npm run build && node tests/harness/smoke-app.mjs` | headless Chromium, seconds | no |
| Install banner | `npm run test:install` | headless Chromium, seconds | no |

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
| `cardcode.test.mjs` | `parseCardCode` — reading a printed set/batch number ("BLMR-EN085") out of a search query. The **refusals** are the point: an ordinary card name must never be mistaken for a code. |
| `cardcode-search.test.mjs` | `ygoBySetCode` against a stubbed YGOPRODeck (exact-match set-code endpoint, region/padding spellings, the printing's own price) and `catalogByCode` over a stubbed catalog. |
| `corner.test.mjs` | `parseCornerInfo` per game, `parsePasscode`, `sameYgoCode` — the collector-line parsers, including the fused-fraction reconstruction and its bounds. |
| `names.test.mjs` | `nameCandidates` ranking, `nameScore`/`similarity`/`normalizeName` — including split champion names and the lead-segment tolerance. |
| `orientation.test.mjs` | `looksSideways` and `latinWordCount` — the two pure decisions behind sideways handling. |
| `pokemon-lang.test.mjs` | `matchPokemon` / `pokemonByCollector` / `pokemonById` against a stubbed network: dead primary, multi-language TCGdex, and the real Japanese size collision (sv4K/sv4M both 66) that must **refuse**. |
| `scryfall-corner.test.mjs` | `mtgBySetNumber` — the MTG sole-evidence path. Its *refusals* matter as much as its hits. |
| `sealed.test.mjs` | `identifySealedText` end to end over a stubbed two-set catalog — the Japanese-pack scenario where only the brand word and the printed set code survive OCR. |
| `sealedmatch.test.mjs` | The pure scoring rules: code-prefix stripping, set-code qualification, score ordering against sealed.ts's 0.72 threshold. |
| `tcgcsv-groups.test.mjs` | The group-index merge (primary + "Pokemon Japan" categories) with the network stubbed. |
| `stubs.test.mjs` | That the **harness's** stub APIs honour each real service's query semantics. Skips when the fixture snapshot isn't present. A stub that answers wrong would grade the pipeline against fiction. |

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

npm run test:scan                     # everything (~5 min, ~228 cells)
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

1. The standard matrix reports **zero** wrong cards across 282 cells. Two
   ordinary clips produced **10 wrong in 40 identifications**. A battery of
   stills cannot bound the wrong-card rate of a live scanner.
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
```

If the change touches `detectCardRegions` or anything multi-card, also run
`node tests/harness/run-matrix.mjs --binders-only` and
`node tests/harness/preview.mjs --detect` — **always look at the boxes, never
trust the count.**
