# Identify pipeline map (v0.7.0)

Read this before changing any constant or pass. Costs are per Tesseract
recognition on phone-class hardware; the happy path pays 1–2, a full miss
pays ~9–10 — that asymmetry is deliberate (a slow miss beats a failure).

## Pass order inside `identifyViaOcr` (src/lib/identify.ts)

1. **refineCardCrop** (`vision.ts`) — Sobel at 192px: card region + roll
   angle. Crop applies only when region area ≤ 0.66 of frame (a near-full
   detection is regularly a few percent tight; clipping half a glyph costs
   more than the pixels gained — this exact over-tightening once cut the
   "C" off Counterspell). Deskew when |angle| ∈ [1.2°, 9°]. When the crop is
   skipped, the detection is still returned as `cardRegion` and the tiny
   collector-line rects MAP through it (bands deliberately stay
   frame-relative — a mediocre detection must not shift them off the name).
2. **Band sweep** — game's `nameBands` order (`ocr.ts`), OCR at 640px,
   per-tile local contrast (4×4, bilinear; glare saturates one corner, not
   the whole band) + dark-plate polarity flip. Candidates are
   plausibility-RANKED, not positional (`nameCandidates`): raw lines, joined
   short pairs (split champion names), leading-label strip ("BASIC Tauros"),
   trailing-junk trim ("Lightning Bolt ek e)"), longest wordish window
   ("AKALI 101A SEN" → "AKALI"); up to 8 emitted.
3. **Lookups** — up to `OCR_NAMES_PER_BAND = 6` per pass, consumed-marked at
   lookup time (unconsumed candidates stay eligible for later passes).
   Speculative collector-line OCR is queued in parallel on the second
   worker.
4. **Binary retries** — primary band at 960px, Otsu-binarized, BOTH
   polarities (`binary`, `binary-flip`) — ornate faces defeat the mean-luma
   polarity heuristic; this pass cracks stylized type the stretch pass
   mangles. Then the THREE chroma projections (`chroma-min` = min(R,G,B),
   `chroma-max` = max(R,G,B), `chroma-sat` = max−min), which throw the colour
   away instead of averaging it in: card text is very nearly neutral even on a
   foil while a sheen or a coloured plate is not, so the extreme channels
   separate what Rec.601 luma fuses. min for light text on colour, max for
   dark text on colour — complementary, same reason both binarization
   polarities are.
   Measured +16 cells on the standard battery and +4 on the foil battery,
   with zero new wrong cards, and the run got FASTER (a hit here skips the
   whole-card PSM-3 sweep). Not gated on `detectFoil`: that detector is tuned
   conservatively for PRICING ("false means unknown") and does not fire on
   sheen at all — and the win is much wider than foil anyway, because card
   art is saturated in general.

   `chroma-sat` answers the opposite LAYOUT: a metallic name on a
   comparatively neutral bar (Yu-Gi-Oh Ultra/Secret Rares), where the TEXT is
   the coloured thing. Level projections lose that case structurally — a metal
   is a RANGE, shadow → base → highlight, and the range straddles the bar's
   own level, so contrast changes SIGN inside a single glyph and no downstream
   stretch or threshold can undo it. Saturation holds one polarity across the
   whole range, because a metal's colourfulness barely moves while its
   brightness swings. Silver has no other answer at all: near-neutral by
   construction, so every intensity projection collapses onto the paper, and
   that same neutrality is what makes it stand out here. Measured +4 on the
   foil-text battery and YGO 34/36 → 36/36 on the standard one. LAST in the
   ladder because it is the narrowest — a name that reads at any rung above
   never reaches it. Its polarity comes from histogram SKEW, not mean
   brightness: in a saturation channel a low mean means desaturated, which
   says nothing about which side the text is on (lesson 28).
5. **Anywhere sweep** — whole card at 700px, PSM 3 (promos/full-arts put
   names anywhere).
6. **Corner-first ID** (last resort, hinted only) — escalating collector
   reads: speculative strip → game region → narrow per-game slivers
   (`CORNER_RETRY_REGIONS`) at full magnification, binarized. If number AND
   total survive **with a printed slash actually read** (`!read.fused`),
   resolve by collector alone: `pokemonByCollector` (primary
   `number + set.printedTotal`) or `catalogByCollector` (both halves must
   agree with a catalog row; BASE printing outranks "(Alternate Art)"
   variants). Confidence 0.7.
