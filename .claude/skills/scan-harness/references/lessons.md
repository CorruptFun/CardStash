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
15. **Real failure messages are the user's diagnostic.** "Read “X” but
    couldn't match it" = match layer (trace shows scores); "Couldn't read
    the card name" = OCR + corner both empty. Keep messages honest about
    which stage gave up — the eye-icon trace panel depends on it.
