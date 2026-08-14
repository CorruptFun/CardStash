# Cardstock

Camera-first TCG scanner & collection portfolio PWA — Magic, Pokémon, Yu-Gi-Oh!,
Riftbound, Lorcana, One Piece, Star Wars: Unlimited, Digimon and Gundam. Point
your camera at a card, see what it's worth, track your collection like a
portfolio, build decks — by hand, or with the AI deck builder.

**Live: https://corruptfun.github.io/CardStash/** — open it on your phone and add
it to your home screen; camera scanning, the offline shell and local-first
storage all work from there.

## How it works

- **Scan** — live camera identification that runs **entirely on your device**:
  text recognition reads the card name and the collector line, a pixel check
  spots foil sheen, price chip pops up, one tap to collect. No image ever leaves
  the phone, no account and no API key are needed, and it works offline.
- **Search** — Scryfall (Magic), pokemontcg.io (Pokémon), YGOPRODeck (Yu-Gi-Oh!),
  Lorcast (Lorcana) and TCGplayer data via TCGCSV (Riftbound, One Piece, Star
  Wars: Unlimited, Digimon, Gundam) — with prices, comps, printings and history.
- **Collection** — portfolio value, 30-day insights, cost basis / P&L, movers,
  CSV import/export, JSON backups.
- **Decks** — build by hand from search or your collection, assign cards you own
  to decks from the card view (and see which decks a card is in), mana curve /
  color / type stats, owned-vs-missing costing.
- **AI builder** — bring a free Gemini key; it researches the current meta with
  live search and proposes decks from your collection, optionally built around
  specific seed cards you pick.
- **Friends & trades** — mark copies "for trade", share your binder (or whole
  collection) as a link or file, follow friends' binders the same way (host the
  file at a stable URL — e.g. a GitHub Gist — and refresh anytime), then
  propose trades card-by-card with both sides priced; accept/decline travels
  back as a reply link, and booking a completed trade updates both inventories.
- **Want list & matchmaking** — heart any card as a want (any printing counts);
  wants travel with your binder share, so both sides see matches highlighted:
  cards of theirs you're hunting, cards of yours they're hunting, one-tap
  select in the trade composer, and +added/−removed diffs on every refresh.
- **An account (optional)** — sign in with an emailed code and claim an
  `@handle`. Friends then add you by handle instead of a link, trade offers
  arrive in the app, friends' binders refresh themselves, and you can see which
  collectors are offering the cards on your want list. Claiming a handle
  publishes **no cards**; putting your binder up is a separate switch, and what
  you share decides who can read it — a for-trade list is findable by any
  signed-in collector, a whole collection only by friends you accept.

- **Backup (optional)** — keep a daily copy of everything in **your own Google
  Drive**, in a private folder only this app can see. Your browser talks to
  Google directly; we host nothing and never see the file. Especially worth it
  on iPhone, where Safari deletes the data of sites you haven't opened in about
  a week.

Everything is stored locally (IndexedDB). **No account and no server required**
— that stays true however far the app grows: scanning, your collection, decks
and link-based sharing all work offline with nothing signed in. API keys live
on-device and are sent only to their own services. Social works serverlessly by
default: a share link *is* the data (compressed into the URL), so nothing is
published anywhere unless you send it to someone. The optional extras — Drive
backup, the encrypted cloud vault, an account for friends and trades — are
things you switch on, never things you're switched into.

## Documentation

Full build documentation lives in [`docs/`](docs/) — architecture, the data
model, the scan pipeline, card sources and pricing, social/sync, the PWA and
service worker, testing, privacy, and the decisions behind all of it. Start at
[`docs/README.md`](docs/README.md).

## Commands

- `npm run dev` — dev server
- `npm run build` — typecheck + production build
- `npm run test:unit` / `npm run test:scan` — unit tests / scan matrix
- `npm run test:social` — hosted-social RLS against a real Supabase project

## Development

```sh
npm install
npm run dev        # local dev server
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build locally
```

Handy dev query params: `?demo=1` seeds a sample collection + deck on first run;
`?nosw=1` skips service-worker registration.

## Deploying

The live site is served from the `gh-pages` branch, which carries **build output
only** — source lives here on the main branch. Every push to `main` builds and
publishes the site automatically via GitHub Actions
(`.github/workflows/deploy.yml`), so merging to `main` *is* deploying.

`npm run deploy` exists as a manual fallback (builds and force-pushes `dist/`
to `gh-pages`) for when Actions is unavailable.