7. **Refine** (on any name hit) — `refineFromCorner` re-reads the collector
   line, upgrades across suffix variants ("Tauros" → "Tauros ex" when
   183/226 says so) via `relatedNames` (similarity ≥ 0.7 OR normalized
   prefix relation, both ≥ 4 chars). Fused fractions ARE allowed here — the
   name match corroborates them.

## Thresholds and knobs (and why they are what they are)

| Knob | Value | Why |
| --- | --- | --- |
| `OCR_MATCH_THRESHOLD` | 0.66 | 0.62 admitted "EMPOWERED"→"Empowered // Gold" (0.643) |
| `OCR_MATCH_THRESHOLD_SHORT` (<8 norm chars) | 0.82 | one edit on 4 letters scores 0.75 ("loli"→Loki, "son"→Sona); 0.8 still admitted "Ambess"→wrong Ambessa (0.807); genuine champion leads score ≈0.95 |
| `OCR_MATCH_THRESHOLD_NOISY` (>30% junk tokens) | 0.72 | junk inflates edit distance; "Eo : Charizard HP"→Mega Charizard squeaked 0.632 past base |
| Band prep variants | `normal`, `binary`, `binary-flip`, `chroma-min`, `chroma-max` | the first three project RGB→grey with Rec.601 luma; the chroma pair use min/max(R,G,B) instead. Luma FUSES saturated sheen with neutral ink — contrast is gone before any stretch or Otsu runs. Not gated on `detectFoil` (see below) |
| `CAPTURE_MAX_EDGE` (camera.ts) | 1600 | at 1100 a card crop reaches OCR ~790px wide and the printed fraction sits at the edge of legibility; the stream is requested at 1440p so this downscales rather than upsamples |
| `slowLookupsLeft` / deadline | 4 slow (>1.5s) / 20s | fast lookups are nearly free — deep exploration is the win; only a dying API's timeout-riders must not stretch an attempt into minutes |
| `MISS_TTL_MS` | 30s | a full miss burns ~9 recognitions; same unchanged frame must not re-burn twice a minute (tap bypasses) |
| cache write gate | confidence ≥ 0.75 | corner-only IDs (0.7) re-derive per attempt — never re-served at cache confidence 1 |
| miss-cache key | includes gameHint | a miss under 'auto' must not suppress retry after the user picks the right game |
| Focus gate | ratio 0.62 of rolling peak, floor 6, cap 1.2s, half-life 750ms (time-based) | phones hunt focus right after motion stops; cap prevents stalls; time-based decay so 120Hz ≡ 60Hz |
| Sense cadence | ≥48ms between analyses | Sobel at display refresh is pure heat |
| Fused fraction bounds | total ∈ [30,400], number ≤ total+150, 5–6 digit runs | OCR eats the tiny slash ("156/149"→"156149"); bounds keep years/HP out |
| `RECOGNIZE_TIMEOUT_MS` | 6.5s (8s wide) | successful NOISY reads run 4.5–5s; runaway speckle dwells 20–60s — the cap sits between them; on expiry the worker is terminated + respawned (only way to interrupt the wasm) |
| OCR attempt budget | 2 watchdog kills OR 18s | pathological texture won't read on pass 6 either; skip to the bounded collector path |
| `DARK_LUMA` (scanner) | 58 | below it: stacked capture + dark streak logic |
| `DARK_STREAK_TORCH_MS` | 2.2s | a passing hand shadow must not strobe the flash |
| Stacked capture | 3 frames, 70ms apart | sensor noise is per-frame independent — the average divides it by √N; measured on the matrix: dark 4/21 → 17/21 |
| Detection stretch | span < 110 → full-range LUT | Sobel thresholds (160/220) are calibrated for lit frames; dark edges fall under them while vignette/noise survive → half-card crops |

## Guard invariants — do not weaken one without its counterpart

1. **Every retrieval tolerance pairs with an evidence gate.** Junk-tolerant
   retrieval (pokemon queryWord filtering, dexBriefs longest-word retry,
   scored-brief tier, ygo longest-word fname fallback) exists ONLY because
   the quality-scaled thresholds above reject weak fits. Loosening retrieval
   without the thresholds recreated 16 wrong-cards in one run.
