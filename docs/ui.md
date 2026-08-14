# UI

## Screens

| Screen | File | What it does |
| ------ | ---- | ------------ |
| **Scan** | `views/ScanView.tsx` | The camera. Game filter chips, Packs (sealed) toggle, Collect toggle, torch. A reticle with live "sensing/locking" feedback, the result chip (name · set · price · finish cycler), the "what the scanner saw" diagnostics door, and the recent-scan tray. Also owns the start gate and the iOS permission explainer, the **photo upload** control (`UploadButton`) and the **Page** pill for binder/multi-card scanning — both entry points check `entitlement.ts`, and both land on a **review screen** where the user confirms every row before anything is written. A page files ~9 cards on one tap, so nothing is added silently; each row offers a full-budget re-read. |
| **Search** | `views/SearchView.tsx` | Debounced multi-game search over the enabled games, accepting a prefill handed over from a failed scan. |
| **Collection** | `views/CollectionView.tsx` | Portfolio header (value, count, 30-day delta), the insights panel, game filter, text filter, sort, an edit/multi-select mode with bulk quantity and delete, spare/for-trade summaries, deck assignment, price refresh, CSV import/export and JSON backup/restore. |
| **Decks** | `views/DecksView.tsx` | Deck list and deck detail: board grouping by type, mana curve / colour bar / type bars, owned-vs-missing costing, rules warnings, add-cards modal (search or from your collection), rename, cover, decklist copy. |
| **AI builder** | `views/BuilderView.tsx` | The Gemini deck builder: game/format/style/budget, optional "build around these" seed cards, live-search-grounded meta research, parsed decklists that can be created as real decks. |
| **Friends** | `views/FriendsView.tsx` | Your shareable binder (for-trade count and value), the friends list with want-match badges, the trades list, import/paste, and the live-sync panel. |
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

## Routing and shell

Hash routing parsed in `App.tsx`; no router library. The shell is a
`<main>` plus a six-tab bottom nav (Scan · Search · Collection · Friends ·
Decks · Settings), with `CardSheetHost` and `Toasts` mounted above everything.

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
| Signal | `--signal` (violet), `--up`/`--down`/`--warn` + their fills | Gains green, losses red, warnings amber. |
| Per-game | `--game-mtg`, `--game-pkm`, `--game-ygo`, `--game-rft`, `--game-lor`, `--game-op`, `--game-swu`, `--game-dgm`, `--game-gcg` | One hue per game, used for badges and accents. **A new game needs one.** |
| Foil | `--holo`, `--holo-spec` | The rainbow gradient + specular sweep used for foil treatments. |
| Rhythm | `--s1` … `--s12` (4→48px), `--r-0/1/2` radii | |
| Motion | `--t-1/2/3` (0.12/0.16/0.22s), `--ease-out`, `--ease-spring` | |
| Chrome | `--nav-h` (58px), `--sat`/`--sab` safe-area insets, `--lift-1/2`, `--sheen` | |

`index.html` inlines a tiny critical style block that paints the near-black
ground and the dock hairline **before the bundle arrives**, so first paint is
already the design rather than a white flash.

## Shared components

- `basics.tsx` — `CardImg` (art with a placeholder + game tint), `Seg`
  (segmented control, scrollable variant), `Stepper`, `Toggle`, `Modal`,
  `Empty`, `AnimatedNumber` (eased count-up for portfolio figures), `ManaCost`.
- `Icon.tsx` — a hand-drawn 24×24 stroke icon set, one visual family, no icon
  font. Stroke width scales with size.
- `Sheet.tsx`, `Toasts.tsx`, `DeckPicker.tsx`, `TradeSides.tsx`,
  `ShareActions.tsx` (link / file / native share sheet), `SyncPanel.tsx`,
  `ScanDebug.tsx`.

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
