# Scanning

> **Before you change any file named here, read
> [`.claude/skills/scan-harness/`](../.claude/skills/scan-harness/) and run the
> regression matrix before *and* after (`npm run test:scan`).** That skill is
> the authority on thresholds, guard invariants and the debugging methodology;
> this document is the map. The rule exists because synthetic tests passed while
> real cards failed on-device — only real imagery finds these bugs.

## The stance

Identification is **fully on-device**. Tesseract reads the name band and the
collector line; canvas pixel analysis finds the card, removes roll, reads foil
sheen and hashes the frame. The card APIs are consulted only by *name*, *set*
and *number* — no image ever leaves the device. The Gemini key, if the user has
one, powers the AI deck builder and nothing else.

## Module chain

```
ScanView ──▶ useScanner ──▶ camera.ts        (getUserMedia, torch, capture)
                    │
                    ├──▶ vision.ts           (analyzeFrame: motion/sharpness/region)
                    │
                    └──▶ identify.ts ──┬──▶ vision.ts   (refineCardCrop, foil, hash, sideways)
                                       ├──▶ ocr.ts      (workers, preprocessing, name candidates)
                                       ├──▶ corner.ts   (collector-line regions + parsers)
                                       ├──▶ cardsearch  (bestMatchAcrossGames / matchGame)
                                       ├──▶ sealed.ts   (pack/box mode)
                                       └──▶ scandebug   (trace ring)

ScanView ──▶ multiscan.ts ──┬──▶ vision.ts    (detectCardRegions: N boxes)
  (upload / Page pill)      └──▶ identify.ts  (each crop, reduced budget)
                                      │
                                      └──▶ review screen ──▶ user confirms
```

## 1. The camera (`lib/camera.ts`)

`startCamera()` requests the environment-facing camera at ideal 1920×1080,
plays it inline and muted, then probes track capabilities:

- **torch** — exposed as `setTorch` when supported.
- **exposure** — `exposureMode: 'continuous'` is set explicitly where offered,
  and `setLowLightBoost` pushes `exposureCompensation` to 60 % of its maximum
  (and back to 0). Both are advisory; `null` when unsupported.

**iOS permission handling is load-bearing, not incidental.** iOS Home-Screen
web apps get no persistent camera grant — Apple re-prompts on every fresh
`getUserMedia` after the app was closed, and there is no setting or API to
change that. What the app *can* control is how often it re-acquires:

- `CAMERA_REPROMPTS_EACH_ACQUIRE` = iOS **and** standalone display mode.
- On those platforms `releaseCamera()` **parks** the live stream for 25s instead
  of stopping it (torch forced off first). Reopening the scanner inside that
  window adopts the parked stream: no `getUserMedia`, no dialog, no warm-up.
  iOS suspends the capture itself while hidden, so holding the track is cheap.
- Hiding the app suspends the *work* but keeps the session, then probes after
  2s: if the track is still unmuted (a platform that keeps capturing in the
  background) the camera is released outright for privacy.

Do not "simplify" either of these back into stop/reacquire.

**But parking is only for an interruption ON the scan screen.** The card sheet
a scan opens is one — the user closes it and scans the next card. A tab hop is
not, and neither is the page-review screen: both hand the camera back outright
(`stop()` defaults to no park, and `endParkedCamera()` collects anything already
parked), because the alternative is a lit OS camera indicator on a screen with
no viewfinder. That trade is not close — dodging a permission dialog is not
worth looking like the app films you on the Collection tab. The scan screen is
never unmounted, so nothing releases the camera except this; `test:camera` is
what keeps it honest.

**Capture.** `captureFrame()` crops a region of the live video into a canvas
capped at 1100px on the long edge. `captureFrameStacked()` averages 3 frames
70ms apart: sensor gain noise is independent per frame, so the average keeps the
card and divides the noise by √N. It is only used when the scene is dark *and*
the stillness gate has already fired, so ghosting isn't a practical concern; it
tolerates the camera dying mid-stack by averaging what it actually got.

