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

## Where Pokémon actually stands (measured, for whoever picks it up next)

31. **Pokémon's remaining failures are three different problems wearing one
    number.** 42/81, or 42/72 excluding the `ja-collector` guard fixture. Over
    two runs, of 60 non-guard failures the species name IS readable somewhere
    in the band text in 40 of them — so this is not mostly an OCR-can't-see-it
    problem, and the tempting single fix is to mine the species out and pair
    it with the rules-box variant guard. Measured per fixture, that tempting
    fix is three different situations:
    - `umbreon-vmax-alt` (24 fails): species readable 24/24, VMAX declared
      18/24. A species rescue would fire on ~75% of them and be correct, since
      VMAX and VSTAR always evolve from the SAME species' V — "Evolves from
      Umbreon V" on an Umbreon VMAX. Sound, and evidenced by exactly ONE
      fixture, which is why it is written down here instead of shipped.
    - `pikachu-modern` (16 fails): species readable only 8/24, and the rules
      box reads as **"Pokémon €X rule"** — Tesseract corrupting é and e — so
      `parsePokemonVariant` correctly declares nothing. Its collector line
      reads "247/797" where the card is 247/191: the NUMBER is right and the
      total is mangled, which the both-halves-must-agree guard rightly
      refuses. Loosening either the parser or that guard to catch this is the
      lesson-6 trap wearing new clothes.
    - `iono-modern` (14 fails): the possessive prefix is what's lost —
      "Iono's Bellibolt ex" reads as "ABEllibolt EX", "insaBelliBolt". The
      species IS readable, and using it would be **actively unsafe**: bare
      "Bellibolt" is a real card and so is "Bellibolt ex", so a species rescue
      here manufactures a confident wrong card. Same trap generally: a Stage-1
      ex evolves from a DIFFERENT species, and that species often has its own
      ex printing (a Raichu ex evolving from Pikachu would resolve to
      "Pikachu ex"). Any species rescue must be restricted to VMAX/VSTAR,
      where the pre-evolution shares the species by rule.
    The blocker is evidence, not ideas: one VMAX fixture cannot tell a real
    mechanism from an overfit. Add more suffix-variant Pokémon picks to
    `fetch-fixtures.mjs`, let CI regenerate, re-baseline (lesson 3), and the
    VMAX/VSTAR rescue becomes measurable.

## What the first real photographs said (and they said something new)

32. **The synthetic backdrop was hiding the dominant real-world failure.**
    Eight real phone photos, graded: 1/8. That number is mostly a fixture
    artifact — seven of the eight cards are not in the captured API universe,
    so the stubs cannot return them however well they read (the `Duel Tower`
    cell read "DUEL TOWER" **perfectly** and still failed). Check that BEFORE
    concluding anything from a photo run. What the photos do show, once you
    read the traces instead of the score, is a failure class the matrix
    structurally cannot produce: **card-region detection over-reaching on
    cluttered backgrounds.** `compose()` always lays the card on a plain
    vignetted backdrop, so detection is trivially right in every one of the
    246 synthetic cells. A real photo has a Yu-Gi-Oh box, a wood table, other
    cards and high-contrast packaging text, all of which throw Sobel edges.
    Measured, the correlation is clean: the cells whose detection came back
    TIGHT (area 0.42, 0.65) read their foil names; the ones where detection
    swallowed 0.71–0.74 of the frame read nothing at all — and at that size it
    is over the 0.66 area gate, so the crop is not even applied and every band
    then sits on background rather than on the card. Fixing detection is worth
    more on real photos than any further OCR work, and it is the same
    primitive multi-card/binder scanning needs.
33. **chroma-sat held up on real foil, which is the point of having photos.**
    On the two flat, well-lit secret rares it is decisively the best
    projection — "CO ENIGMASTER FPAURDBIHT" where every level projection gives
    noise, and on I:P Masquerena it is the ONLY variant that read anything at
    all ("[:P ag] EREN"). The synthetic `foil-text` model pointed at the right
    mechanism even though it got the gold/silver ORDERING wrong (lesson 26).
    A model can be wrong in its details and still be right about the physics;
    what it cannot do is tell you which failure dominates in the field.

