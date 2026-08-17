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
54. **Two obvious fixes for the sideways page, both measured, both rejected —
    and the measurement is the deliverable.** The gap in lesson 52 has two
    natural fixes and neither survives contact:
    - *Decide the orientation, then rotate the frame.* Nothing available
      decides it. Total border score is not a discriminator: on a KNOWN-UPRIGHT
      page the turned frame scored HIGHER (14.09 vs 11.61), because a grid of
      cards has strong structure whichever way you look at it — and a
      score-margin rule misfired `turns=1` on upright SINGLE cards, which would
      have broken ordinary uploads. `lineRatio` is measured and reliable for
      one card (46/46 sideways, 0/246 upright) and does NOT generalise to a
      page: 0.45 on a genuinely sideways page, but 1.23 and 1.47 on two others
      just as turned, because the binder's own rows outvote the card text.
    - *Propose both aspect bands and let the existing arbitration sort it out.*
      It cannot. Containment suppression (lesson 35) and the size cluster both
      assume ONE card shape; landscape boxes spanning two adjacent cards are
      larger, get taken first, and swallow the correct ones. The known-good
      page fell **8/8 → 4/8** while the sideways page did not improve at all,
      and detection cost doubled.
    Rule, again: a detector's arbitration rules encode assumptions as strong as
    its scoring, and widening what it proposes can violate them. The lead that
    remains is a structural decision made ONCE per page — the right way up puts
    boxes on a regular lattice and the wrong way scatters them, and
    `completeGrid` already infers that lattice — rather than a per-rectangle
    shape guess. Ship nothing until it beats 8/8 on the upright page.

## Where the rescue had to fire (the suspect-answer round)

55. **A rescue wired to the MISS path cannot fix the WRONG-CARD class, and the
    two look identical on a summary line.** The cloud read was added at the
    bottom of `identifyViaOcr`, after every local pass gives up — the obvious
    place, and the place where it can never meet the failure it was bought for.
    A confident wrong card is not a miss: the local matcher returns "Krookodile"
    at score 1.0 and returns it happily (lessons 29, 47), so the rescue is never
    consulted, and every stable wrong card survives switching it on. The tell
    was that turning the feature on moved the wrong-card count by zero while the
    edge function, handed the same frames directly, read them correctly. When a
    fix measures as no-change, ask whether it RAN at all before concluding it
    does not work — the same trap as lesson 24, one layer up.