## 2. The scan loop (`hooks/useScanner.ts`)

A `requestAnimationFrame` loop throttled to ≥48ms between analyses (a Sobel
pass at 120Hz is pure heat). Each tick downsamples the video to 288px wide and
runs `analyzeFrame`, which returns motion, sharpness (mean Sobel magnitude),
mean luma, a detected card region and the grayscale buffer for the next
motion diff.

**Statuses**: `idle · starting · searching · locking · thinking · found ·
nomatch · paused · denied · unsupported · error`.

**Gates that must all pass before an automatic attempt fires:**

| Gate | Rule |
| ---- | ---- |
| Stillness | `motion < 7.5`, held 360ms when a card region is being sensed, 950ms when it isn't. |
| Retry gap | ≥1.6s since the last attempt; API failures back off exponentially to 60s. |
| Focus | Sharpness ≥ 62 % of a rolling peak (floor 6), the peak decaying with a 750ms half-life so 120Hz and 60Hz behave the same. Capped at 1.2s so a flat scene can never stall the scanner. |

A **viewfinder tap** (`scanNow`) bypasses the miss cache, the backoff *and* the
focus gate. The whole viewfinder is the shutter.

**Light adaptation.** Below mean luma 58 the scene counts as dark: captures
stack frames, and after a 2.2s sustained dark streak the scanner turns on
whatever the platform offers — the exposure boost first, then the torch. A
passing hand shadow must not strobe the flash, hence the streak. A torch that
throws, or that the user turns back off, is never asked for again this session
(`torchDeclined`). The auto-lit torch announces itself once with a toast.

**One in-flight job.** `ScanJob` holds a generation counter and an
`AbortController`; a superseded run may not report, and stopping the scanner
aborts the pipeline so it stops escalating OCR passes in the background.

## 3. Identification (`lib/identify.ts`)

`identifyFrame(capture, hash, { ignoreMisses, mode, signal })` returns either
`{ ok: true, card, identification }` or a typed miss
(`ocr-miss | cached-miss | api`). Every exit funnels through one `finish()` so
the diagnostics trace always closes.

### The hint

```
gameHint = gameFilter !== 'auto' ? gameFilter
         : enabledGames.length === 1 ? enabledGames[0]
         : undefined
```

A hint is worth a lot: it selects the game's exact collector-line crop, raises
the per-API timeout from 6s to 9s, enables `thorough` recovery retries in the
matchers, and unlocks the collector-line rescue path. **Auto mode has no
collector rescue by design** — see "language independence" below.

### Frame-hash cache

A 128-bit perceptual hash (`frameHash`) with a Hamming tolerance of 10 skips
re-identifying the same card sitting on the table. Rules that matter:

- misses are cached too (a full miss burns ~9 OCR recognitions) but only for
  30s, and **keyed by the game hint** — a miss under `auto` must not suppress a
  retry after the user picks the right game;
- a cached hit must still fit the current filter *and* the enabled games;
- only identifications with confidence ≥ 0.75 are stored, so a collector-line-only
  ID (confidence 0.7) is re-derived per attempt rather than re-served at
  cache confidence.

### Pass order

1. **Crop refinement** (`refineCardCrop`) — Sobel at 192px finds the card and
   the roll angle. It crops only when the detection is ≤ 66 % of the frame area
   (a near-full detection is regularly a few percent tight, and clipping half a
   glyph costs more than the pixels gained); deskews when |angle| ∈ [1.2°, 9°].
   When the crop is skipped the detection is still returned as `cardRegion`, and
   the tiny collector-line rectangles map through it while the broad name bands
   stay frame-relative on purpose.
2. **Orientation** — if the frame looks sideways (see below), candidate quarter
   turns are produced, best first.