## Multi-card detection (binder pages)

34. **"Where is THE card" and "where are the cards" are different algorithms.**
    `refineCardCrop`'s 1D projection profiles cannot represent two cards, and
    on clutter they over-reach (lesson 32). `detectCardRegions` sweeps
    card-aspect rectangles with integral images, and the scoring rule is the
    whole idea: a candidate scores the **minimum** of its four borders, not the
    sum. A card is a CLOSED rectangle, and requiring all four sides is what
    separates one from the strong-but-open edge clusters a real scene is full
    of. Summing lets three good sides carry a fourth that isn't there — the
    same failure the projection profiles have.
35. **A card is never inside another card, and that one fact does the most
    work.** Scored on its own merits a card's ARTWORK PANEL is also a bordered,
    card-shaped rectangle and often beats the card containing it: the first
    pass returned art panels for eight of nine binder slots. Suppressing
    largest-first and dropping anything an already-taken box swallows fixed it
    outright. IoU alone cannot — a small box inside a big one has low IoU, so
    plain NMS keeps both.
36. **Order the phases so one geometry is compared at a time.** Refining boxes
    as they were selected meant the clash test compared UNREFINED candidates
    against REFINED keepers; the inconsistency over-suppressed and took a
    binder page from six cards to three. Select coarse → refine all → select
    again. The refinement itself is worth having: a short hill-climb on the
    same integral images lifted scores from ~1.45 to 1.94 and is what makes the
    grid step possible at all.
37. **The grid is evidence, and it can outvote a box's own score.** A rectangle
    straddling the gap between two rows still has four strong borders — the
    sleeve edge above, the card sides running through both — so min-of-four
    cannot tell a card from half of two stacked ones, and such a box scored
    1.72, above several correct ones. Nothing local fixes that. What does is
    consensus: the majority of boxes sit on the true lattice, so snapping
    outliers to it corrects exactly the wrong ones and leaves the right ones
    alone. Same shape as every other guard here — a prediction from the grid
    still has to MEASURE something before it is accepted, or an empty pocket
    becomes a card.
38. **Look at the boxes, every time.** A detector graded by a count is the
    easiest thing in this repo to fool: six boxes on a nine-card page looked
    like progress and was eight art panels. `preview.mjs --detect` draws them.

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

## Multi-card detection, round two (wiring it up)

39. **A card the frame cut off was a SEARCH-SPACE problem, not a scoring one.**
    The top row of the binder page went missing and the obvious reading is
    "those cards have no top border to score" — which is true, and led to a
    border-exemption rule that changed nothing at all. The sweep loop runs
    `for (x = 0; x + w <= sw; ...)`: a rectangle that starts above the frame or
    ends past it is never PROPOSED, so no scoring rule, however generous, ever
    gets a say. Letting the sweep run past the edges by `OVERHANG_MAX` took the
    top row from 1/3 to 3/3. Rule: before tuning what a detector scores, check
    that it can express the answer at all.
40. **Once boxes may hang off the frame, "largest-first" has to mean largest
    VISIBLE.** Suppression takes the biggest box first and drops whatever it
    contains (lesson 35), and that first pick is decisive. Ranking by raw area
    let boxes overhanging the bottom edge win it on pixels that are not in the
    picture, and they swallowed two correctly-found cards — the page read 3/3
    on the top row and lost the bottom, staying at 7. Ranking by the area
    actually inside the frame: **8/8, 7 of them on identifiable cards** (from
    6). A geometric change to what a detector may propose is also a change to
    every comparison downstream that assumed the old constraint.
41. **`detectCardRegions` does NOT fix single-card detection on cluttered
    backgrounds — measured, against the hypothesis.** Lesson 32 concluded that
    `refineCardCrop` over-reaches on real photos and that the 2D detector would
    likely fix it. It does not. On `pkm-machamp-revholo` the detector returns 3
    boxes and **none of them is the card**, on `pkm-blastoise-ex-fullart` 7 with
    the same result. The reason is lesson 23 wearing different clothes: a card
    held in a HAND has a yellow border against skin, which is a strong colour
    edge and a weak luma one, and the sweep runs on `grayscale()`. So the
    single-card substitution was NOT shipped, and the gap stands open with a
    named cause. The lead for whoever takes it: run the detector's gradient on
    a chroma projection (min/max/sat of RGB) rather than luma — the same fix
    that paid off for OCR, in the place it was never applied.