2. **Corner-only identification demands a printed slash** (`!fused`) and
   independent agreement (API/catalog must have that exact number+total).
   Reconstructed digit runs ("ILLUS 17208" → 17/208) resolve to arbitrary
   real cards otherwise — proven concrete in review.
3. **Number evidence outranks name tiers in dexMatch** (numbered filter runs
   across exact ∪ startsWith ∪ scored pools) — the exact-name tier alone
   locks in "Tauros" before 183/226 can pick the ex. And dexMatch pools keep
   the TAIL (newest last) — score-ranked tiers sort ASCENDING on purpose.
4. **matchPokemon ranks by name fit (newest tiebreak), then cross-checks
   TCGdex when best fit < 0.98** — the primary's newest-first page can
   simply lack the old exact card (sixty "Charizard ex" variants shadowing
   plain Charizard).
5. **MTG corner parse:** fraction denominator ≥ 45 (P/T boxes are small) and
   any line with a REJECTED fraction is skipped entirely (its digits must
   not feed the solo-number fallback).
6. **Abort:** `identifyFrame` takes the scan job's signal; passes `bail()`
   between stages so a stopped scanner stops escalating.
7. **A cross-game match needs game evidence** (`collectorLineAllows`,
   corner.ts). The auto sweep keeps the best `nameScore` across games and
   nothing in that comparison knows what game is in frame, so a game that
   fails to answer — pokemontcg.io 500s routinely — cedes its card to whoever
   else matched the read. Yu-Gi-Oh is the dangerous claimant: `fname=` is a
   substring filter over ~13k names, so it answers almost any fragment, and a
   fragment that hits a name EXACTLY scores 1.0 and clears every threshold.
   The printed collector line arbitrates: the fraction games (Pokémon, MTG,
   Lorcana, Riftbound, SWU) print "183/226", the code games (Yu-Gi-Oh, One
   Piece, Digimon, Gundam) print "LOB-EN001" and never a fraction. One
   directional — it only rules a game OUT, only on the shape it cannot print,
   and a strip that read nothing rules out nothing. Measured over the matrix:
   fires on 41/81 Pokémon cells, **0/36 Yu-Gi-Oh** ones.
8. **A lead-only read may not answer for a catalog game whose lead has
   siblings** (`isLeadOnlyMatch` + `catalogLeadVariants`). `nameScore`
   forgives a missing epithet by design, which parks EVERY bare champion
   lead at exactly 0.95 and clears every bar — and 48 of Riftbound's 98
   champion leads carry more than one epithet, with the epithet sharing the
   same hard-to-read plate as the name. Measured: "Ambessa" off a clipped
   plate answered "Ambessa - The Wolf" for a "Respected and Feared" card.
   Refusing routes the frame to the collector line, which CAN separate them.
   Narrow on both sides: the read must have cleared the bar on
   lead-forgiveness alone, and alternate printings of one card ("(Alternate
   Art)") collapse so they are not counted as a second answer — a champion
   with a single card still identifies off the bare lead.
9. **A cleanly-read collector line outranks a name match it contradicts**
   (catalog games; `refineFromCorner` → `viaCollector`). Two printed numbers
   agreeing with a catalog row beat one fuzzy name read. Guarded like every
   other sole-evidence use: printed slash actually read (`!fused`), both
   halves agreeing, and the resolved card genuinely unrelated to the name
   match (`relatedNames` false) — a related name means the same card family,
   where the normal refine picks the printing. Measured: an artist credit
   ("Kudos Productions") matched "Production Surge" at 0.688 on a card whose
   line read 120/166, which is exactly the right card.
10. **A bare Pokémon species must survive its own rules box**
   (`parsePokemonVariant`, corner.ts). Dropping a two-letter suffix leaves a
   name that matches a real card EXACTLY — "Tauros" for a Tauros GX, score
   1.0 — so no threshold can reject it and the answer is a confident wrong
   card at the wrong price. The card declares the suffix a second time in the
   rules box, in sentence-sized type, inside the bottom strip already read for
   the collector line. When the matched name carries NO suffix and the strip
   declares one, the declared variant must resolve to a real card or the match
   is refused. Strictly narrowing: a name band that DID read a suffix is left
   alone, and the parser is anchored on "Pokémon"/"rule"/"power" beside the
   marker so a stray "ex" in flavour text is not a declaration. Measured over
   162 captured Pokémon cells: 60 fires, 60 correct, 0 false, silent on every
   cell of the one no-suffix fixture.