3. **Name bands** — the game's `nameBands` order, one at a time, stopping on the
   first match. Top-of-card for Magic/Pokémon/Yu-Gi-Oh/Digimon, mid-card plate
   for Riftbound/Lorcana/Star Wars, bottom banner for One Piece/Gundam; auto
   mode sweeps top then mid. Bands overlap so a line straddling a cut is still
   read whole.
4. **Lookups** — up to 6 candidates per pass through
   `bestMatchAcrossGames(name, games)`, which races the games and resolves early
   on a perfect name hit. The acceptance bar scales with read quality: 0.66
   normally, 0.82 for reads under 8 normalized characters, 0.72 for reads still
   carrying >30 % junk tokens.
5. **Binary retries** — the game's primary band re-read at 960px, Otsu-binarized,
   in **both** polarities. Ornate glyph faces routinely defeat the mean-luma
   polarity heuristic; this is a different failure surface and regularly cracks
   what pass 3 mangled.
6. **Anywhere sweep** — the whole card at 700px with automatic layout detection
   (PSM 3), for promos and full-arts that put the name anywhere.
7. **Collector-line rescue** (hinted mode only) — see below.
8. **Refine** — on any name hit, `refineFromCorner` re-reads the collector line
   and upgrades to the exact edition. `relatedNames` guards the swap: the
   corner-pinned card must be similar (≥ 0.7) or a normalized prefix relation, so
   "Tauros" → "Tauros ex" is allowed but an unrelated card is not.

### Budgets

Three independent budgets keep a miss from cooking the phone:

- **Lookups**: 4 "slow" (>1.5s) lookups and a 20s wall clock. Fast lookups are
  nearly free and deep candidate exploration is the accuracy win — only requests
  riding a dying API's timeout count.
- **OCR**: 2 watchdog kills or 18s of attempt ends band escalation. Each
  recognition is itself bounded at 6.5s (8s for wide/sparse passes); on expiry
  the worker is terminated — the only way to interrupt the wasm — and respawned
  from cache.
- **Sole-evidence corner sweep**: 5 magnified passes (2 when the OCR budget is
  already spent).

### Language independence — the collector-line path

Names are read by an English-only Tesseract, so a Japanese card offers no
readable name. What *is* Latin on every print worldwide is the collector line,
and each game has an independent identifier there:

| Game | Evidence | Guard |
| ---- | -------- | ----- |
| MTG | exact set code + collector number (`mtgBySetNumber`) | No fuzzy fallback ever. Needs the set code (which only parses beside a language token, "NEO・JP") **and** either modern zero-padding or a self-consistent fraction; a printed fraction is verified against the set's real `printed_size`, fail-closed. Collector numbers are dense — a one-digit misread lands on a real neighbouring card. |
| Pokémon | number + printed set size, plus the set code when read | A *reconstructed* fraction (OCR ate the slash) identifies only when the code, size and set membership all agree. Without a code, the printed size must single out exactly one set across all languages — Japanese pairs same-size sets (sv4K/sv4M are both 66), so refusing is correct. |
| Yu-Gi-Oh | the 8-digit passcode | It *is* the YGOPRODeck id and the id space is sparse (~13k cards over 100M combinations), so a misread resolves to nothing rather than to a wrong card. |
| Catalog games | number + printed total, both agreeing with a catalog row | Base printings outrank "(Alternate Art)" variants when the number is the only evidence. |
| Pokémon, localized names | DE/FR/ES/IT/PT names via TCGdex language catalogs | Western prints share ids, so a localized hit is re-fetched as the EN card. |

The `thorough` read differs from the refine-path read in four ways: it re-reads
even when the speculative strip already covered the region, upscales 5×, uses
sparse page segmentation (PSM 11 — the default single-block mode locks onto the
rules box and drops the small detached collector line), and merges partial
reads across passes because the parts can live in opposite polarities (a white
set-code badge beside dark digits).

### Which PRINTING — and admitting when it wasn't read

Identifying the card and identifying the printing are two different
achievements, and the pipeline reports them separately.