42. **A "correctness fix" to a formula can be load-bearing as a heuristic.**
    `mean()` divides by the REQUESTED rectangle area while `sum()` clamps to
    the frame, so a partly-offscreen strip is scaled down by however much of it
    hangs over the edge. That reads as an obvious bug. Fixing it measured the
    binder page down from 7 cards to 4: the dilution is the only thing
    penalising rectangles that wander off the picture, and without it a box
    drawn around the whole BINDER scored well enough to swallow the cards
    inside it. Reverted, with the reason written where the next person will
    read it — a card is never inside another card, but a binder is not a card.
43. **A page needs more pixels than a card does.** `CAPTURE_MAX_EDGE` (1600) is
    calibrated for one card filling the frame; a 3x3 page cut out of 1600px
    leaves each crop ~500px wide, under the ~790px where the printed collector
    fraction stops being legible. So the multi-card path decodes at
    `PAGE_MAX_EDGE` (3200) and each crop lands at single-card scale. The
    committed binder PHOTO is itself only 1200x1600 (the photos README says to
    downscale to 1600, which is right for a single card and wrong for a page):
    its cards arrive ~370px wide, so its identification numbers are a floor set
    by the fixture, not by the pipeline. Shoot pages at full resolution.
44. **`ignoreMisses` does not mean "ignore the cache".** It gates only the
    cached-MISS branch; the cached-HIT branch returns before any OCR runs, at
    `confidence: 1, via:'cache'`. The multi-card path inherited that, and the
    consequence was invisible until someone asked what the review screen's
    per-row Retry actually does: it re-decodes the SAME kept JPEG, whose
    perceptual hash is 0-5 bits from the page scan's (measured on the real
    binder photo — `keepAsJpeg` doesn't even resample below CAPTURE_MAX_EDGE),
    so the "re-read at full budget" returned the identical card at cache
    confidence. Worse, the review recomputes its pre-tick from that confidence,
    so a row flagged at 0.80 was promoted to ticked-and-unflagged on no new
    evidence — laundering, in exactly the [0.75, 0.90) band where the flag
    exists. The matrix structurally cannot catch this: `page.html` calls
    `clearScanCache()` between cells. Multi-card scanning now opts out of both
    halves (`cache: false`), and the WRITE half matters too — a page was
    pushing 12 entries into the 60-entry cache the live scanner shares.
45. **Check whether a hash can actually collide before believing a bleed
    story.** The companion claim — that two slots of one binder page would hash
    within `HASH_TOLERANCE` and inherit each other's printing and foil flag —
    sounded worse and was FALSE. Measured over all 36 slot pairs of the
    committed page (which really does hold 3 copies of one card): minimum
    Hamming distance **35** of 128, median 60, against a tolerance of 10. Even
    the same slot re-cropped 2% off measures 26-30. `frameHash` collides only
    on a near pixel-identical image, which is the round trip in 44 and nothing
    else. Two adjacent findings, same subsystem, same reviewer: one real, one
    not — measure, don't rank by how alarming it sounds.
46. **A mode that changes what the shutter means must also stop the automatic
    one.** Page mode left the single-card auto-attempt loop running while the
    user lined up a binder page, and with Collect mode on — a PERSISTED setting
    — every one of those hits filed a card with no review: the exact silent add
    the review screen exists to prevent, arriving through the side door. The
    scanner hook knows nothing about page mode by design, so the parking has to
    be done from the view, and the effect that does it must depend on
    `scanner.status`: `start()` and `resumeScanning()` restart the rAF loop
    without the mode changing, and nothing else re-parks it.

## What real video said (the clips round)