11. **Candidates below `MIN_NAME_LETTERS` (3) are never looked up** (ocr.ts).
   `trimTrailingJunk` could shed everything but a two-letter head ("gr ee" →
   "gr"); the matrix spent 119 lookups on such fragments and not one ever
   identified a card, while each was a chance to hit a real name exactly in a
   big catalogue. Three, not four, because "Mew" and "Muk" are real.
12. **A confident answer can be SUSPECT, and the rescue has to fire on that,
   not only on a miss.** The cloud rescue was first wired where every failure
   path ends — after all local passes give up. That is the wrong place for the
   failure it was bought to fix. The wrong-card class is not a miss: the local
   path returns "Krookodile" at score 1.0 for a Krookodile ex and never asks
   anyone (lessons 29 and 47). A miss-triggered rescue therefore cannot touch a
   single one of them, which is why turning it on changed nothing.
   So a Pokémon match on a BARE species, whose rules box declared no variant
   (invariant 10 silent — unread, or read as "Pokémon €X rule"), and which has
   a suffixed sibling in the catalog, is treated as suspect and re-read in the
   cloud. Four narrowings hold it down, and all four are load-bearing: Pokémon
   and suffix-less only; only when invariant 10 found nothing to say; only when
   a sibling actually exists (a species with no ex/GX/V printing cannot be
   wrong this way); and only when the rescue is ARMED — checked first and sync,
   so an un-opted-in user does not even pay the sibling lookup and the free
   path is unchanged instruction for instruction.
   The cloud may only REPLACE the answer, never withdraw it: any refusal —
   off, unreachable, or rejected by `CLOUD_MATCH_THRESHOLD` on the whole
   printed name — falls through to the local card. That keeps the worst case
   equal to today rather than trading wrong cards for misses, which would be
   the same mistake in the other direction.