`refineFromCorner` pins the edition from the printed code once the name has
found the card. When it can't — the code didn't read, or the card was
identified by a Yu-Gi-Oh passcode, which names the card in every language but
says nothing about which reprint is in the hand — the edition shown is the
SOURCE's default: for YGOPRODeck, the first entry in `card_sets`, an arbitrary
reprint out of a dozen whose prices span two orders of magnitude. A Secret Rare
filed at a $0.12 reprint's price is the right card and the wrong answer.

So `IdentificationMeta.pinned` says which happened, and it is carried through
the frame cache and out to the UI: with it false, the card sheet marks the
edition unread and puts the printing picker one tap away
(`printingUnconfirmed` in the sheet request). The scanner is allowed to guess
the printing; it is not allowed to present the guess as a reading.

Yu-Gi-Oh's code window is the band BETWEEN the art and the rules box. It used
to sit at y 0.50–0.63, which is inside the ARTWORK on the modern frame: probed
against the harness photographs it returned pure foil sparkle on every pass
while the code sat one band lower. Fixed, but note what the same round showed
about paying for it — Yu-Gi-Oh gets no extra retry windows, because its passes
are wanted for the wide bottom band where the passcode reads, and two extra
code-band rects cost a real photograph its identification outright. A better
printing is never worth a lost card.

### The cloud rescue's timing