47. **The live path produces WRONG CARDS, and no still-image battery can show
    it.** The standard matrix reports zero wrong cards across 282 cells. Two
    ordinary handheld clips produced **10 in 40 identifications**: frames of a
    Krookodile ex that read "Krookodile" match a real, different, far cheaper
    card EXACTLY at score 1.0 (lesson 29's class, with `parsePokemonVariant`
    silent because the rules box never read), and Azure-Eyes Silver Dragon
    answered "Agave Dragon" off a partial "DRAGON". `compose()` structurally
    cannot produce the input that causes this — a frame where a MOVING
    highlight leaves the name half-legible in one specific way. Rule: a battery
    of stills cannot bound the wrong-card rate of a live scanner, and the
    wrong-card rate is the number that matters most.
48. **Consecutive frames disagree, so which frame the scanner grabs decides
    whether the user gets their card.** In one burst of the Krookodile clip,
    frames 0 and 1 read "Krookodile ex" and identify correctly and frame 2 —
    33ms later — reads "Krookodile" and answers the wrong card. The scanner
    commits to a single frame with no corroboration. The obvious lever is
    frame SELECTION, and the obvious guard is agreement across two attempts
    before committing, which matters most in collect mode where a hit is filed
    with no confirmation.
49. **Stacking is for noise, not for glare — measured, against the
    hypothesis.** The natural extension of `captureFrameStacked` (dark scenes,
    3 frames, measured 4/21 → 17/21 there) is to run it always. On real
    clips it is WORSE than picking the best frame in the same burst: 3/10
    against 4/10 bursts that contained a readable frame. The mechanism says
    why — averaging divides INDEPENDENT noise by root N, and a specular
    highlight moving across the card is not independent noise, so averaging
    smears it across the glyphs instead of cancelling it. Keep stacking gated
    on darkness.
50. **A clip needs both shapes of sample, or it answers only half the
    question.** `ingest-clip.mjs` stores bursts of consecutive frames spread
    across the clip: across bursts answers "does any frame identify" (frame
    selection), within a burst answers "does averaging beat the best of them"
    (stacking). Frames 5 seconds apart cannot answer the second; three frames
    33ms apart cannot answer the first.
51. **Tooling reality: nothing in the sandbox decodes an iPhone clip.**
    Playwright's ffmpeg is built `--disable-everything` (no QuickTime demuxer)
    and its Chromium reports `canPlayType` empty for H.264 — a `<video>` never
    loads. `npm i --no-save ffmpeg-static` works (registry traffic bypasses the
    proxy, lesson 14). So frames are extracted once at ingest and committed;
    the clip itself is not stored, since the harness could not read it anyway.
52. **The multi-card detector cannot see a quarter-turned card, at all.** Four
    of the real binder pages were shot with the binder rotated relative to the
    cards, which is an ordinary way to photograph one. `detectCardRegions`
    sweeps aspects `ASPECT_MIN..ASPECT_MAX` = 0.587..0.859, derived from
    `CARD_ASPECT = 63/88` — portrait only. A sideways card's bounding box is
    landscape, w/h ≈ 1.40, outside the band, so the rectangle is never
    proposed. Measured on the 3x3 page: 5 boxes found, **none of them on a
    single card** — one box swallowed six cards, another covered two. This is
    lesson 39 again in a different axis (a search-space limit wearing a
    scoring-problem's clothes), and the fix is the reciprocal band, not a
    threshold. Note the single-card path already handles turned cards
    (`looksSideways` / `uprightOrientations`), so each CROP would identify
    once the boxes are right — the gap is entirely in the detector.
53. **Ingest resolution is a silent ceiling, and it applied to the first page
    for a whole round.** `ingest.mjs` capped every photograph at
    CAPTURE_MAX_EDGE (1600), which is right for one card and wrong for a page:
    the first binder page's cards reached the pipeline ~370px wide, under the
    ~790px where a printed collector line stops being legible, so its 6/8 was
    partly a property of the ingest tool. Pages now ingest at PAGE_MAX_EDGE
    (3200). Rule: when a tool normalises an input, check that its constant
    matches the consumer that will actually read it.
