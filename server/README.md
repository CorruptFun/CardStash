# Cardstock sync server

Optional. Cardstock works without it — binders and trades travel as links.
Run this when a group wants their binders to update **live** instead of
re-sending links, e.g. a playgroup on the same wi-fi.

## Run it

```bash
npm run sync              # port 8787
npm run sync -- --port 9000
```

It prints the addresses to hand out:

```
Cardstock sync server on port 8787 — 0 binders stored
  this device : http://localhost:8787
  same wi-fi  : http://192.168.1.20:8787
```

In the app: **Friends → Live sync → paste the address → Connect**. Everyone
who enters the same address sees each other under "On this server", and
trades/replies arrive without links. Disconnect returns to link-only mode.

Zero dependencies — plain `node`, no install step. State is a single JSON file
at `server/data/state.json`; delete it to reset the server.

## What it stores

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/health` | identify the server |
| `GET /v1/directory` | who has published a binder here |
| `PUT /v1/binders/:id` | publish my binder (owner token required) |
| `GET /v1/binders/:id` | read a published binder |
| `POST /v1/inbox/:id` | drop a trade proposal or reply for someone |
| `GET /v1/inbox/:id` | drain my inbox (owner token required) |

Ownership is **trust-on-first-use**: the first device to publish a profile id
claims it with a device token, and only that token can publish or read that
inbox afterwards. Anyone who knows an id can *send* a trade to it, exactly as
anyone can send you a link.

## Scope, deliberately

This is a LAN/dev convenience server, not a hosted service:

- **No transport security.** Plain HTTP, tokens in headers — fine on your own
  network, not on the open internet. Don't port-forward it.
- **No accounts or recovery.** Clearing browser storage loses the device token,
  which means losing the ability to republish under that profile id.
- **Trusts the network it's on.** Anyone who can reach the port can read
  published binders and the directory.

The client treats everything it returns as untrusted anyway — payloads run
through the same sanitizers as a pasted link, so a bad server can't corrupt a
collection.

The route/table shape (`binders`, `inbox`) matches the eventual hosted
backend, so moving to Postgres/Supabase with real auth is a storage swap
rather than a client rewrite.