13. **The right card at the wrong PRINTING is its own failure class, and the
   matrix now measures it — beside the pass rate, never inside it.**
   `graded()` in run-matrix.mjs still compares game + name similarity only, so
   a borderless fixture answered with the base printing still scores a PASS;
   `printingOf()` (commit 008c864) asks the second question and the runner
   prints `printing: N/M` overall and per game, gated by `PRINTING
   REGRESSION` (per-game rate over keys shared with `--baseline`), `PRINTING
   CLAIMED WORSE` (cells wrong while `pinned`, which may never grow) and the
   `--min-printing-rate` floor. It is deliberately not folded into the pass
   rate — see lesson 62. The `borderless-any` MTG fixture that "could not
   fail this way" registers `printing: 'wrong'` on all 12 of its cells.
   Standing baseline on main: **205/282 identified (73%), printing 118/169,
   4 wrong while claiming the code was read** — per-game printing onepiece
   18/18, riftbound 42/50, pokemon 35/55, mtg 23/46.
   What the column still does NOT cover: treatment/frame, finish and
   language are recorded nowhere and graded not at all, and clips and binder
   pages carry no printing ground truth in their manifests, so printing is
   graded only on singles. Yu-Gi-Oh is excluded outright
   (`REPLICA_ART_GAMES`, lesson 63). Read the matrix as evidence about
   printings only through that column and only within those limits.
   Measured off a real photo before any of this existed: Human Torch, Johnny
   Storm `MSH #0321` (borderless, foil, quarter-turned) came back as
   `MSH #136` — right name, right set, ordinary frame, wrong art, wrong
   price.
   The mechanism is structural rather than unlucky. On a full-art card the
   collector line is small type over artwork at the very edge, and the
   full-bleed frame gives `refineCardCrop` no border to lock onto — while the
   refine path uses the WEAKEST corner read in the pipeline (3× upscale,
   single-block, one polarity, ≤3 passes). The 5×/sparse/mixed-polarity ladder
   and the raw-frame bottom-band rescue are sole-evidence only, i.e. reached
   only when no name was readable. The card that most needs the strong reader
   is exactly the one that never gets it, and with no number pinned `matchMtg`
   answers by fuzzy name — which Scryfall resolves to one default printing.
   **The read rate is the lever, not the ranking.** Per-cell across the four
   fixtures that lose printings, the correlation is essentially perfect: when
   the printed line yields a number the printing is right, and when it does
   not the printing is wrong. `pokemon/charizard-base` reads `4/102` on 3 of
   12 cells — those 3 are correct, the other 9 answer Celebrations
   `SWSH11.5TG TG03` (lesson 67's headline case: a four-figure card at a
   three-dollar price). `pokemon/rayquaza-vmax` reads `70/203` on 1 of 12 —
   that one is correct, the other 11 answer `SWSH12.5TG TG29`.
   `riftbound/short-name-1` reads nothing on all 8 and is wrong on all 8.
   The consequence to keep in mind before designing anything clever here: **a
   printing RESOLVER has nothing to rank when `number` and `total` are both
   null**, and 39 of the 51 wrong-printing cells have no collector evidence at
   all. Ranking is downstream of reading; spend the effort on the line.
   `mtg/borderless-any` is the exception that names the second mechanism: it
   reads `PRM 2` on 5 of 12 cells and is still wrong on all 12, because
   `matchMtg`'s fuzzy fallback resolves a failed exact lookup to the base
   printing (`MSC #806`).
   `printingTiebreak` (identify.ts) is invariant 12's principle applied to that
   class: a confident answer that settled the card but not the edition is
   SUSPECT, and the cloud read is asked `treatment` — the one question
   on-device OCR structurally cannot answer. Its guards are in
   `docs/scanning.md`; the two that must not erode are that every candidate
   comes from an exact-name `rawPrintings` search (so a different card is not a
   reachable answer) and that only a NON-regular treatment may re-pick (so a
   model shrugging "regular" cannot move a correct answer to another set).
   Its CALL SITE was gated on the wrong question until this round and is now
   gated on `!pinned`, i.e. on `linePinnedPrinting(refined)`, not on
   `!refined?.read.number`. "Was a number read?" and "did that number agree
   with the card returned?" are different questions, and the gap between them
   is exactly the `PRM 2` case above: the line reads, the exact lookup fails,
   the fuzzy fallback answers the base printing, and the old gate treated that
   as pinned — so the scan reported an unconfirmed edition and declined the
   one mechanism that could confirm it. After a tie-break swap `pinned` stays
   false, because the model chose that printing and the printed line did not.
   Two collaborators, both still missing: nothing on-device detects a
   borderless frame (`pickByTraits` has taken a `treatment` since v0.7 and had
   no producer until the cloud read became one), and `looksLikeCollectorLine`
   still recognises no modern MTG line at all — a fraction, a set-dash code or
   an 8-digit passcode only — so MTG sideways frames can never settle
   orientation from the line. Both are free wins for whoever picks this up.

## Scanner loop (hooks/useScanner.ts)

Auto-attempts fire on: still (motion < 7.5) held long enough + retry gap +
focus gate. Manual `scanNow()` (viewfinder tap / Try again) bypasses
miss-cache, backoff, AND the focus gate — it resets `blockedSince`.
`sealedRegion`/sealed mode skips refineCardCrop entirely; keep it that way.

Camera lifecycle: hiding the app suspends the WORK but keeps the session
when the platform muted the track (iOS frees the hardware itself); an
explicit stop parks the live stream ~25s on iOS Home-Screen apps
(`releaseCamera` in lib/camera.ts). Both exist because every skipped
`getUserMedia` there is a permission dialog the user doesn't see — don't
"simplify" them back to stop/reacquire.

## Sideways cards (orientation, `looksSideways` + `uprightOrientations`)

People photograph cards lying flat on a desk, so the card arrives QUARTER
TURNED — and every band and collector region below is written in upright
card coordinates, so a turned card misses all of them. Measured before any
handling: 5/46 on the `sideways`/`sideways-ccw` battery (and 0/23 one way)
versus ~70% upright. First cut (collector-line probe only): 12/46. Now:
**26/46, zero wrong-cards**, standard battery unchanged cell for cell.

The frame is turned upright before any card geometry applies. Two gates:

