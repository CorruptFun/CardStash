# UI

## Screens

| Screen | File | What it does |
| ------ | ---- | ------------ |
| **Scan** | `views/ScanView.tsx` | The camera. Game filter chips, Packs (sealed) toggle, Collect toggle, torch. A reticle with live "sensing/locking" feedback, the result chip (name · set · price · finish cycler), the "what the scanner saw" diagnostics door, and the recent-scan tray. Also owns the start gate and the iOS permission explainer, the **photo upload** control (`UploadButton`) and the **Page** pill for binder/multi-card scanning — both entry points check `entitlement.ts`, and both land on a **review screen** where the user confirms every row before anything is written. A page files ~9 cards on one tap, so nothing is added silently; each row offers a full-budget re-read. The tray's **Review** button (pinned outside the strip's scroller) opens **batch add** (`components/ScanBatch.tsx`) — the same review shell over the scan log, for filing a whole stack in one confirm. |
| **Search** | `views/SearchView.tsx` | Debounced multi-game search over the enabled games, by name or by the number printed on the card (`CODE_EXAMPLE` supplies the per-game example in the placeholder), accepting a prefill handed over from a failed scan. |
| **Collection** | `views/CollectionView.tsx` | Portfolio header (value, count, 30-day delta), the insights panel, game filter, text filter, sort, an edit/multi-select mode with bulk quantity and delete, spare/for-trade summaries, deck assignment, **filing a selection into a binder**, price refresh, CSV import/export and JSON backup/restore. |
| **Decks** | `views/DecksView.tsx` | Deck list and deck detail: board grouping by type, mana curve / colour bar / type bars, owned-vs-missing costing, rules warnings, add-cards modal (search or from your collection), rename, cover, decklist copy. |
| **AI builder** | `views/BuilderView.tsx` | The Gemini deck builder: game/format/style/budget, optional "build around these" seed cards, live-search-grounded meta research, parsed decklists that can be created as real decks. |
| **Friends** | `views/FriendsView.tsx` | Your shareable binder (for-trade count and value), the friends list with want-match badges, the trades list, import/paste, the live-sync panel, and **Invite a friend** (`components/InvitePanel.tsx`) — a `?via=<handle>` link that credits the referral *and* makes the two of you friends when they claim a handle. |
| **Friend binder** | `views/FriendBinderView.tsx` | One friend's snapshot: filter, want-match highlighting both ways, refresh from `sourceUrl` with a +added/−removed diff, and the trade composer. |
| **Trade** | `views/TradeView.tsx` | One trade: both sides priced, the difference line, accept/decline/reply-link, and "book it into my collection". |
| **Ingest** | `views/IngestView.tsx` | The `#/x?d=…` landing screen. Previews a profile or trade before saving; a **reply** link applies itself immediately, because the link *is* the answer. |
| **Settings** | `views/SettingsView.tsx` | Card games (enable/disable), scanning (collect mode, haptics), AI & API keys (Gemini key/model + test, pokemontcg.io key), data (demo seed, export, erase), diagnostics (local insights, share toggle, endpoint/token), about (version). |

The **card bottom sheet** (`views/CardSheet.tsx`) is the app's other main
surface, reachable from every screen. It shows art, prices with a comps table
and a sparkline, printings/variants, the finish + condition + quantity + cost
basis add bar, copies you already own, deck membership and assignment, the want
toggle, external links, and — for sealed products — the set's other products and
everything that could be pulled from it.

When a scan couldn't read the printed code, the sheet says so under the set
line ("Edition not read — check it's yours") and taps through to the printings
picker. The card is right; the edition is the source's default, and a
Yu-Gi-Oh reprint can be a hundredth of the Secret Rare's price — so the sheet
shows a guess as a guess (`printingUnconfirmed`, from `pinned` in
identify.ts).

## Routing and shell

