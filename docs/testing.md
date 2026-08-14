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

Two paths the matrix cannot reach have their own checks: the camera itself
(`test:capture`) and the built bundle (`smoke-app.mjs`). Changes to `camera.ts`
or the scan screen need those, not just the matrix.

## Unit tests (`tests/unit/`)

Plain `node --test`. App modules are TypeScript, so `bundle.mjs` bundles an
entry with esbuild (already present as a Vite dependency) into ESM the test can
import — with `alias` to stub a *sibling* module (e.g. swapping `./fetchJson`
for a canned-network stub) and `external` to keep a heavy lazy dependency out
(the Tesseract runtime).

| Test | Covers |
| ---- | ------ |
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
npm run test:install        # only if the install banner or its triggers changed
```

If the change touches `detectCardRegions` or anything multi-card, also run
`node tests/harness/run-matrix.mjs --binders-only` and
`node tests/harness/preview.mjs --detect` — **always look at the boxes, never
trust the count.**
