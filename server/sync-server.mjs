#!/usr/bin/env node
/**
 * Cardstock sync server — optional, self-hosted, zero dependencies.
 *
 * The app stays local-first and link-sharing keeps working without this.
 * Point a group of devices at one instance and binders/trades flow between
 * them automatically instead of by copy-pasted link.
 *
 * The shape here is deliberately the shape of the eventual hosted backend:
 *   binders  (id, name, payload, updated_at)   ← one row per collector
 *   inbox    (id, recipient, payload, at)      ← trade proposals + replies
 * so moving to Postgres/Supabase is a storage swap, not a redesign.
 *
 * Ownership is trust-on-first-use: the first device to publish a profile id
 * claims it with a device token, and only that token can publish again.
 * Anyone who knows a profile id can drop a trade in its inbox (same as
 * anyone being able to send you a link), but only the owner can read it.
 *
 * Run:  npm run sync        (add -- --port 9000 to change the port)
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, 'data')
const STATE_FILE = join(DATA_DIR, 'state.json')

const API_VERSION = 1
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_PROFILES = 500
const MAX_INBOX_ITEMS = 200
const INBOX_TTL_MS = 30 * 86_400_000
const SAVE_DEBOUNCE_MS = 400

/* --- storage ------------------------------------------------------------- */

/** { binders: {id: {name, payload, updatedAt, tokenHash}}, inbox: {id: [item]} } */
let state = { binders: {}, inbox: {} }

function loadState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (raw && typeof raw === 'object') {
      state = { binders: raw.binders ?? {}, inbox: raw.inbox ?? {} }
    }
  } catch {
    /* first run — empty state */
  }
}

let saveTimer = null
function saveSoon() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = `${STATE_FILE}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, STATE_FILE)
    } catch (err) {
      console.error('[sync] could not save state:', err.message)
    }
  }, SAVE_DEBOUNCE_MS)
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex')
}

/** Drop inbox items older than the TTL, keeping the newest MAX_INBOX_ITEMS. */
function pruneInbox(id) {
  const items = state.inbox[id]
  if (!items) return
  const cutoff = Date.now() - INBOX_TTL_MS
  const fresh = items.filter((item) => item.at >= cutoff)
  state.inbox[id] = fresh.length > MAX_INBOX_ITEMS ? fresh.slice(-MAX_INBOX_ITEMS) : fresh
}

/* --- http helpers -------------------------------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null)
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function bearer(req) {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}

/** Profile ids are client-generated uuids; keep them boring and bounded. */
function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

function displayName(payload) {
  const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 60) : ''
  return name || 'A Cardstock collector'
}

/* --- routes -------------------------------------------------------------- */

async function handle(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean)

  // GET /v1/health — is this a Cardstock sync server?
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'health') {
    return send(res, 200, {
      app: 'cardstock-sync',
      v: API_VERSION,
      binders: Object.keys(state.binders).length,
      at: Date.now(),
    })
  }

  // GET /v1/directory — who has published a binder here.
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'directory') {
    const rows = Object.entries(state.binders).map(([id, row]) => ({
      id,
      name: row.name,
      updatedAt: row.updatedAt,
      cards: Array.isArray(row.payload?.cards) ? row.payload.cards.length : 0,
      wants: Array.isArray(row.payload?.wants) ? row.payload.wants.length : 0,
    }))
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return send(res, 200, { binders: rows })
  }

  // PUT /v1/binders/:id — publish my binder (claims the id on first write).
  if (req.method === 'PUT' && parts[0] === 'v1' && parts[1] === 'binders' && validId(parts[2])) {
    const id = parts[2]
    const token = bearer(req)
    if (!token) return send(res, 401, { error: 'missing device token' })
    const payload = await readBody(req)
    if (!payload || payload.kind !== 'profile') return send(res, 400, { error: 'expected a profile payload' })
    if (payload.id !== id) return send(res, 400, { error: 'payload id does not match the path' })
    const existing = state.binders[id]
    if (existing && existing.tokenHash !== hashToken(token)) {
      return send(res, 403, { error: 'that binder belongs to another device' })
    }
    if (!existing && Object.keys(state.binders).length >= MAX_PROFILES) {
      return send(res, 507, { error: 'server is full' })
    }
    state.binders[id] = {
      name: displayName(payload),
      payload,
      updatedAt: Date.now(),
      tokenHash: existing?.tokenHash ?? hashToken(token),
    }
    saveSoon()
    return send(res, 200, { ok: true, updatedAt: state.binders[id].updatedAt })
  }

  // GET /v1/binders/:id — read someone's published binder.
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'binders' && validId(parts[2])) {
    const row = state.binders[parts[2]]
    if (!row) return send(res, 404, { error: 'no binder published under that id' })
    return send(res, 200, { updatedAt: row.updatedAt, payload: row.payload })
  }

  // POST /v1/inbox/:id — hand a trade proposal or reply to someone.
  if (req.method === 'POST' && parts[0] === 'v1' && parts[1] === 'inbox' && validId(parts[2])) {
    const id = parts[2]
    const payload = await readBody(req)
    if (!payload || (payload.kind !== 'trade' && payload.kind !== 'reply')) {
      return send(res, 400, { error: 'expected a trade or reply payload' })
    }
    const items = (state.inbox[id] ??= [])
    items.push({ id: randomUUID(), at: Date.now(), payload })
    pruneInbox(id)
    saveSoon()
    return send(res, 200, { ok: true })
  }

  // GET /v1/inbox/:id?since=<ms> — my incoming trades (owner token required).
  if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'inbox' && validId(parts[2])) {
    const id = parts[2]
    const token = bearer(req)
    const owner = state.binders[id]
    // Unclaimed ids are readable by whoever asks — nothing has been published
    // under them, so there is no owner to protect yet.
    if (owner && owner.tokenHash !== hashToken(token)) return send(res, 403, { error: 'not your inbox' })
    const since = Number(url.searchParams.get('since')) || 0
    const items = (state.inbox[id] ?? []).filter((item) => item.at > since)
    return send(res, 200, { items, at: Date.now() })
  }

  return send(res, 404, { error: 'no such endpoint' })
}

/* --- server -------------------------------------------------------------- */

function lanUrls(port) {
  const urls = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) urls.push(`http://${addr.address}:${port}`)
    }
  }
  return urls
}

function main() {
  const portFlag = process.argv.indexOf('--port')
  const port = Number(portFlag !== -1 ? process.argv[portFlag + 1] : process.env.PORT) || 8787
  loadState()

  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    handle(req, res, url).catch((err) => {
      send(res, err.message === 'payload too large' ? 413 : 400, { error: err.message })
    })
  })

  server.listen(port, '0.0.0.0', () => {
    const binders = Object.keys(state.binders).length
    console.log(`Cardstock sync server on port ${port} — ${binders} binder${binders === 1 ? '' : 's'} stored`)
    console.log(`  this device : http://localhost:${port}`)
    for (const url of lanUrls(port)) console.log(`  same wi-fi  : ${url}`)
    console.log(`\nPaste one of those into the app: Friends → Live sync → server address.`)
    console.log(`Data lives in ${STATE_FILE} — delete it to reset.`)
  })
}

main()
