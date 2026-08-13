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
   mangles.
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
8. **Candidates below `MIN_NAME_LETTERS` (3) are never looked up** (ocr.ts).
   `trimTrailingJunk` could shed everything but a two-letter head ("gr ee" →
   "gr"); the matrix spent 119 lookups on such fragments and not one ever
   identified a card, while each was a chance to hit a real name exactly in a
   big catalogue. Three, not four, because "Mew" and "Muk" are real.

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