`cloudScanRescue` (opt-in, and the switch is its own act — see
[decisions.md](decisions.md) 1 and [privacy.md](privacy.md)) no longer waits
for the local pipeline to exhaust itself. It starts on a **2.5s timer**
(`CLOUD_HEADSTART_MS`, measured from the top of `identifyViaOcr` so a sideways
frame's orientation probing counts) and runs alongside the remaining passes:

- A local answer wins if it lands first, and `settle()` aborts the request in
  flight on every way out of the function. Local answers outrank the model's
  because they carry corroborating evidence — a matched name plus a printed
  line — that one reading of a whole card doesn't.
- A cloud answer that lands mid-sweep ends the sweep. There is nothing to be
  gained by grinding the magnified collector passes once the answer is in hand.
- Exactly one call per attempt: `cloudCalled` keeps the raced call and the
  last-resort call from both firing, and the last resort starts immediately
  rather than waiting the deadline out when everything local has already
  failed.
- The raced call is rationed by `CLOUD_RACE_COOLDOWN_MS` (8s, module-level,
  across attempts) because the live scanner retries on its own and a hand-held
  card jitters into a fresh frame hash each time, so the miss cache doesn't
  cover it. The last-resort call is not rationed.

Entitlement is not checked here and shouldn't be: the hosted route is the
server's call (decision 2a), and a client-side check only adds a way to be
locally wrong about what someone paid for.

### Sideways cards

People photograph cards lying flat on a desk, so the card arrives quarter
turned — and every band and collector region is written in *upright card
coordinates*. `looksSideways()` decides whether to look, using two measured
arms: `lineRatio` (how much of the edge mass is banded along rows vs columns —
text lines pack edges perpendicular to their direction) below 0.85, or a
landscape detected aspect while the layout doesn't clearly disagree.
`uprightOrientations()` then decides which way is up: the collector line
arbitrates when it reads (script-agnostic on purpose — the decision happens
before any name is read), and when it doesn't, **both** turns are read through,
ordered by how many Latin words the probe strip produced (the right way up shows
rules text; the same pixels 180° out are unreadable to Tesseract). The frame as
captured stays last, with the whole-card sweep alone.

**Guard:** a turned frame demands a 0.95 match on the *whole printed name*, not
on `nameScore`. `nameScore` deliberately forgives a missing epithet (cards print
"JINX" over "Loose Cannon"), which parks every bare champion lead at exactly
0.95 — and a lead cannot tell one sibling from another. This is not
hypothetical: a turned "Ahri - Inquisitive" read as "Ahri" came back as
"Ahri - Alluring".

### Foil detection (`vision.ts: foilSheen`)

A foil throws bright, saturated specular streaks whose hues span the rainbow and
spread across the card; printed art almost never puts five or more hue families
of near-specular highlights in multiple quadrants at once. Deliberately
conservative: it answers "definitely foil" or "don't know", never "definitely
not" — a foil held flat shows no sheen. A sheen on an MTG printing that never
came foil triggers a re-pick of the newest foil-capable printing.

## 4. OCR (`lib/ocr.ts`)

**Self-hosted.** The Tesseract runtime is a lazy chunk; the worker, the two LSTM
wasm cores and the English `4.0.0_best_int` traineddata are copied out of
`node_modules` into `ocr/` at build time and served from our own origin (see
[pwa-build-deploy.md](pwa-build-deploy.md)). No third-party CDN at scan time.
The service worker runtime-caches `ocr/`, so scanning works offline afterwards —
and it is deliberately **not** precached, so devices that never scan never pay
for it.

**Two workers.** The primary reads name bands and pack fronts; a secondary
spawns in the background so the collector-line read overlaps band reads instead
of queueing behind them. Both run PSM 6 (single block) by default; passes that
need PSM 3 or 11 switch and restore in a `finally`.

**A terminated worker is never touched again.** Both the watchdog and
`stopOcr()` terminate workers, and Tesseract's handle carries no liveness flag:
`terminate()` nulls the port behind it, every later call posts to null, and the
library drops the promise its internal `send()` returns — so the `TypeError`
escapes as an unhandled rejection *and* the call's own promise never settles,
wedging any `await` on it regardless of `.catch()`. So `ocr.ts` owns the
lifecycle: `killWorker()` terminates at most once and records it, `isLive()`
gates, and the PSM switches go through `setPageMode()`. There is one window
liveness cannot cover — Tesseract awaits `toBlob()` + `FileReader` *before* it
posts — so `recognizeBounded` encodes the PNG itself (byte-identical to what
Tesseract would have made) and checks liveness after, leaving no gap between
the check and the post. Add worker calls through those helpers, never directly.

**Preprocessing** (`prepRegion` → `normalizeContrast`): crop, rescale toward a
target width, grayscale, then a **locally adaptive** percentile contrast stretch
— 4×4 tiles, bilinearly interpolated, so a glare streak saturates its own corner
instead of flattening the whole band. Flat tiles inherit global levels so noise
isn't amplified. Polarity is flipped for dark crops (light type on a dark plate
reads far worse than dark-on-light); the `binary-flip` variant forces the
opposite call. Amplified sensor speckle on dark crops is damped with a small box
blur — that texture is exactly what makes Tesseract dwell for tens of seconds.
`binary` variants finish with an Otsu threshold.

**Name candidates** (`nameCandidates`) are ranked by plausibility, not reading
order, because the lookup budget is finite and plate/art garbage above the name
must not consume it. Beyond raw lines it offers: adjacent short lines joined
("JINX" + "Loose Cannon"), the line minus a short leading label ("BASIC Tauros"),
the line minus trailing junk ("Lightning Bolt ek e)"), and the longest
name-plausible token window ("AKALI 101A SEN" → "AKALI"). Up to 8 are emitted.

## 5. Sealed (pack/box) mode

A separate mode with its own capture region (a wide centred window, no card-crop
refinement), its own OCR pass (`readSealedLines`, PSM 3 over the whole frame) and
its own matcher:

1. `sealedmatch.ts` scores OCR text against the TCGplayer **group** (set) index —
   whole-name containment (0.86 + a length bonus), per-line fuzzy similarity, or
   an exact printed set-code token (0.80). Threshold 0.72.
2. `sealed.ts` then ranks that set's sealed products by which product words the
   packaging carries — a booster *box* front says "36 Play Booster **Packs**",
   a single pack just says "Booster".