- **When to look** (`looksSideways`, vision.ts) — two measured arms, because
  the outline alone lies in both directions (riftbound/champion-split-1
  detects 0.95 upright and 0.71 sideways):
  - `lineRatio` (`refineCardCrop`): the row edge profile's spikiness over the
    column profile's, off the SAME profiles the region comes from. Text
    lines pack edge pixels into narrow bands across the axis they run
    perpendicular to. Measured over all 253 cells: upright min 1.16 / p50
    2.16, sideways max 1.95 / p50 0.95 — **< 0.85** (inside the empty
    [0.67, 1.16]) is sideways on layout alone.
  - detected aspect **> 0.85** (upright p50 0.72, sideways 0.97) still fires,
    but only while `lineRatio < 2.4` — the landscape-detecting upright frames
    sit at 3.01/4.42, every sideways frame ≤ 1.95.
  - Together: 46/46 sideways cells, **0/246 standard cells** (the aspect-only
    gate fired on 2). Upright scans pay nothing for any of this.
- **Which way is up** (`uprightOrientations`, identify.ts): unknowable from
  shape. The COLLECTOR LINE arbitrates when it can — `looksLikeCollectorLine`
  (fraction / set-dash code / passcode) on the bottom strip of each candidate
  turn, script-agnostic on purpose since a Japanese card offers no other
  Latin evidence and the choice happens before any name is read. As-captured
  is probed FIRST, so a mis-detected upright card is never turned.
  When neither strip parses — 30/46 cells, that line being the tiniest type
  on a card that is physically smaller in a sideways frame — the pass no
  longer gives up and reads the frame as captured (a guaranteed miss: every
  band is a quarter turn off). **Both turns are read through in full**,
  ordered by `latinWordCount` of the probe strip: the right way up shows
  rules/flavour text (measured 5–20 words), the same strip 180° out shows
  0–4, because Tesseract has no upside-down mode. Ordering is latency only —
  correctness never depends on it, since the loser is read next. The frame AS
  CAPTURED stays last in the list with the whole-card PSM-3 sweep alone
  (`sweepOnly`): that sweep reads quarter-turned type by itself (its layout
  analysis rotates vertical text lines — but one way round only, which is why
  `sideways-ccw` used to trail `sideways`), and it is what identified these
  frames before. Its collector regions are skipped: a quarter turn off, they
  would only spend magnified passes on the card's side edge.

