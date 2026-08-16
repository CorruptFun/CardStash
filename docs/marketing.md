# Marketing and informational material

The landing page lives in `marketing/index.html`. `npm run build:marketing` inlines
the three font subsets it sets and writes a single self-contained file to
`marketing/dist/` (gitignored — it is build output, and the base64 fonts alone are
~225 KB that would otherwise land in every diff).

The page is built from this chapter. **If you change a claim on the page, change it
here first** — the point of this file is that the copy has a source, and that a
claim which can't be traced to a file doesn't ship.

## The name

**Cardstock**, everywhere a person can see it. The repository and its folder are
called CardStash for historical reasons; that is not a second brand and must not
appear in copy. `docs/roadmap.md` §7 lists the rest of the naming cleanup.

Do not print a version number in marketing copy. `src/lib/version.ts` reads 0.17.0
while messaging, custom binders, page scanning and printed QR labels all shipped
after it, so the number understates the product rather than dating it.

## The position

Three things are true of Cardstock that are not true of the category, and the copy
leads with them in this order:

1. **Identification runs on the device.** The Tesseract worker, both wasm cores and
   the English traineddata are copied out of npm at build time and served from our
   own origin (`vite.config.ts` `ocrAssets()`); nothing is fetched from a
   third-party CDN. This is architectural and independently verifiable from the
   source, which is what makes it the strongest claim in the tree.
2. **Signed out, the app is whole.** Scanning, collection, decks, binders and
   link-based sharing need no account and no server. Hosted social, the vault,
   billing and escrow are dormant without a session, and the Google script is
   injected on first use rather than at boot (`drive.ts`).
3. **It refuses rather than guesses.** Confidence floors, closed vocabularies and
   the "Edition not read — check it's yours" state exist so the scanner is allowed
   to guess a printing but never to present a guess as a reading.

The handshake being free is a position, not a temporary state (decision 25). Two
collectors may do a whole deal in messages and pay nothing; escrow is the optional
service the fee buys. Copy must sell escrow on what it does and never on fear of
the free path we are simultaneously offering.

## What the page claims, and what backs it

| Claim | Backed by |
|---|---|
| Nine trading card games, plus sports | `src/lib/games.ts` (`GAMES`) |
| On-device text recognition, self-hosted engine | `vite.config.ts`, `src/lib/ocr.ts`, `src/sw.js` |
| Foil detected from the stock's specular signature | `src/lib/vision.ts` (`foilSheen`) |
| The collector line rescues a name the OCR can't read | `src/lib/corner.ts`, `identify.ts` |
| Graded slabs read as company, grade, qualifier, cert | `src/lib/slab.ts`, `psa.ts` |
| Up to twelve cards from one binder-page photo | `src/lib/multiscan.ts` (`MAX_PAGE_CARDS`) |
| Sports cards synthesized from what is printed | `src/lib/sportsparse.ts`, `sports.ts`, decision 17 |
| Condition-aware portfolio value, cost basis, movers | `src/lib/prices.ts`, `portfolio.ts` |
| Per-game deck rules and boards | `src/lib/deckstats.ts` (`GAME_BOARDS`, `DECK_RULES`) |
| Binders with their own audience, page numbers, QR labels | `src/lib/binders.ts`, `qr.ts`, decisions 26–27 |
| A share link *is* the data | `src/lib/social.ts`, decision 7 |
| Wants match any printing | `src/lib/social.ts` (want keys) |
| Six upstream catalogs | `scryfall.ts`, `pokemon.ts` (×2), `ygo.ts`, `lorcast.ts`, `tcgcsv.ts` |

## Claims we do not make

Each of these is false or unsupportable as written. They are listed because each
one is a plausible sentence somebody will eventually try to write.

- **"End-to-end encrypted" / "we can't read your collection" / "zero-knowledge" /
  "passphrase-protected."** The vault key is minted and held server-side
  (migration 0009, decision 15b). The approved phrasing is *encrypted at rest with
  a key held server-side; not end-to-end.* Note `docs/social.md`'s cloud-vault
  table is stale on this point and must not be used as a copy source.
- **"No image ever leaves your device."** True only with the qualifier: cloud
  rescue is opt-in and off by default, and sends one frame when a scan is stuck.
- **"Bring your own AI key."** There is no key field; the deck builder calls our
  hosted function and requires a subscription.
- **"Buy and sell cards."** Escrow ships off in the deployed build — both
  `VITE_MARKETPLACE` and `MARKETPLACE_ENABLED` (decision 19). Only Ask is live.
- **"Public binder", implying the open web.** It means any signed-in collector.
  A binder readable by `anon` is one anybody with the publishable key can
  enumerate, which is what `trade_offers` refuses to be (decision 26).
- **"Social is encrypted."** Published binders are plaintext to us by necessity —
  a friend's app has to read them. Messages likewise, and the composer says so.
- **"No telemetry."** Diagnostics are content-free but on by default outside the
  EU, EEA and UK, where consent is asked instead (decision 20).
- **"Prices for every card."** Sports and user-authored custom cards carry none.
- **Premium framing for photo upload or page scanning.** Every row in `GATED`
  (`src/lib/entitlement.ts`) is currently false; whether they become paid is an
  open product decision.

## Numbers

Safe to quote, because they are counts of what is committed: **289** real
photographs (44 MB) under `tests/harness/photos/`, **18** seeded camera
degradations (`tests/harness/augment.mjs`), **395** unit test cases across **37**
files, **19** npm test entry points, **6** upstream catalogs, **~200 KB** gzipped
bundle, card-art cache capped at **480** images (`src/sw.js`).

**Do not quote a single identification rate.** Three batteries disagree on
purpose — rendered fixtures 204/282 (72%) with zero wrong cards, hand-curated
photographs 4/12, handheld clips 10 wrong in 40 — and `docs/scanning.md` states
outright that a battery of stills cannot bound a live scanner's wrong-card rate.
Quoting the flattering one is precisely the overstatement the docs name. The page
therefore describes *what is measured* and points at the docs for rates.

There are no honest numbers for users, installs, retention, cards searchable, or
scan latency. Budgets in `identify.ts` are ceilings, not measured times: "scans in
7 seconds" would be false.
