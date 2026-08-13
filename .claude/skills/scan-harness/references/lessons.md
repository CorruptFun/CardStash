# Lessons — war stories as transferable rules

Each of these cost real debugging time in the v0.6→0.7 overhaul. When a
result seems absurd, check this list before writing code.

## Fixture and stub artifacts that masqueraded as pipeline bugs

1. **Digital cards have no collector line.** TCGdex indexes Pokémon TCG
   Pocket (set ids `A1`, `B1`, …) alongside paper sets. The first Tauros
   fixtures were Pocket cards — corner reads could NEVER succeed, which
   looked exactly like a corner-OCR bug. Rule: when a stage fails 100% on
   one card, render the actual crop to a PNG and LOOK at it before touching
   code (`chromium` + canvas + `toDataURL`, save, view).
2. **Capture bias breaks the matcher's assumptions.** `dexMatch` pools the
   NEWEST briefs (tail); the fetcher originally hydrated the FIRST 80 —
   perfect reads of "Pikachu" returned matched:null purely from fixture
   coverage. Rule: a stub must honor the exact access pattern of the code
   under test, not just the data shape.
3. **The flaky primary changes the failure surface per capture round.**
   pokemontcg.io 500s on different queries each fixture refresh; one
   snapshot had Charizard rows (newest-first page WITHOUT plain Charizard →
   wrong-card), the next had none (→ tcgdex fallback → pass). Rules: matrix
   numbers are comparable only within one fixture snapshot — re-baseline
   after every refresh; and the app-side fix (rank by name fit + TCGdex
   cross-check when best < 0.98) came FROM this harness flakiness — the
   harness reproducing the API's real-world instability is a feature.
4. **A too-lax stub flatters the pipeline.** The ygo stub's `name=` matched
   norm-equality; the live API is exact — ~5 passes were fiction. A 3-card
   universe also made substring retrieval look smarter than it is (fixed
   with real fname pools). Rule: when a pass rate looks too good, audit the
   stub against live semantics before celebrating.

## Pipeline truths

5. **The match layer loses correct reads more often than OCR misreads
   them.** The single biggest baseline discovery: names were read VERBATIM
   ("Heisho, Shell of the World", "DARK MAGICIAN i)", bottom-banner One
   Piece names) and then lost to a 4-candidate positional cap, zero-fuzz
   retrieval, or an AND-of-junk-tokens query. Before investing in OCR
   quality, check the traces for name-bearing candidates that were never
   looked up or never matched.
6. **Tolerance without evidence creates wrong cards.** Loosening retrieval
   flipped honest misses into 16 confident wrong identifications in one run
   — the worst failure class (wrong prices, auto-collected in collect
   mode). Every tolerance must pair with a quality-scaled acceptance bar.
   Watch the wrong-card count in every run, not just the pass rate.
7. **The collector line is a first-class identifier.** When ornate faces
   (outline VMAX, gold script) defeat Tesseract entirely, number + printed
   set size still pins the card — but only with a printed slash read and
   independent catalog/API agreement. Tiny type drowns beside rules text at
   strip scale; narrow slivers at full magnification, binarized, is what
   made it readable ("© 156149").
8. **Both binarization polarities, always.** The mean-luma polarity
   heuristic fails exactly on the hard cards (glare-brightened dark art
   reads BETTER than clean — that inversion was the tell).
9. **Geometry compounds.** Region-crop, deskew, and card-relative mapping
   each look marginal alone; together they turned rot±5 and small-offset
   from near-total losses into mostly-passing rows. But over-eager cropping
   clips titles — hence the 0.66 area gate + map-don't-crop for near-full
   detections.
10. **Full-art/script faces are the honest ceiling.** ~Half of remaining
    Pokémon failures are Tesseract-level (outline/script type over art).
    Don't chase them with thresholds — that path leads to wrong cards. The
    corner path and (someday) a better OCR model are the levers.

## Low light (the v0.7.1 round)