56. **The trigger for a second opinion is a property of the ANSWER, not of the
    read quality.** There is no score to threshold here — that is the whole
    point of the class — so the question has to become structural: is this the
    SHAPE of answer that is wrong when it is wrong? For Pokémon it is exactly
    "a bare species that has a suffixed sibling in the catalog", which is
    cheap to ask (one prefix-tolerant lookup, since the siblings come back in
    the species' own page) and is false for most cards, so it does not turn a
    rescue into a default. Pair it with the arming check FIRST and sync: a user
    who never opted in must not pay even the sibling lookup, which also makes
    the change provably free — the standard battery has to come back identical,
    cell for cell, and that identity is the regression test.
57. **Judge a cloud read with `similarity`, never `nameScore`.** `nameScore`
    forgives a missing suffix by design and parks a bare species at ~0.95
    (guard invariant 8), which is correct for a half-read name plate and
    catastrophic for a transcription that CLAIMS to be exact: it turned a
    perfectly-read "Pikachu" into "Pikachu ex" five times on one clip. A cloud
    answer is not a degraded read to be forgiven, so there is nothing to
    forgive, and the forgiveness is precisely what manufactures the wrong card.
    Same reasoning as `TURNED_MATCH_THRESHOLD`, arrived at independently — when
    a match is the ONLY evidence, judge the whole printed name.

## The OCR worker's afterlife (the null-postMessage round)

58. **A terminated Tesseract worker is not inert — it is a trap, and the
    trap is silent.** `worker.terminate()` nulls the port behind the handle,
    and tesseract.js keeps no liveness flag. Every later call posts to that
    null port, and the library **drops the promise its internal `send()`
    returns** — so the `TypeError: Cannot read properties of null (reading
    'postMessage')` escapes as an *unhandled rejection*, while the call's own
    promise **never settles at all**. That second half is the vicious one:
    `await worker.setParameters(...).catch(() => {})` looks defended and
    hangs forever, because the `.catch()` is attached to a promise nothing
    will ever reject. The restore-in-`finally` after a watchdog kill was
    exactly that shape, and its comment claimed the catch covered it.
59. **We are the only ones who terminate these workers, so every one of
    those calls was ours to prevent.** `ocr.ts` now routes all of it: a
    `terminated` WeakSet, `killWorker()` (terminate at most once, remember
    it), `isLive()`, and `setPageMode()` for the PSM switches. Nothing calls
    into a worker we killed. If you add a worker call, add it through those.
60. **The race window was inside tesseract, not our code: it awaits the
    image encode BEFORE it posts.** `loadImage()` on an HTMLCanvasElement
    does `toBlob()` + `FileReader` — genuinely async, milliseconds — so a
    terminate landing in that gap posts to null even though the worker was
    alive when we called. Liveness checks cannot close it; `recognizeBounded`
    encodes the PNG itself (the same bytes tesseract's own path produces) and
    then checks, leaving no await between the check and the post.
61. **The bug was only ever visible as a flake in `drive-scan-ui.mjs`.** The
    matrix never sees it: it drives `identifyFrame` directly and nothing
    calls `stopOcr()` mid-read. It takes the UI harness — a sheet opening, a
    Page-mode toggle, `suspendWork()` firing while OCR is in flight — and it
    reproduced roughly one run in two. When a browser harness fails its
    "no uncaught page errors" check with a stack that is entirely inside a
    dependency, look for OUR lifecycle call that put the dependency there;
    the stack cannot name it, because the async boundary ate our frames.

## The printing was never being graded (the wrong-edition round)

62. **A grader only finds what it asks about.** The matrix passed a cell when
    the NAME matched at ≥0.9 and the game was right — so "Dragon Spirit of
    White" filed as MP17-EN010 while the card in the hand was LCKC-EN018
    scored a clean pass, at a $0.12 reprint's price for a Secret Rare. Yu-Gi-Oh
    sat at a flawless 36/36 the whole time. The metric now sits BESIDE the
    pass rate (`printing: N/M`), never folded into it: the gate is a name gate
    and every stored baseline was measured against it, so quietly tightening it
    would move every number at once and destroy the before/after comparison the
    harness exists for.
63. **The first thing the new metric measured was the fixtures, not the code.**
    Yu-Gi-Oh scored 36/36 on printings too — vacuously. YGOPRODeck serves
    rendered replicas stamped "Replica - Not For Use in Sanctioned
    Tournaments" with **no set code and no passcode printed anywhere on them**,
    and the fetcher's ground-truth `number` is the API's first printing, which
    is exactly what the pipeline falls back to. Both sides agreed because
    neither had read anything. `REPLICA_ART_GAMES` excludes them; only real
    photographs can grade Yu-Gi-Oh printings. (MTG and Pokémon fixtures ARE
    real card scans with printed lines — they grade honestly, at 23/46 and
    32/54.)
64. **The Yu-Gi-Oh code window was pointed at the artwork.** `CORNER_REGION`
    said y 0.50-0.63, which on the modern frame is inside the art box; probed
    against the photographs it returned foil sparkle on every variant while
    "PHNI-EN042" sat one band lower and read (garbled but present) at
    y 0.60-0.68. Two full-magnification OCR passes per scan were being spent on
    pixels that could not contain the answer. Probe rects against a real photo
    before trusting any region constant — the probe is twenty lines against
    `readRegionText` and it answers in seconds what a matrix run cannot.
65. **Adding regions is not free, and the budget is shared with the pass that
    actually identifies the card.** Two extra Yu-Gi-Oh code-band rects turned
    the Enigmaster Packbit photo from a pass into an `ocr-misread`: the pass
    budget ran out before the wide bottom band, and the dedicated 7%-tall
    passcode strip returns "" on that exact card (lesson 30's card, again).
    A better printing is never worth a lost card. Relocating a window costs
    nothing; adding one costs a card.
66. **Guessing is allowed; claiming is not.** When the code doesn't read, the
    edition shown is the source's default — unavoidable. What was wrong was
    presenting it identically to a read one. `IdentificationMeta.pinned` now
    records which happened, rides the frame cache, and reaches the sheet, which
    marks the edition unread and puts the picker one tap away. The harness
    reports the same split: `N wrong while claiming the code was read` is the
    only class the user cannot catch, and it is 0 on the photos.

## Right card, wrong version (the edition round)

67. **A grader that asks only for the NAME cannot see the failure a user
    reports as "wrong version," and the matrix had been scoring it as a pass
    for its whole life.** `graded()` compares game + name similarity, on
    purpose — a wrong card is the worst class and every threshold is tuned
    against it. But the fixture manifest carries `setCode` and `number` and
    nothing ever read them. Twenty minutes of grading code turned an
    unfalsifiable user report into a number: **16 of 43** identified Pokémon
    cells landed on the wrong edition, including a Base Set Charizard reported
    as a Celebrations TG03 — a four-figure card priced as a three-dollar one,
    with a green tick beside it. Before theorising about a report you cannot
    reproduce, check whether the harness is even ASKING the question the report
    is about; the cheapest bug to find is the one your grader was ignoring.
68. **Every corner region is mapped through the DETECTED card region, so a crop
    whose floor lands inside the card moves the collector line out of all of
    them at once.** `charizard-base` clean: crop bottom at 0.928 of the frame,
    "4/102" printed at ~0.96. Nine successive OCR passes — three cheap, then
    four magnified 5× — every one of them read the flavour text, because the
    rectangles were computed from a card that the detector said ended above the
    line. More magnification on the wrong rectangle is worth exactly nothing,
    and a trace full of confident-looking crops at plausible coordinates hides
    it well. When every pass returns the same wrong text, stop tuning the
    passes and check what the coordinates are relative TO.
69. **The raw-frame fallback existed, was left-handed, and had never once
    run.** `readCornerInfo`'s thorough tier already carried the escape hatch
    for lesson 68 — a band of the raw frame rather than of the card region —
    and it was broken two ways at the same time. It sat at `{x: 0, w: 0.55}`,
    the modern bottom-left position, so it could not see the vintage
    bottom-RIGHT line that is exactly the case it was written for. And it drew
    on the SHARED pass budget after the region loops, which spend two variants
    over four regions — eight passes against a budget of five — so it was
    unreachable in every run that needed it. Both bugs are invisible in the
    summary and obvious in a trace: count the `ocr-region` events and check
    that the passes you think you added are among them. A last-resort pass
    reached only when it isn't needed is not a last resort; give it its own
    budget (`RAW_BAND_PASSES`), which costs nothing because every pass
    short-circuits on a finished read.
70. **Pokémon's edition is decided by the collector line, not refined by it.**
    For most games the name narrows the printing and the line confirms it; a
    Pokémon species name answers to twenty years of reprints priced decades
    apart, so a missed line means the edition is whatever the catalog listed
    first — and pokemontcg.io being stale means "first" is often a card the
    user has never seen. That asymmetry is why `PRINTING_RIDES_ON_THE_LINE`
    gets a deep refine tier that other games do not, and why it is hinted-only
    (lesson: the cost asymmetry — the same retry in the auto fan-out taxes
    every other game's shared wait).
71. **The two halves of a Pokémon fraction fail INDEPENDENTLY, so the guard
    goes on the set size and not on the number.** Pokémon was the one game
    accepting whatever `matchPokemon` returned — MTG matches `collectorEq`,
    Yu-Gi-Oh the passcode — so the obvious fix was to copy their check. It cost
    a cell immediately: `rayquaza-vmax` reads "70/203", a mangled number beside
    a clean total, and the total alone correctly pins Evolving Skies #218. A
    `collectorEq` veto threw that away and fell back to a Celebrations promo —
    a guard that manufactures the exact failure it was added to prevent. The
    check that IS right is on the printed set size, and it belongs in
    `matchPokemon`, where the candidate sets are still in hand: a read total
    that no catalog can honour returns null rather than a printing at another
    printing's price. Copying a sibling implementation's guard is not the same
    as copying its reasoning — MTG's collector numbers are dense and
    self-checking, a Pokémon fraction's halves are two separate reads.
72. **A fix that measures as no-change may still be two bugs deep.** The first
    edition round moved the aggregate by zero, and the temptation was to
    conclude the deep tier does not help. The per-cell diff said one cell moved
    (the wrong way, lesson 71) and the trace said the new passes had run but
    the ones that mattered had not (lesson 69). Diff the CELLS, not the
    summary: 43/90 to 43/90 hid one regression and one silently skipped code
    path, and either alone would have been read as noise.
73. **Grade the printing on the NUMBER alone; adding a `setCode` equality check
    manufactures failures out of catalog aliases.** The grader compares printed
    numbers and it is tempting to tighten it by demanding the set codes agree
    too. Measured over the 118 cells currently graded `printing: 'ok'`, exactly
    2 disagree on set code and BOTH are aliases rather than errors:
    `pokemon/rayquaza-vmax` truth `SWSH7` against answer `EVS` (both Evolving
    Skies) and `pokemon/pikachu-modern` truth `SV08` against answer `SSP` (both
    Surging Sparks). Zero true positives, two false positives — lesson 71's
    trap in a new place, a veto that produces the exact failure it was added to
    catch. The asymmetry is structural, not a data-entry slip: the fixture
    manifest's `setCode` comes from the catalog that FETCHED the image, the
    outcome's from whichever catalog ANSWERED the scan, and TCGdex and
    pokemontcg.io do not share a set vocabulary. Two names for one set is
    normal; two numbers for one printing is not.
74. **The collector-line READ RATE decides the printing; the selection logic is
    downstream of it.** Per-cell over the four fixtures that lose printings the
    correlation is essentially perfect — a line that yields a number gives the
    right printing, a line that yields nothing gives the wrong one.
    `charizard-base` reads `4/102` on 3 of 12 cells and is right on exactly
    those 3, answering Celebrations `SWSH11.5TG TG03` on the other 9;
    `rayquaza-vmax` reads `70/203` on 1 of 12 and is right on exactly that one;
    `riftbound/short-name-1` reads nothing on all 8 and is wrong on all 8. The
    rule that generalises: **a printing resolver has nothing to rank when
    `number` and `total` are both null**, and 39 of the 51 wrong-printing cells
    are in that state. Before designing scoring for a candidate list, check how
    often there is any evidence to score it with — otherwise the clever part
    runs on a quarter of the cases and the other three quarters keep answering
    whatever the catalog listed first (lesson 70). The one fixture that breaks
    the correlation names the second mechanism rather than refuting the first:
    `mtg/borderless-any` reads `PRM 2` on 5 of 12 and is still wrong on all 12,
    because `matchMtg`'s fuzzy fallback answers a failed exact lookup with the
    base printing.
75. **A guard whose gate asks a different question from the flag it sets fires
    on the wrong cells, and both halves look correct in isolation.** The
    printing tie-break was called under `!refined?.read.number` — "was a number
    read?" — while the meta it exists to repair is `pinned =
    linePinnedPrinting(refined)`, "did that number agree with the card
    returned?". A line that reads and then resolves to nothing sits in the gap,
    which is precisely the case `linePinnedPrinting`'s own docstring names: on
    `borderless-any` the line reads `PRM 2` on 5 of 12 cells, the exact lookup
    fails, `matchMtg`'s fuzzy fallback returns the base printing, and the old
    gate counted that as pinned. The scan therefore told the user its edition
    was unconfirmed and simultaneously refused the one mechanism that could
    confirm it. It now gates on `!pinned`, the same expression that reaches the
    UI. When a guard exists to repair a state, gate it on the state's own
    predicate — never on a proxy that is usually equal to it, because "usually
    equal" is a description of the cells where the bug is not.

76. **Asking the model to CHOOSE from the catalog's printings measured worse
    than asking it to describe the frame, and the reason generalises.** The
    open rescue prompt asks for a transcription plus `treatment`; the closed
    one hands over the exact-name printing list and asks which number it is.
    Closed sounds strictly safer — a pick outside the list is discarded, so the
    wrong-card class becomes unreachable rather than merely unlikely — and on
    one fixture it is: `counterspell-retro` went wrong → ok on the clean cells,
    which the treatment path had never got. But the full matrix came back
    **179/223 against 180/223, MTG 33/47 against 34/47**, and the printing gate
    failed it at `mtg 72% → 70%`. It trades cells rather than adding them, at a
    larger prompt.
    Two mechanisms, both worth knowing before trying this again.
    **The cap must protect the ANSWER, not the favourite.** Ordering the
    shortlist by the believed set is what a first cut does, and it is exactly
    backwards: the believed set is the one the fuzzy match got WRONG, so twenty
    slots filled with MSC printings of Lightning Bolt while the borderless
    PW26 #5 — the reason the tie-break ran at all — never made the list. The
    model answered `unsure`, correctly, and four cells that had been right went
    wrong. Taking one printing per distinct treatment first recovered them.
    **A prompt that asks a new question stops answering the old one.** With the
    choose prompt in place, `tiebreak-read` came back `treatment: null` on every
    call, so the frame path that was doing the real work went silent — the
    closed question did not beat treatment, it REPLACED it. Asking for both
    explicitly ("answer `treatment` even when you set `unsure`") recovered the
    clean cells but not the glare ones, where the model declines and describes
    nothing. If this is revisited, the shape to try is the open prompt WITH a
    candidate list appended, so `pick` can only ever add to `treatment`.
77. **The art region can rank same-name printings with the hash the pipeline
    already owns — but only through a shift-search, and the live-app half
    still hangs on a CORS header nobody here can read.** Spiked for the case
    nothing else reaches (Island #290 answered as #289: identical name, frame
    and treatment, only the artwork differs — `printingTiebreak` exits at
    `treatments.size < 2` and its non-regular rule would block a re-pick
    anyway). `frameHash` (vision.ts, 128-bit mean+gradient 8×8) over an
    approximate art rect, on the fixtures' two real same-name pairs (Lightning
    Bolt MSC 806 vs borderless PW26 5; Tauros GX SM1 100 vs full-art 156):
    aligned, same-art-degraded distances sit ≤30 while different-art sits
    46–77 — but a 2% rect shift already costs 15–34 bits and by 4% the bands
    OVERLAP (26–51 vs 46), so a single-rect comparison is dead on arrival;
    detector jitter is the common case, not the corner case. A ±4% shift-search
    on the capture side (25 hashes, each a 9×8 downsample — negligible)
    restores it: capture degraded AND misaligned 3%/scale 1.03 ranked the true
    printing argmin in 4/4 trials at margins 14v47, 22v36, 19v57, 17v47.
    Design consequences if built: rank among exact-name candidates only (the
    tie-break's own candidate rule), never an absolute threshold — the
    borderless margin (22v36) is too thin for one; and the harness can develop
    all of it taint-free (vite serves fixture images same-origin). The live-app
    half — whether catalog CDNs let a canvas read pixels back, or taint it —
    could not be asked from the sandbox (its egress policy 403s every card
    host; verified against the proxy's own status, policy denials rather than
    outages), so `fetch-fixtures.mjs` records each image host's
    `access-control-allow-origin` into `manifest.corsProbe`, asked with the
    app's gh-pages origin, and the CI fixture run ANSWERED it:
    `cards.scryfall.io` `*`, `assets.tcgdex.net` `*`,
    `tcgplayer-cdn.tcgplayer.com` `*`, `images.ygoprodeck.com` **no header**.
    So the approach is live for MTG (the motivating basic-lands case),
    Pokémon and every TCGplayer-served game, and dead for Yu-Gi-Oh's catalog
    images — an acceptable loss, since Yu-Gi-Oh identifies by passcode and
    its printing column is excluded (lesson 63) — unless YGOPRODeck changes
    headers; no client-side cleverness revives a tainting host, by design.
    Remember `crossOrigin='anonymous'` on the img/fetch: without it the
    browser never sends Origin and the canvas taints even on a `*` host.
78. **"No collector evidence" measures the PARSER, not the OCR — read the
    raws before spending anything on read rate.** Lesson 74 counted
    `riftbound/short-name-1` among the cells with `number: null, total:
    null`, and the read-rate framing filed it under "the line doesn't
    read." The trace raws said otherwise: the line read `VEN « R04 « EN`,
    clean, on cell after cell — Riftbound RUNES print set · letter-number ·
    language and no fraction at all, and `parseCornerInfo`'s riftbound
    branch knew only fractions, so a perfect read parsed to nothing and the
    `refine` event reported null evidence. One strictly-additive parser row
    (anchored on all three tokens in order, language tail last, set slot
    refusing language marks; runs only when no fraction parsed) moved
    printing 118/169 → 125/169 and riftbound 42/50 → 49/50, identical over
    two runs, no other cell moving. Validated lesson-29 style before the
    matrix: over every captured OCR text, ten fires, all on the rune
    fixture, all yielding exactly the printed set and number. The
    transferable rule: a null in the refine event is the END of a pipeline
    — attribute it to the read only after the raws show no line, because a
    vocabulary gap in the parser produces the same null at zero OCR cost to
    fix. matchCatalog needed no change: +0.2 digits / +0.1 set already
    ranked the right printing first once evidence existed.
79. **When the rect that contains the line reads garbage, suspect the rect's
    GEOMETRY before its treatment — and probe both before touching the
    pipeline.** Rayquaza VMAX's "218/203" sat inside the deep tier's raw
    bottom band on eleven wrong cells and came back garbage at 5× under
    normal, binary AND binary-flip — the polarity hypothesis (white type
    over dark art wants a flipped threshold) probed clean-negative in two
    minutes, which is the whole point of probing first: two matrix runs
    were NOT spent measuring it. Geometry was the lever. The wide bands'
    top edge (y 0.90) clips the line and their 0.55 width spends
    `readRegionText`'s 1600px cap on rules text beside it; a 0.35-wide
    sliver at y 0.885 leaves the cap to the line's own glyphs and parses
    218/203 outright. `RAW_LINE_SLIVER` now runs FIRST in the deep tier's
    raw-band list: printing 125 → 128 (pokemon 35/55 → 38/55), identical
    over two runs, and a hit costs one pass while skipping both wide bands.
    Two boundaries measured at the same time, both worth keeping: charizard-
    base's degraded cells are a genuine READ limit — no rect or variant
    resolves "4/102" under soft-focus/lowlight/worst — and the counterspell
    glare auto cell flipped fail after the change on both runs, which the
    reproduce-twice rule says to treat as caused; its traces settled it the
    other way — byte-identical OCR text and candidates, only the lookup
    LATENCIES differ, so the cell is decided by wall-clock deadlines under
    CPU load, not by any code path (the sliver is unreachable from an MTG
    auto cell). When a cell flips the same way twice, diff its TRACES, not
    its verdicts, before accepting blame — same-direction flips can still
    be timing, and the trace is what says so.
80. **The MTG deep tier is measured-negative — do not extend
    `PRINTING_RIDES_ON_THE_LINE` to MTG for these fixtures.** The obvious
    next move after the Pokémon deep tier recovered rayquaza was the same
    ladder for MTG's worst printing column, and the probe refused it on all
    three counts before a matrix run was spent. `counterspell-retro`'s
    collector block resolves under NO treatment — every rect × variant ×
    5-6× zoom returns fragments — and the one fragment that parses ("Rt 6
    2" → number 6, truth 5) would sail through the refine's `collectorEq`
    against a catalog with that many Counterspell printings and pin a wrong
    edition as claimed-read: the deep tier there would not merely read
    nothing, it would manufacture the one class the gate forbids growing.
    And `borderless-any`, where the line DOES read at the narrow-sliver
    treatment ("P 0002 Promo / PRM · EN"), is resolve-blocked rather than
    read-blocked — printed promo numbering against Scryfall's set
    vocabulary — which reading harder cannot fix and the cloud tie-break
    already covers. The general rule the pair teaches: before extending a
    read ladder to a new game, probe BOTH that its target parses under some
    treatment AND that a parse would resolve — a ladder pointed at type
    below its resolution floor spends latency to mint confident wrong
    answers, which is strictly worse than the fuzzy default it replaces.
81. **The art hash shipped, and the spike's numbers held in the real
    pipeline.** `arthash.ts` + the `!pinned && mtg` wiring ahead of the cloud
    tie-break: printing 128/169 → 135/169 (mtg 23/46 → 30/46), identical
    over two runs, zero cells moving anywhere else. Every one of the seven
    swaps landed the truth printing at distances 15–26 and margins 11–24 —
    inside the spike's predicted bands (lesson 77: true-art ≤26, wrong-art
    ≥36) — and every decline landed on a hash-hostile degradation
    (soft-focus, glare, perspective, worst), which is the guards refusing
    rather than guessing: zero wrong swaps. Three things to know before
    extending it. The measurement needed the SNAPSHOT to carry candidate
    images (`images/prints/`, served by the stub at the captured URL shape;
    `illustration_id` kept in the trim because `artGroups` keys on it) — an
    art hash without stub-served candidates measures as a no-op and looks
    like a fix that does not work, lesson 55's trap in new clothes. The
    counterspell-retro asymmetry (small-offset swapped, clean declined)
    is art-BOX geometry: the 1997 frame's art sits differently than the 2015
    rect models, so `MTG_ART_RECT` samples frame furniture on retro cards
    and the margin thins — a per-frame-era art rect is the obvious next
    refinement, worth a probe before believing it. And the CI round that
    builds the snapshot taught its own lessons the hard way: a finished
    node script that never calls `process.exit` waits on whatever half-open
    sockets upstream servers left behind (two hour-long silent stalls —
    cancel unconsumed error bodies, exit explicitly), and Scryfall's CDN
    throttles per connection (~12.7s/image sequential; a pool of six is a
    browser's politeness and divides the wait).
82. **A gate can measure a feature as absent when its snapshot cannot feed
    it — and the 7a829a1 merge gate did exactly that.** The gate that
    landed the art-hash round ran on the 2026-08-15 snapshot, which
    carries no `images/prints/`; per lesson 81 the art path without
    stub-served candidates is a measured no-op, so "mtg 23/46, unchanged
    in all four runs" — written into the merge message as "the MTG
    problem remains open" — is a statement about the SNAPSHOT, not the
    pipeline. Lesson 81 measured the same code at mtg 23→30 on the
    print-bearing snapshot, and production fetches candidate images live,
    so the shipped app exercises the path the gate could not see. The
    riftbound +6 showed because the rune-line parser needs no images.
    Two halves to keep straight: a snapshot is only qualified to gate a
    change if it can FEED that change — for the art path that means
    `images/prints/` present (the 2026-08-17 snapshot 3b60035 carries
    179; check before trusting an unchanged column) — but the regression
    halves of that same gate (identify, claimed-wrong) were still valid:
    a no-op snapshot invalidates the improvement claim, never the
    no-drop claim. The actionable form (from the session whose gate hit
    this): before measuring a feature, ASSERT the fixtures contain the
    inputs that feature consumes -- `ls fixtures/images/prints | wc -l`
    is checkable where "did it help" is not. The run output will never
    warn you: the blind gate reported mtg 23/46 with full confidence
    and no hint that the path under test had never executed.
83. **Compare runners before comparing runs.** a05f528 changed
    run-matrix.mjs (printing serialised into byGame) on the branch side
    of the 7a829a1 gate, so baseline and candidate consoles were produced
    by DIFFERENT code — the baseline's own summary simply lacked
    printing. The rule that earned its keep: before trusting any
    before/after, diff the two sides' run-matrix.mjs; if they differ at
    all, recompute both sides from the raw `cells` array with one
    function (graded = pass and printing in ok|wrong; claimed = pass and
    printing wrong and pinned) rather than reading either runner's
    self-report. From the same session's calibration: two identical runs
    of one commit produced identical summaries while four cells moved
    underneath, concentrated in `worst` and `soft-focus` — so
    reproduce-twice is not ceremony, and identical totals are not proof
    that nothing moved.
84. **`outcome.number` is the answer, not the evidence.** It carries the
    ANSWERED card's catalog number and is always populated, so testing
    "did the pipeline actually read a collector line" with
    `!outcome.number` reports zero cells lacking evidence — exactly
    backwards, and it reads as a reassuring audit. The read's actual
    markers are `outcome.pinned === false` and
    `outcome.editionNumber == null`. The error was caught only because
    "0 of 23 lack evidence" contradicted 1711aee's own rationale — when
    an audit agrees with everything, audit the audit. Same session's
    practice worth keeping alongside: PRE-REGISTER the eligible-cell
    ceiling and the must-not-grow number from the CURRENT snapshot
    before running a measurement (lessons 82–83 are both stories of
    "expected" numbers drifting across snapshots; a pre-registered
    target written down first cannot be rationalised afterwards).
