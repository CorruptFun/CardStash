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

Everything is stored locally (IndexedDB). No accounts, no server — API keys live
on-device and are sent only to their own services.

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