**Guard:** a turned frame demands `TURNED_MATCH_THRESHOLD` (0.95) on NAME
matches, **applied to the whole printed name** rather than to `nameScore`.
Turning is an inferred orientation over fewer pixels, and Pokémon print the
evolution line under the name — that line is itself a real card name ("Iono's
Tadbulb" on an Iono's Bellibolt ex, 0.79) — while `nameScore` forgives a
missing epithet on purpose, which parks EVERY bare champion lead at exactly
0.95 (1 − its 0.05 penalty). That loophole is not hypothetical: a turned
"Ahri - Inquisitive" read as "Ahri" came back as "Ahri - Alluring" at 0.95.
Requiring the full name is strictly narrowing (similarity ≤ nameScore
always). Correct turned hits measure 1.00 (exact name), 0.96, or 0.70
(collector-line evidence, judged separately).

**Cost:** an unreadable sideways frame now pays two name ladders plus two
corner sweeps, bounded by the same shared budgets (2 watchdog kills / 18s of
OCR, 20s of lookups) — passes land in 1–7s, misses grind to ~20s. Nothing
upright pays it: the gate fires on 0/246 standard cells.

**Known limits, measured:** correct reads rejected by the turned bar —
"LightningBolt" (the space lost) at 0.929, "Two Years At the Sabaody
Archipelago" (the leading "In" lost) at 0.923; both would need an evidence
pairing, not a lower bar. Pokémon full-arts (umbreon-vmax-alt, pikachu-modern)
fail sideways because they fail upright too (0/9 and 4/9). Both ja fixtures
still correctly REFUSE.

## Language-independent identification (the corner-only path)

Names are read by an English-only Tesseract, so a non-Latin card can only be
identified by what stays Latin on every print worldwide — the collector
line. `readCornerInfo(..., thorough=true)` runs ONLY after every name pass
failed, and differs from the refine-path read in four ways: it re-reads even
when the speculative strip already covered the region, uses 5× upscale
(`readRegionText({upscale, maxWidth})` — `prepRegion`'s scale cap is a
parameter now, default 3), uses **sparse** page-segmentation (PSM 11; the
default single-block mode locks onto the rules box and DROPS the small
detached collector line), and merges partial reads across passes because the
parts sit in opposite polarities (white set-code badge beside dark digits).
Bounded by `SOLE_EVIDENCE_PASS_BUDGET` — every pass is paid on a miss while
the scanner runs, so this is a phone-battery constant, not a tuning knob.

Per-game sole evidence and its guards (all confidence 0.7, hinted mode only
— auto mode has no collector rescue by design):
- **MTG** `mtgBySetNumber` (exact set+number, NO fuzzy fallback). Needs the
  set code (only parses beside a language token: "NEO・JP") AND either the
  modern frame's zero-padding (`padded`) or a self-consistent fraction; a
  fraction read verifies against the set's real `printed_size` fail-closed.
  Collector numbers are DENSE — a one-digit misread lands on a real
  neighboring card, so every one of these guards is load-bearing.
- **Pokémon** `pokemonByCollector(..., setCode, fused)` → multi-language
  TCGdex sweep (`DEX_COLLECTOR_LANGS`). Printed code wins outright; without
  it the printed size must single out ONE set across ALL languages, judged
  over the complete candidate list (Japanese pairs same-size sets —
  sv4K/sv4M are both 66 — so this legitimately refuses). A `fused`
  (slash-reconstructed) fraction identifies ONLY with code+size+membership
  all agreeing. Rarity marks ("RR") and illustrator credits ("Illus." →
  "HUS") are excluded from set-code parsing; off the fraction line a code
  must carry a digit.
- **Yu-Gi-Oh** the 8-digit passcode (`parsePasscode`, `YGO_PASSCODE_REGION`)
  → `ygoById`. Same digits in every language and it IS the YGOPRODeck id;
  the id space is sparse so a misread resolves to nothing, not a wrong card.
- **Pokémon localized names** (DE/FR/ES/IT/PT) resolve through TCGdex
  language catalogs to the shared-id EN card. Language-routed dex ids are
  `dex-<lang>:<id>`; plain `dex-<id>` stays EN.

Known limit, measured: at fixture resolution (~670px card width) the
Japanese set-code badge and MTG's collector digits are NOT reliably
readable — both ja fixtures correctly REFUSE rather than guess. They are
kept as guard fixtures: if a future loosening turns either into a
`wrong-card` stage, that loosening is wrong.

## Foil, and the limit the chroma pair does NOT cover

The chroma projections assume **neutral text on a coloured/foil background**.
That covers a foil card's surface, coloured name plates and full-art
backgrounds, and it is why they paid off far beyond foil (+16 standard cells).

Real cards also do the INVERSE, and nothing here handles it yet: Yu-Gi-Oh
Ultra Rares print the card NAME in metallic gold foil and Secret Rares in
silver/rainbow holo, on a comparatively neutral beige name bar — coloured
text on neutral background. Arithmetic on the gold case (gold ~212,175,55 on
beige ~235,225,205) says `chroma-min` gives contrast 150 against luma's 46,
so gold may already be covered; no fixture is an Ultra Rare, so it is
UNTESTED, not proven. Silver/mirror foil is the case expected to genuinely
fail: near-neutral (R≈G≈B) means every intensity projection collapses, and
the real signal is specular variance rather than hue.

Leads, in order, for whoever picks this up: (a) add `chroma-sat` = (max−min),
the saturation channel, which separates in BOTH directions and may subsume
the pair; (b) for silver, a local-variance or gradient-magnitude projection
rather than an intensity one; (c) check whether YGO's mid-card set code and
8-digit passcode path already rescue these (hinted mode only). None of it is
measurable without a `foil-text` degradation that metallizes the name band's
GLYPHS — the current `foil` cells sheen the whole card.

## Sealed set matching (lib/sealedmatch.ts)

Three signals, best wins: whole-name containment 0.86+len bonus, per-line
fuzzy similarity, exact set-code token 0.8 (vs threshold 0.72 in sealed.ts).
Guard invariants: a code participates only with ≥3 chars AND a letter AND a
digit ("sv4k" yes; "MEW"/"151" collide with card names and plain numbers),
only as a whole OCR token, and always BELOW containment so a readable
English set name outranks any code. The code path is what identifies
Japanese Pokémon packs (own TCGplayer category, "Pokemon Japan", merged
into the group index by tcgcsv.ts `tcgplayerGroups`) — their fronts print
no Latin set name at all.