The set-code signal is what identifies Japanese Pokémon packs: their fronts
carry no Latin set name at all, only the code ("sv4K"). Those sets live in a
separate TCGplayer category ("Pokemon Japan") which `tcgplayerGroups` merges
into the Pokémon group index. A code only participates if it is ≥3 chars and
carries both a letter and a digit — "MEW" and "151" collide with real card names
and plain numbers — and it always ranks *below* a readable set name.

`sealedmatch.ts` is deliberately free of catalog/DB imports so node unit tests
can exercise the scoring rules directly.

## 5b. Sports and graded slabs

Two more modes, both of which only run when the user has asked for them.

**Sports cards** (`gameHint === 'sports'`). No catalog exists, so the read *is*
the identification: `readSportsLines` (PSM 3 over the whole frame, keeping the
`#`, `/` and `©` that `readSealedLines` strips) → `parseSportsText` → a
synthesized `Card`. Card backs are the good side — number, copyright year and
brand are all printed there — but the parser takes whichever side it is given.
A weak read retries with a different **binarization**, never a lower bar.

**Sports never joins the auto sweep.** `sweepable` filters it out of every
place the fan-out picks games for itself. This is not a performance choice: in
auto mode a card that matched nothing would be *synthesized* into a sports card
that does not exist — a confident wrong answer, the failure class this pipeline
works hardest to avoid. Sports requires picking the game, the same way the
collector-line rescue does.

**Graded slabs** (`mode: 'slab'`). The best input the app ever gets: a
manufactured label in clean printed type, with a fixed grade vocabulary and a
cert number. `parseSlabLabel` (pure, in `slab.ts`) reads the top 30% band, and
falls back to the whole frame if the label is not where it guessed.

The bar for "this is a slab" is a **company marker plus either a grade or a
cert**. A card can easily mention a number; only a slab says PSA and 10 in the
same breath. A company name with no grade at all is refused outright — that is
a sleeve or a shop logo. The company is never inferred from cert length.

When the label carries a cert and the user has supplied a PSA token, `psa.ts`
resolves it to the exact card and that answer replaces the OCR read
(confidence 1). Without a token, nothing is sent anywhere and the label's own
text is parsed like any other sports read. The grade survives either way.

**A slab is not always a sports card.** With a TCG selected, the label's text is
treated as an ordinary name read and matched against that game's real catalog
(top 3 candidates, threshold 0.8 — clean printed type earns a higher bar than a
photographed card face). The identity comes from the catalog, so this branch
carries none of the synthesis risk the sports path guards against. With **no**
game picked, a slab falls through to the sports reader, which is the only one
that can work without a catalog; a graded Charizard will honestly miss there and
the message says to pick the game.

The sports path also recognizes a slab handed to it, so a user scanning their
collection never has to know there was a mode.

## 6. Multi-card / binder scanning (`lib/multiscan.ts`)

A binder page, a fanned stack, a row of cards in one photo. `detectCardRegions`
(`vision.ts`) finds the rectangles, each crop is identified on its own, and the
caller shows a **review screen** before anything is written.

**Nothing in this path adds a card.** A page files ~9 rows in one confirmation,
so a silent wrong card is nine times more expensive than in single scanning —
the user confirms, always.

Three constants carry the design:

- `PAGE_MAX_EDGE` (3200) — the long-edge cap for a multi-card source,
  deliberately *above* the single-card `CAPTURE_MAX_EDGE` (1600). A 3x3 page cut
  out of a 1600px frame leaves each card ~500px wide, under the ~790px where a
  printed collector fraction stops being legible, so a page scaled like a single
  card arrives pre-blinded and the collector-line rescue can never fire. 3200 is
  7.7M pixels, inside Safari's 16.7M canvas ceiling.
- This is an **upload** ceiling. `captureFrame` only downscales and the stream is
  requested at 1440p, so a *live* page scan gets ~2560px at best — roughly 340px
  per card on a 3x3 page. That is the honest reason to shoot a binder page as a
  photo rather than through the viewfinder.