16. **Don't pre-amplify — the pipeline already adapts locally.** A global
    gamma "lift" before the pipeline measured as a net LOSS: the per-tile
    contrast stretch is already a local exposure adaptation, and
    pre-amplification defeats its flat-tile noise guard (lifted noisy tiles
    stop inheriting stable global levels). Fix darkness where the specific
    stage breaks instead: the DETECTION buffer gets its own full-range
    stretch (its Sobel thresholds assume a lit frame), and OCR input gets
    speckle damping only when texture MEASURES as speckle.
17. **Tesseract dwells on amplified noise — minutes per pass.** Dark-cell
    traces showed 68–92s of OCR per attempt ("thinks forever" verbatim).
    Successful noisy reads finish in 4.5–5s; runaways run 20–60s — a 6.5s
    watchdog (terminate + respawn the worker; nothing else interrupts wasm)
    plus a 2-kill/18s attempt budget bounds the worst case. Calibrate the
    cap ABOVE the slowest successful read you can find in traces — the
    first 5s cap killed a winning 4.65s read.
18. **Temporal stacking is the only true dark recovery.** Per-pixel SNR < 2
    cannot be fixed after one frame is taken; averaging 3 frames (noise
    independent per frame → σ/√3) took dark cells from 4/21 to 17/21. The
    harness proves it with seed-varied composes (`--stack=3`), the phone
    does it with real frames (`captureFrameStacked`, dark scenes only,
    after the stillness gate). Camera-level adaptation (exposure boost,
    auto-torch with decline etiquette) prevents the dark frame existing at
    all — always prefer fixing the LIGHT to fixing the pixels.
19. **Marginal cells flap ±1–2 across runs.** Dark/noisy cells sit at
    threshold edges (a 4.65s read vs a 5s cap; a 0.66-score match). Never
    conclude from a single-run ±1 delta on the hard rows — the stable wins
    are the ones that repeat across three consecutive runs.

## Cross-game identification (the v0.10.2 round)

20. **A small stub universe hides DANGER as readily as it flatters.** Lesson 4
    is usually quoted the other way round, but the captured Yu-Gi-Oh universe
    is 131 rows against ~13k live, and that gap conceals a whole failure
    class: the matrix showed 13 cross-game matches where Yu-Gi-Oh answered a
    Pokémon card's junk fragment ("or", "gr", "EE", "cr"), all scoring
    0.05–0.19 and dying at the threshold. Live, `fname=` is a substring filter
    over the full catalogue, and a fragment that hits a name EXACTLY scores
    1.0. Rule: when the harness says a cross-game path is safe, check whether
    it is safe or merely under-populated — and prove the mechanism in a node
    test with a stubbed universe (`tests/unit/crossgame-sweep.test.mjs`)
    instead of waiting for the matrix to show something it structurally
    cannot.
21. **Ranking a substring pool by name fit is an ANTI-fix.** On a partial read
    every row in an `fname=` pool is wrong, and ranking by similarity picks
    the row likeliest to squeak past the bar — the shortest name containing
    the fragment. Ranking the pool turned 11 passing Dark Magician cells into
    "Ape Magician" (0.667, a thousandth over the 0.66 bar), where the unranked
    row scored 0.615, was rejected, and the NEXT candidate ("DARK MAGICIAN",
    1.00) identified the card. The threshold is the guard; anything that helps
    a fragment clear it is a regression wearing an improvement's clothes.
    Yu-Gi-Oh 81% → 50% in one run, caught only because the full matrix ran.
22. **Fix the wrong game, not the wrong score.** Every threshold lever that
    would stop a cross-game wrong card also costs real passes — the auto bar
    that would kill "Rage"→Yu-Gi-Oh also kills the genuine "AsH BLOSSOM &
    SPRING"→Ash Blossom at 0.72. Evidence separates them where a score cannot:
    the collector line says which game is physically in frame. Guard invariant
    1 cuts both ways — a NARROWING also needs its evidence, or it just moves
    the losses somewhere less visible.

## Foil (the round that started with "most collected cards are shiny")

