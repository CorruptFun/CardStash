# Cardstock

Camera-first TCG scanner & collection portfolio PWA (Magic · Pokémon · Yu-Gi-Oh):
point your camera at a card, see what it's worth, track your collection like a
portfolio, build decks — by hand, or with the AI deck builder.

**Live: https://corruptfun.github.io/CardStash/** — open it on your phone and add
it to your home screen; camera scanning, the offline shell and local-first
storage all work from there.

## How it works

- **Scan** — live camera identification (Gemini vision with your own API key, or
  on-device OCR fallback), price chip pops up, one tap to collect.
- **Search** — Scryfall (Magic), pokemontcg.io (Pokémon), YGOPRODeck (Yu-Gi-Oh!)
  with prices, comps, printings and price history.
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
- **Live sync (optional)** — run `npm run sync` on any computer and point a
  group at the address it prints: binders then refresh in the background and
  trades arrive in-app instead of by link. Off by default, one tap to leave.
  See [`server/README.md`](server/README.md).

Everything is stored locally (IndexedDB). No accounts, no server required — API
keys live on-device and are sent only to their own services. Social works
serverlessly by default: a share link *is* the data (compressed into the URL),
so nothing is published anywhere unless you send it to someone.

## Commands

- `npm run dev` — dev server
- `npm run build` — typecheck + production build
- `npm run sync` — optional live-sync server (see `server/README.md`)
- `npm run test:unit` / `npm run test:scan` — unit tests / scan matrix

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