- `PAGE_SCAN_BUDGET` — a fraction of the single-card budget, since breadth is
  traded for depth. `rescanPageCard` re-reads one row from the review screen on
  the **full** single-card budget; that is the built-in fix for a row the page
  pass got wrong.

`MAX_PAGE_CARDS` is 12.

### The entitlement seam

Photo upload and page scanning are the **planned paid tier**. Neither is gated
today. The seam is `lib/entitlement.ts` — a `GATED` table with every row `false`,
checked at two entry points: the upload control (`UploadButton` in `ScanView`)
and the page-scan path (the Page pill's live tap, and the page branch of an
upload).

**Never gate `detectCardRegions` itself.** That primitive is shared: it is also
the fix for ordinary single-card detection over-reaching on cluttered
backgrounds, which is the *free* path and the dominant real-world failure
(scan-harness lessons 32, 34-38). Gating it would quietly degrade free scanning
for everyone. See [decisions.md](decisions.md#13-the-paid-tier-has-a-seam-but-no-authority).

## 7. Diagnostics

`scandebug.ts` keeps the last 24 attempt traces: every OCR pass's raw text,
the candidates produced, each lookup and its score, collector-line parses, crop
and orientation decisions, and the final outcome with timing. On a phone it is
behind the eye icon on the no-match chip (`components/ScanDebug.tsx`, copyable).
The regression harness reads the same trace to attribute failures to a stage.

**The trace contains card text and must never feed analytics**, whose events are
content-free by contract.

## Known limits (measured)

- Pokémon full-arts with outline/gold script defeat OCR upright, so they also
  fail sideways.
- At fixture resolution the Japanese set-code badge and MTG's collector digits
  are not reliably readable — both Japanese fixtures correctly **refuse** rather
  than guess. They are kept as guard fixtures: if a future loosening turns
  either into a wrong card, that loosening is wrong.
- Auto mode has no collector-line rescue, so a non-English card requires picking
  the game. The miss message says so.
- **The multi-card detector cannot see a quarter-turned card, at all.**
  `detectCardRegions` sweeps aspects 0.587..0.859 (from `CARD_ASPECT` 63/88) —
  portrait only — and a sideways card's bounding box is landscape at ~1.40, so
  the right rectangle is never *proposed*. Measured on a real 3x3 page: 5 boxes,
  none of them on a single card, one swallowing six. Note the *single*-card path
  handles turned cards fine (`looksSideways`/`uprightOrientations`); the gap is
  entirely in the detector, so every crop would identify once the boxes are
  right. Two obvious fixes were built and measured and **both were rejected** —
  orientation scoring does not discriminate (a known-upright page scored *higher*
  turned, 14.09 vs 11.61), and proposing both aspect bands broke the arbitration
  rules that assume one card shape (a known-good page fell 8/8 → 4/8). See
  scan-harness lessons 52 and 54 before attempting a third.

### Where the numbers actually stand

Three batteries, three different questions. Quoting one for another is the
easiest way to overstate the scanner:

| Battery | Command | Result |
| ------- | ------- | ------ |
| Standard matrix (rendered fixtures, 9 degradations) | `npm run test:scan` | **204/282 (72%), zero wrong cards** |
| Hand-curated real photographs | `npm run test:photos` | **4/12 (33%)**, 1 wrong card |
| Handheld clips (frames from real video) | see lesson 47 | **10 wrong in 40 identifications** |

The matrix reports zero wrong cards across 282 cells; two ordinary handheld
clips produced ten. `compose()` structurally cannot generate the input that
causes it — a frame where a *moving* highlight leaves the name half-legible in
one specific way. **A battery of stills cannot bound the wrong-card rate of a
live scanner**, and the wrong-card rate is the number that matters most.
Per-game on the matrix: Yu-Gi-Oh 36/36, One Piece 18/18, Riftbound 50/54,
MTG 46/57, Pokémon 54/117 — Pokémon is the standing weak spot (58 ocr-misread,
5 match-none).