23. **Luma is the wrong projection for text on colour, and foil is just the
    extreme case.** Every prep pass converted RGB to grey with Rec.601
    weights, which is right for ink on card stock and wrong the moment the
    background is SATURATED: a cyan sheen and mid-grey ink land on the same
    grey, so the contrast is gone before any stretch or Otsu threshold runs
    — nothing downstream can recover it. Card text is very nearly neutral
    (black or white) even on a foil, so throwing the colour away instead of
    averaging it in separates them: `chroma-max` = max(R,G,B) sends any
    saturated colour bright and leaves neutral dark ink dark; `chroma-min` =
    min(R,G,B) does the reverse for light ink. Complementary, exactly like
    the two binarization polarities. Expected a foil fix, got a general one:
    **+16 cells on the STANDARD battery** (71%→77%; Riftbound 83%→94%, YGO
    81%→94%, MTG 90%→96%) with zero new wrong cards, because card ART is
    saturated in general — coloured name plates, full-arts, YGO's frames.
    It also ran FASTER: a hit at this rung skips the whole-card PSM-3 sweep.
    Highest-yield single change since the v0.7.0 overhaul, and it sat in
    plain sight behind a one-line colour conversion nobody had questioned.
24. **Don't gate a fix on a detector built for another job.** The obvious
    trigger was `detectFoil`, which already exists — but it is tuned
    conservatively for PRICING ("false means unknown, not non-foil"), wants
    5+ hue families spread over the card, and fires on a rainbow ALT-ART
    scan while missing an actual sheen completely. Gated that way the new
    passes never ran on the cells that needed them and the measurement came
    back byte-identical to baseline, which reads exactly like "the idea
    doesn't work". Prove the mechanism with the gate forced OPEN first, then
    engineer the trigger — here the answer was that no trigger was needed.
25. **Calibrate a synthetic degradation against a real photo, or it will
    justify fixes for a failure that doesn't happen.** The first foil model
    was a full-card, full-saturation rainbow: it looked dramatic and was
    nothing like the reference phone photo, where the sheen is a narrow
    pearlescent band leaving most of the card readable. Render the
    degradation to a PNG and LOOK at it beside a real photo before measuring
    anything with it (lesson 1, applied to the test rig instead of the
    fixtures). Note the fixtures can never supply foil themselves: TCGplayer
    and TCGdex ship flat SCANS, which kill the diffraction a phone sees live.

## Foil on the GLYPHS (the round after)

26. **A metal is not a colour, it is a RANGE — and the range straddles the
    background.** Yu-Gi-Oh Ultra Rares print the card NAME in gold foil and
    Secret Rares in silver, on a comparatively neutral beige bar: coloured
    text on plain ground, the exact inverse of lesson 23. The obvious move is
    to reuse the chroma pair, and a worked example on a single gold value
    (212,175,55 on 235,225,205) says chroma-min should win by a mile —
    contrast 150 against luma's 46. It does not. Model the metal properly,
    with the shadow → base → highlight range a stroke actually sweeps as the
    card tilts, and that range CROSSES the bar's own level: within one glyph
    some strokes read darker than the bar and some lighter. Measured on the
    new battery, luma, chroma-min AND chroma-max all change sign across the
    range for both metals, and all three read as mush. A projection whose
    contrast changes sign inside the text cannot be rescued by any stretch or
    threshold downstream — that is the whole failure, and a flat-colour
    worked example cannot show it.
27. **Saturation is the projection that survives, because a metal's
    colourfulness barely moves while its brightness swings.** `chroma-sat` =
    max−min holds ONE polarity across the whole specular range for both
    metals — gold stays more colourful than the bar at every stop (78/149/69
    vs 52), silver stays less at every stop (10/8/3 vs 52). Silver is the case
    with no other answer: it is near-neutral by construction, so every
    intensity projection collapses onto the paper, and that same neutrality is
    exactly what makes it stand out in a saturation channel. The property that
    defeats the others is the signal. Measured: YGO 1/9 → 5/9 on the foil-text
    battery and 34/36 → **36/36** on the standard one, zero new wrong cards,
    +3% wall clock. It does NOT subsume the chroma pair, which was the
    hypothesis worth testing — gold's one win came from chroma-max, so all
    three ship.