Hash routing parsed in `App.tsx`; no router library. The shell is a
`<main>` plus a six-tab bottom nav (Scan · Search · Collection · Friends ·
Decks · Settings), with `CardSheetHost` and `Toasts` mounted above everything.
`#/binders` and `#/binders/<id>` sit under the Friends tab; the second is
**printed on paper** (a binder's QR label), so it is the one route that can
never be renamed.

The scan screen stays mounted (hidden) so its own state survives tab hops — the
camera does not, and is released the moment the tab changes (scanning.md §1).
Every hash change closes the sheet.

## The UI store (`src/store/ui.ts`)

A vanilla zustand store, read through `useUi(selector)`:

| Slice | Purpose |
| ----- | ------- |
| `sheet: SheetRequest \| null` | What the card sheet is open on: the card, optionally the collection row it came from, optionally a target deck, a preselected finish (the scanner's foil reading), and an `origin` used for analytics attribution. |
| `toasts` | `toast(text, kind, action?, ms?)` — 3.2s default, 6s with an action. |
| `searchPrefill` | Hand-off from a failed scan to the search screen. |
| `builderSeeds` | Cards handed to the AI builder to design around. |

`guarded(work, what)` lives here too — see [architecture.md](architecture.md).

## The bottom sheet mechanic

`components/Sheet.tsx` pushes a history entry when it opens, so the **hardware
back button closes the sheet instead of leaving the app**. It listens for
`popstate` and `hashchange`, and on unmount pops its own entry back off only if
it is still the current one (`shouldPopHistory`). Swipe-to-dismiss is
scroll-aware: a drag only starts when the sheet body is already scrolled to the
top. Closing animates for 190ms before the state actually clears.

## Design system

All styling is one hand-written stylesheet, `src/styles.css` (~5.2k lines,
BEM-ish class names), with design tokens on `:root`. `src/fonts.css` pins the
exact font subsets shipped (Inter Variable for UI, IBM Plex Mono for numerals).

Token families:

| Family | Examples | Notes |
| ------ | -------- | ----- |
| Surfaces | `--ink-000` … `--ink-300`, `--rule`, `--surface`, `--bg-elev` | A warm near-black ladder; the app is dark-only (`color-scheme: dark`). |
| Text | `--paper`, `--paper-2`, `--paper-3` → `--text`, `--text-2`, `--text-3` | |
| Signal | `--silver` → `--signal`, `--silver-deep` → `--signal-solid`, `--signal-fill`/`--signal-rule`, `--up`/`--down`/`--warn` + their fills | The accent is **metallic, not chromatic** — a collectible-card app should read like foil on card stock, not like a brand colour. Works because the surface ladder is warm: cool silver on warm near-black reads as metal catching light. Gains green, losses red, warnings amber. |
| Foil (chrome) | `--foil` | Silver gradient for the few hero moments (the welcome mark, the nav indicator). Its bright bands carry a few points of violet/rose/aqua, because real silver holo stock diffracts — neutral highlights read as brushed aluminium. Distinct from `--holo` below — see the note under this table. |
| Per-game | `--game-mtg`, `--game-pkm`, `--game-ygo`, `--game-rft`, `--game-lor`, `--game-op`, `--game-swu`, `--game-dgm`, `--game-gcg` | One hue per game, used for badges and accents. **A new game needs one.** |
| Foil | `--holo`, `--holo-spec`, `--holo-grain`, `--holo-veil`, `--glare` | The rainbow gradient + specular sweep used for foil treatments, plus the diffraction grating and the spectral veil — see "The holographic glare" below. |
| Rhythm | `--s1` … `--s12` (4→48px), `--r-0/1/2` radii | |
| Motion | `--t-1/2/3` (0.12/0.16/0.22s), `--ease-out`, `--ease-spring` | |
| Chrome | `--nav-h` (58px), `--sat`/`--sab` safe-area insets, `--lift-1/2`, `--sheen` | |

### Two things about the accent that will bite

**`--signal` and `--signal-solid` are not interchangeable.** `--signal` is
bright enough to be an accent against `--paper` text, which means white content
placed *on top of it* is invisible. Every site that fills a shape and puts
`#fff` inside — the toggle knob, the card-cell checkmark, the picker checkmark
— uses `--signal-solid`. Collapsing them back into one token silently destroys
all three, and it looks fine in a diff.

**`--foil` and `--holo` mean different things.** `--holo` is the rainbow
gradient and it is *data*: it marks a card as an actual foil printing, so it
must stay rainbow. `--foil` is silver and it is *chrome*: it says "collectible"
without claiming anything about the card under it. Reaching for `--holo` to
decorate UI would make the app assert a card is foil when it isn't.

### The holographic glare

`.cardimg--foil` gives a card the look of light catching a foil, and
`CardImg`'s `foil` prop drives it from the row's actual finish
(`isFoilFinish` in `games.ts` — `foil`/`etched`/`holo`/`reverse`, and
deliberately **not** `firstEd`, which is an edition stamp rather than a
surface). A search result never glares: finish lives on the collection row,
not the card, so a bare `Card` genuinely doesn't know which printing is meant.

Two layers, and both are needed:

| Layer | What | Why |
| ----- | ---- | --- |
| `::before` | standing `--holo` wash with `--holo-grain` blended over it on `soft-light`, **not animated** | what makes it look like foil at rest. The grain is the diffraction grating — real holo stock is a physically ruled pattern, and a smooth gradient alone reads as painted metal however saturated it gets. Static because animating `background-position` is a repaint per card per frame — and because on a real card the foil pattern is fixed and the *light* moves |
| `::after` | `--glare` band sweeping on `transform` | the glint itself; composited, so it's cheap |

The grain's pitch is in **px, not %**, on purpose: it is a property of the
stock rather than of the element, so a 54px mark and a full-bleed card show the
same ruling instead of a scaled version of it.

The sweep crosses in the first ~18% of its cycle and waits off-screen for the
rest. A continuous shimmer is the universal language for "not loaded yet",
which is the last thing a collection grid should say — and `nth-child` delays
break the unison, because a grid glinting together reads as a loading wave.

**This is only affordable because `.cardcell` sets `content-visibility: auto`,**
so offscreen cells (and their pseudo-elements) don't render at all. If that
rule goes, this becomes a per-card animation across the entire grid.

`prefers-reduced-motion` keeps the foil colouring and drops all movement.

**`.foilglare` is the chrome version, and it is allowed to do more.** It carries
the glare plus a third layer a card grid can't afford: `--holo-veil` (a spectral
wash on `overlay`) with `--holo-grain` over it, drifting slowly on a 14s cycle.
That drift is what reads as *holographic* rather than *silver* — a still surface
under a moving colour field is what the eye interprets as a tilt, even though
nothing tilted. It is affordable because exactly one 54px element on the welcome
screen uses it; the same layer multiplied across a 900-card grid is the repaint
storm the card rules above exist to avoid. `overlay` (not `screen`) is what lets
the veil cover the plaque's dark glyph without fogging it, and `isolation:
isolate` on the parent keeps every blend resolving against the plaque instead of
punching through to the page.

`.holotext` is the type version: `--holo-spec` clipped over `--holo`, both riding
`holoshift`, so a highlight crosses the letterforms rather than the whole word
pulsing. The `drop-shadow` on it is colour bleeding onto the surface behind — it
is small, and it is the difference between letters printed in foil and letters
filled with a gradient.

Charts that stroke SVG or canvas can't read CSS variables, so `InsightsPanel`,
`DecksView` and `CardSheet` each mirror `--silver` as a literal with a comment
saying so. If the accent moves, those move too.

`index.html` inlines a tiny critical style block that paints the near-black
ground and the dock hairline **before the bundle arrives**, so first paint is
already the design rather than a white flash.

## Shared components

- `basics.tsx` — `CardImg` (art with a placeholder + game tint, plus the `foil`
  glare above), `Seg` (segmented control; `sm`/`md`/`lg` sizes, scrollable and
  `glass` variants), `Stepper`, `Toggle`, `Modal` (`solid` or `glass`),
  `Empty`, `AnimatedNumber` (eased count-up for portfolio figures), `ManaCost`.
- `Icon.tsx` — a hand-drawn 24×24 stroke icon set, one visual family, no icon
  font. Stroke width scales with size.
- `Sheet.tsx`, `Toasts.tsx`, `DeckPicker.tsx`, `TradeSides.tsx`,
  `ShareActions.tsx` (link / file / native share sheet), `SocialPanel.tsx`,
  `ScanModes.tsx`, `ScanDebug.tsx`.

### The scan screen's top bar

A viewfinder is used one-handed, at arm's length, often standing in a shop, and
the thing under the controls is the actual product. So the bar carries as
little as possible:

- The **game picker** is `Seg` at `size="lg"` + `glass` — 48px tall, comfortably
  over the platform's 44px touch minimum, and frosted so it sits on the picture
  rather than in a panel. It shrinks and scrolls rather than clipping a game
  name in half.
- **`ScanModes`** is one button holding Packs, Page and Collect, opening a
  `variant="glass"` `Modal` so the camera stays visible behind it. Those were
  three separate pills; six controls over a live camera is a toolbar.

**The button must keep naming the active mode.** Collect mode files every
confident scan into the collection with no confirmation, so someone who forgets
it is on discovers it as a pile of cards they did not mean to add. The label
names the mode when exactly one is on, a badge counts them when more are, and
the pill takes an active state. The label used to be hidden below 430px, back
when three pills fought for the row — that rule is gone, and reinstating it
would hide exactly the state that most needs showing.

### A miss is two surfaces, and the split is the point

When a card will not read, the screen says two different kinds of thing, and
they have different lifetimes:

- **`ScanChip` (`chip--nomatch`) states.** What happened, plus one line of
  advice — try again, or upload a photo. It carries **no buttons at all**, and
  that is deliberate: the chip is torn down by the scanner's own retry about a
  second and a half later, and any real movement of the phone throws the loop
  back to `searching` and takes it away immediately. Buttons on it were
  unreachable in practice, and reaching for one moved the phone, which is
  itself what dismissed them.
- **`MissHelp` (`scan__misshelp`) acts.** Try again · Upload a photo · Search
  it instead · Add it myself · what did the scanner see · Hide. It is driven by
  `missRun` — consecutive entries into `nomatch`, reset by any hit — and NOT by
  the scanner's status, so it survives the retry churn underneath it. It shares
  the iOS hint's slot (`scan__ioshint`), so the two never stack, and it is
  capped at `min(46vh, 340px)` with its own scroll: help must not become a
  takeover of the viewfinder.

Free things first, always. Holding still, a still photo, searching by name and
describing the card by hand cost nothing and fix most misses; `MissOffer` is
appended **under** them, behind a rule, never in front. `npm run test:misshelp`
is what proves the panel outlives a retry it started — the failure this whole
split exists to fix is invisible to a screenshot and to the type system.

## Mobile behaviours worth knowing

- **Viewport**: `maximum-scale=1` stops iOS auto-zooming when a sub-16px input
  focuses; pinch-zoom is unaffected on modern iOS. `viewport-fit=cover` plus
  `safe-top`/`safe-bottom` utility classes and `env(safe-area-inset-*)` tokens
  handle notches and home indicators.
- **Selection** is disabled globally (`user-select: none`) and re-enabled on
  inputs and textareas — this is a tappy app, not a document.
- **Haptics**: `haptic(pattern)` in `util.ts`, gated by the `haptics` setting,
  fails silently where unsupported. A successful scan is `[14, 60, 14]`.
- **Overscroll** is pinned (`overscroll-behavior-y: none`) so pull-to-refresh
  doesn't fight the scan screen.

## Accessibility notes

Tabs are real anchors with an `aria-label`led `<nav>`; toggles and pills carry
`aria-pressed`; the segmented control takes an `ariaLabel`; icon-only buttons
carry `aria-label`; decorative chrome (the reticle, the vignette) is
`aria-hidden`. The app is dark-only by design, so there is no theme toggle to
support.

## Conventions for new UI

1. Any DB write goes through `guarded()`.
2. Reads come from `useLiveQuery` so every screen updates when anything writes.
3. New colours become tokens in `:root`; don't inline hex values.
4. User-facing copy explains the *situation and the recourse* ("Storage is full
   — export a backup, then remove some cards"), not the error class.
5. Analytics calls stay content-free — see [privacy.md](privacy.md).