28. **The polarity heuristic has to be re-derived per projection.** Every
    other variant decides "is the text light or dark" from the crop's
    brightness, because a dark plate carries light type. In a saturation
    channel a low mean means DESATURATED, which says nothing about the text,
    and the heuristic silently gets silver backwards. The right question there
    is only "is the text more colourful than its surround, or less", and the
    histogram's SKEW answers it without knowing which pixels are text: text is
    always the minority population, so it pulls the mean off the median in its
    own direction. Don't port a heuristic to a new channel because the code
    compiles.
29. **A perfect match to the wrong card is invisible to every threshold.**
    Drop "GX" off a read and what remains — "Tauros" — is a real card, matched
    EXACTLY, score 1.0. Every quality-scaled bar in the matcher exists to
    reject weak fits; this is a flawless fit to the wrong card, so no bar can
    see it, and lesson 6's instinct (tighten something) has nothing to bite
    on. Only other evidence can. The collector line is the designed arbiter
    and is also the smallest type on the card — on the cell that produced this
    wrong card it read nothing at all — but a suffix card declares itself a
    SECOND time in sentence-sized type, in the rules box ("Pokémon-GX rule",
    "When your Pokémon VMAX is Knocked Out"). That text was already being read
    in the same bottom strip and thrown away. Validate a parser like this
    against the traces you already have before touching the pipeline: over 162
    captured Pokémon cells it fired 60 times, every one correct, and stayed
    silent on all 24 cells of the only fixture whose card has no suffix. The
    silence is the half that matters — a false "ex" would manufacture exactly
    the wrong-card class the guard removes.
30. **A synthetic degradation is a model, and the fixtures can never supply
    the real thing.** TCGplayer and TCGdex both ship flat SCANS, so no fixture
    is or can be a foil. `foil-text` metallizes the name band's glyphs by
    finding strokes darker than their local surround and re-inking them
    through a specular field — a faithful-LOOKING model built by the same
    person who then measures against it. Real photographs bypass `compose()`
    entirely (they already contain the lens, sensor and shake it simulates)
    and live in `tests/harness/photos/`, committed, NOT on `harness-fixtures`
    — CI force-pushes that branch and a photograph cannot be regenerated.
    Where a photo disagrees with the model, the photo wins.

## Process truths

11. **Verify findings against the working tree, not HEAD.** In the review
    fan-out, half the confirmed-sounding findings were already fixed in
    uncommitted edits; verifier agents defaulting to REFUTE caught this.
    Always have a second agent try to refute a finding (quoting the actual
    current code) before acting.
12. **`git --work-tree=… checkout` stages into the SOURCE index.** Pulling
    the fixtures branch that way silently staged 60 fixture files. Use
    `git archive <ref> | tar -x -C <dir>`.
13. **Vite HMR kills live harness runs.** Editing anything in the harness
    page's import graph (`src/lib/**`) mid-run full-reloads the page and
    wipes `window.__harness`. Sequence edits around runs.
14. **Sandbox network here is GitHub-only.** Card CDNs/APIs are
    policy-blocked; CI runners have open egress — hence fetch-in-CI +
    data-branch. npm/registry traffic bypasses the proxy. Probe with curl
    before assuming.
15. **A verification pass takes ~5 minutes; `main` can move in that time.**
    Another session shipped 0.8.0→0.10.0 (and refactored the version into
    `src/lib/version.ts`) while the low-light matrix runs were going. Always
    `git fetch origin main` before merging, expect version files to be the
    conflict, take the NEWER structure rather than reasserting yours, and
    re-run the full gate on the merged tree — the merge is a new tree, and
    the rule is about trees, not diffs. (Their work touched no pipeline
    file, which the diff confirmed in seconds; check that before assuming a
    re-baseline is needed.)
16. **Real failure messages are the user's diagnostic.** "Read “X” but
    couldn't match it" = match layer (trace shows scores); "Couldn't read
    the card name" = OCR + corner both empty. Keep messages honest about
    which stage gave up — the eye-icon trace panel depends on it.
