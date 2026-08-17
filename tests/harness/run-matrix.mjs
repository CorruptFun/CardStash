/**
 * Real-image scan regression matrix.
 *
 * Boots the Vite dev server, launches headless Chromium (playwright-core),
 * and runs the REAL identifyFrame pipeline over real card images under a
 * battery of camera degradations (see augment.mjs). Card-API calls are
 * intercepted and answered by stub-apis.mjs from captured real datasets, so
 * runs are offline-deterministic.
 *
 *   node tests/harness/run-matrix.mjs                    # full matrix
 *     --games=pokemon,riftbound   --degradations=clean,glare
 *     --photos            also run the real-photo cells (tests/harness/photos)
 *     --photos-only       run ONLY those
 *     --binders           also grade the binder pages (multi-card detect+ID)
 *     --binders-only      run ONLY those
 *     --clips             also run the video-frame clips (the LIVE-scan path)
 *     --clips-only        run ONLY those
 *     --keys=tauros-fa-secret     --mode=hinted|auto|both
 *     --pages=3                   # parallel browser pages
 *     --out=tests/harness/report/run.json
 *     --baseline=path.json        # exit 1 on any per-game pass-rate regression
 *     --min-rate=0.0              # exit 1 if a game's overall rate dips below
 *
 * Fixtures come from tests/harness/fixtures (see fetch-fixtures.mjs); in
 * sandboxes without open internet pull the machine-generated branch
 * (git archive: unlike a --work-tree checkout it leaves the index alone):
 *   git fetch origin harness-fixtures
 *   git archive origin/harness-fixtures | tar -x -C tests/harness/fixtures
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createStubs } from './stub-apis.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const FIXTURES = process.env.HARNESS_FIXTURES ?? join(HERE, 'fixtures')
const PORT = Number(process.env.HARNESS_PORT ?? 5197)

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)

/**
 * `--gemini` turns on the opt-in cloud rescue for the run, using a REAL key and
 * REAL API traffic — the only non-stub egress this harness ever allows.
 *
 * The key comes from the environment, never from a flag: an argv value lands in
 * shell history and in the process table. Cost is a fraction of a cent per
 * rescued frame, but a full matrix is hundreds of misses, so this is off by
 * default and the run prints what it spent.
 */
const cloudKey = args.gemini ? (process.env.GEMINI_API_KEY ?? '').trim() : ''
/** Empty = the harness's own pinned CLOUD_SCAN_MODEL below; set it to A/B a model. */
const cloudModel = typeof args['gemini-model'] === 'string' ? args['gemini-model'] : ''
/** Why a bridged cloud call produced nothing — surfaced so a run of zero
 * useful answers cannot be mistaken for "the model had no opinion". */
const cloudErrors = []

/**
 * The server half of the hosted rescue, mirrored for the bridge above.
 *
 * CLOUD_SCAN_MODEL mirrors the `GEMINI_SCAN_MODEL` default pinned in
 * `supabase/functions/scan-card/index.ts`, and SCAN_PROMPT is kept WORD FOR
 * WORD in step with `PROMPT` there — the prompt's only real copy now that the
 * BYO-key client in `gemini.ts` is gone. A prompt that drifts here measures a
 * different question from the one the app asks, which is worse than not
 * measuring at all.
 */
const CLOUD_SCAN_MODEL = (process.env.GEMINI_SCAN_MODEL ?? '').trim() || 'gemini-3.1-flash-lite'
const SCAN_PROMPT =
  'You are reading a trading card photograph for a collection app. ' +
  'Return the card NAME exactly as printed, including any suffix that is part of the name ' +
  "(ex, GX, V, VMAX, VSTAR) and any possessive prefix (\"Iono's\", \"Team Rocket's\"). " +
  'Also return the collector number and printed set total from the small collector line ' +
  '(for "055/086": number "055", printedTotal "086"), and the printed set code if visible. ' +
  'Magic cards print that line as two rows in a bottom corner — "0321 U" over "MSH★EN" — ' +
  'giving number "0321" and setCode "MSH", with no printed total to return. Its separator ' +
  'is sometimes a star (★) rather than a dot (•), and its number is sometimes higher than the set ' +
  'actually holds; both mark a special printing, so transcribe the digits exactly as they ' +
  'appear and do not normalise them. On full-art and borderless cards this line is printed ' +
  'over the artwork in small light or dark type close to the card edge — look for it there too. ' +
  'Then judge the FRAME and return treatment: "borderless" when the artwork runs to the card ' +
  'edges with no border at all, "extended" when a thin border remains but the art reaches the ' +
  'sides, "showcase" for an alternate stylised frame, "retro" for an old-style frame, ' +
  '"regular" for the ordinary modern frame; and foil: true only when the surface clearly ' +
  'shows holographic shine. Those two describe the printing rather than transcribe it, so ' +
  'answer them only when the card is clearly enough visible to judge. ' +
  'CRITICAL: omit any field you cannot actually read on the card. Never guess a number. ' +
  'An omitted field is correct; an invented one is not.'
const SCAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' },
    number: { type: 'STRING' },
    printedTotal: { type: 'STRING' },
    setCode: { type: 'STRING' },
    game: { type: 'STRING' },
    treatment: { type: 'STRING' },
    foil: { type: 'BOOLEAN' },
  },
  required: ['name'],
}
let cloudCalls = 0
if (args.gemini && !cloudKey) {
  console.error('--gemini needs GEMINI_API_KEY in the environment (not as a flag — argv leaks into history).')
  process.exit(2)
}
const list = (v) => (typeof v === 'string' && v.length ? v.split(',') : null)

function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH
  const candidates = ['/opt/pw-browsers/chromium']
  for (const c of candidates) if (existsSync(c)) return c
  try {
    return chromium.executablePath()
  } catch {
    throw new Error('No Chromium found — set CHROMIUM_PATH')
  }
}

const normName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function similarity(a, b) {
  const na = normName(a)
  const nb = normName(b)
  if (!na.length || !nb.length) return 0
  if (na === nb) return 1
  const lev = (x, y) => {
    let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
    let next = new Array(y.length + 1)
    for (let i = 1; i <= x.length; i++) {
      next[0] = i
      for (let j = 1; j <= y.length; j++) {
        next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
      }
      ;[prev, next] = [next, prev]
    }
    return prev[y.length]
  }
  return 1 - lev(na, nb) / Math.max(na.length, nb.length)
}

/** Did the pipeline land on the right card? Right GAME, and the name exact
 * (normalized) or ≥0.9 — a confident hit in the wrong game is a failure.
 * Non-Latin names (Japanese fixtures) normalize to nothing, so raw string
 * equality answers first. */
function graded(expected, outcome) {
  if (!outcome?.ok) return false
  if (outcome.game && outcome.game !== expected.game) return false
  if (String(outcome.name ?? '') === String(expected.name)) return true
  return similarity(expected.name, outcome.name) >= 0.9
}

/**
 * Did it land on the fixture's own PRINTING, not merely the right card?
 *
 * Reported beside the pass rate rather than folded into it, on purpose. The
 * pass gate is a name gate and every stored baseline was measured against it;
 * quietly making it stricter would move every number at once and make the
 * before/after comparison this harness exists for meaningless. But the two
 * questions are genuinely different, and only one of them was ever asked:
 * "Dragon Spirit of White" filed as MP17-EN010 when the card in the hand is
 * LCKC-EN018 is the right card at the wrong rarity — a Secret Rare priced as
 * a $0.12 reprint, added to a collection at that price.
 *
 * Returns null when the question cannot be asked (cell failed, no ground
 * truth number, source returned no number) — those are not wrong answers and
 * must not be counted as either.
 */
function printingOf(cell, outcome) {
  if (!outcome?.ok || !outcome.number) return null
  const truth = cell.photo || !REPLICA_ART_GAMES.has(cell.fixture.game) ? cell.fixture.number : null
  if (!truth) return null
  return sameNumber(truth, outcome.number) ? 'ok' : 'wrong'
}

/**
 * Games whose FIXTURE images cannot answer the printing question, because the
 * source doesn't ship photographs of the printing.
 *
 * YGOPRODeck serves rendered replicas stamped "Replica - Not For Use in
 * Sanctioned Tournaments": correct art, correct text, and **no set code and no
 * passcode printed anywhere on them**. So every Yu-Gi-Oh fixture cell would
 * score as the wrong printing no matter what the pipeline did, which is a
 * statement about the fixture and not about the code (lesson: suspect the
 * harness too). Real photographs under tests/harness/photos/ are the only
 * Yu-Gi-Oh evidence that can answer it — and they are exempt from this, being
 * photographs of actual cards.
 */
const REPLICA_ART_GAMES = new Set(['yugioh'])

/**
 * Compare two printed numbers across the shapes the games use: a set-prefixed
 * code ("LCKC-EN018", region infix and padding optional) or a bare collector
 * number, with or without its "/298" set size.
 */
function sameNumber(a, b) {
  const code = (value) => {
    const m = String(value).toUpperCase().replace(/\s+/g, '').match(/^([A-Z][A-Z0-9]{0,7})-?(?:[A-Z]{2})?0*(\d{1,4})([A-Z]?)$/)
    return m ? `${m[1]}-${m[2]}${m[3]}` : null
  }
  const ca = code(a)
  if (ca || code(b)) return ca === code(b)
  const digits = (value) => String(value).split('/')[0].replace(/\D+/g, '').replace(/^0+(?=\d)/, '')
  return !!digits(a) && digits(a) === digits(b)
}

/**
 * Grade a binder page against an unordered MULTISET of names.
 *
 * A page is a different kind of ground truth from a card and must never be
 * collapsed into one: the page has no "the" answer, three copies of a card
 * mean three slots, and detection and identification fail independently — a
 * card that was never FOUND and a card that was found and misread need
 * different fixes. So this reports three numbers, and the one to watch is the
 * third: on a page, a wrong card is nine times more expensive than in single
 * scanning, because it arrives inside a batch the user confirms once.
 *
 * Greedy best-first assignment against the remaining truth, at the same 0.9
 * name-similarity bar single cells are graded at.
 *
 * Known limit, and it matters most on exactly the page committed here: an
 * unordered multiset cannot tell a correct read of a DUPLICATE from a wrong
 * read that happens to name one. This page holds 3 copies of "Imsety, Glory of
 * Horus" and 2 of "King's Sarcophagus"; if only 2 Imsety regions identify, a
 * sibling misread as "Imsety" fills the spare slot, scores as identified, and
 * the real card is reported missed — a wrong card re-attributed to the
 * detector. Separating those needs PER-REGION ground truth (which slot holds
 * which card), which is a different manifest shape. Until then, read `missed`
 * on a page with duplicates as an upper bound on detection failures, and look
 * at the boxes.
 */
function gradePage(truth, found) {
  const remaining = truth.slice()
  const identified = found.filter((f) => f.outcome?.ok)
  const pairs = []
  for (const hit of identified) {
    for (let i = 0; i < remaining.length; i++) {
      pairs.push({ hit, i, score: String(hit.outcome.name) === String(remaining[i]) ? 1 : similarity(remaining[i], hit.outcome.name) })
    }
  }
  pairs.sort((a, b) => b.score - a.score)
  const usedTruth = new Set()
  const usedHit = new Set()
  const matched = []
  for (const pair of pairs) {
    if (pair.score < 0.9 || usedTruth.has(pair.i) || usedHit.has(pair.hit)) continue
    usedTruth.add(pair.i)
    usedHit.add(pair.hit)
    matched.push({ name: remaining[pair.i], read: pair.hit.outcome.name })
  }
  // Identified confidently, matches nothing left on the page: the expensive
  // class. A card the detector found twice would land here too, which is
  // correct — a duplicate row is a wrong row in a batch the user confirms once.
  const wrong = identified
    .filter((h) => !usedHit.has(h))
    .map((h) => ({ read: h.outcome.name, game: h.outcome.game }))
  return {
    truth: truth.length,
    detected: found.length,
    identified: matched.length,
    wrong,
    missed: remaining.filter((_, i) => !usedTruth.has(i)),
  }
}

/** Attribute a failed cell to the stage that lost it, from the trace. */
function failureStage(expected, result) {
  const { outcome, trace } = result
  if (outcome?.ok) return 'wrong-card'
  if (outcome?.reason === 'exception') return 'exception'
  if (outcome?.reason === 'api') return 'api-error'
  const events = trace?.events ?? []
  const candidates = events.flatMap((e) => (e.stage === 'ocr-band' || e.stage === 'ocr-anywhere' ? (e.candidates ?? []) : []))
  if (!candidates.length) return 'ocr-noread'
  const readRight = candidates.some((c) => similarity(c, expected.name) >= 0.75 || leadSimilar(c, expected.name))
  const lookups = events.filter((e) => e.stage === 'lookup')
  const bestScore = Math.max(0, ...lookups.map((e) => e.score ?? 0))
  if (readRight) return bestScore > 0 ? 'match-low' : 'match-none'
  return 'ocr-misread'
}

/** OCR often reads just the big leading segment ("JINX") of a split name. */
function leadSimilar(read, cardName) {
  const lead = String(cardName).split(/,|:|\s[-–—]\s/)[0]?.trim()
  return lead && lead.length >= 3 ? similarity(read, lead) >= 0.75 : false
}

async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function main() {
  if (!existsSync(join(FIXTURES, 'manifest.json'))) {
    console.error(`No fixtures at ${FIXTURES}.\nRun tests/harness/fetch-fixtures.mjs (open internet) or pull the harness-fixtures branch:`)
    console.error('  git fetch origin harness-fixtures')
    console.error('  mkdir -p tests/harness/fixtures && git archive origin/harness-fixtures | tar -x -C tests/harness/fixtures')
    process.exit(2)
  }
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
  const stubs = createStubs(FIXTURES)

  const gamesFilter = list(args.games)
  const keysFilter = list(args.keys)
  const degFilter = list(args.degradations)
  const mode = args.mode ?? 'both'
  const pages = Math.max(1, Number(args.pages ?? 3))

  /** Auto-mode only makes sense for games the unhinted sweep covers. */
  const AUTO_GAMES = new Set(['mtg', 'pokemon', 'yugioh', 'lorcana'])
  const AUTO_DEGRADATIONS = new Set(['clean', 'soft-focus', 'glare'])

  // --photos runs the photo cells IN ADDITION to the battery; --photos-only
  // runs just them (the fast loop when new photos land). Declared HERE, above
  // the first read of it: below the fixture filter it was a temporal-dead-zone
  // crash for `--binders-only --keys=<a binder>`, which is the natural way to
  // iterate on one page.
  const photosOnly = !!args['photos-only'] || !!args['binders-only'] || !!args['clips-only']

  const fixtures = manifest.fixtures.filter(
    (f) => (!gamesFilter || gamesFilter.includes(f.game)) && (!keysFilter || keysFilter.includes(f.key)),
  )
  if (!fixtures.length && !photosOnly) {
    console.error('Nothing matches the filters.')
    process.exit(2)
  }

  // Cell list: hinted runs for everything; auto runs for a subset. Fixtures
  // marked hintedOnly (foreign-language prints — auto mode has no
  // collector-line rescue by design) never get auto cells.
  // An explicit --degradations filter may also select the opt-in extras
  // (dim/dark); the default battery stays the standard, comparable set.
  const cells = []
  const degradations = (all) =>
    degFilter ? [...all, ...EXTRA_DEGRADATION_KEYS].filter((d) => degFilter.includes(d)) : all
  for (const fixture of photosOnly ? [] : fixtures) {
    const imageUrl = `/tests/harness/fixtures/${fixture.image}`
    for (const degradation of degradations(DEGRADATION_KEYS)) {
      if (mode !== 'auto') cells.push({ fixture, degradation, hint: fixture.game, imageUrl })
      if (mode !== 'hinted' && AUTO_GAMES.has(fixture.game) && AUTO_DEGRADATIONS.has(degradation) && !fixture.hintedOnly) {
        cells.push({ fixture, degradation, hint: 'auto', imageUrl })
      }
    }
  }
  // Photo cells: real photographs, graded against a hand-written manifest.
  //
  // They exist because every fixture is a flat SCAN. TCGplayer and TCGdex
  // both shoot cards flat and evenly lit, which is what kills the diffraction
  // a phone sees live — so the foil degradations are a MODEL of foil, and a
  // model can only ever confirm the failure it was built to show. A real
  // photo is the only evidence that the model is honest.
  //
  // Two consequences shape the plumbing. A photo already contains the camera
  // degradation, so it bypasses compose() entirely (see page.html). And it
  // cannot be machine-regenerated, so it CANNOT live on harness-fixtures,
  // which CI force-pushes — these are committed under tests/harness/photos/
  // with their ground truth beside them.
  if (args.photos || args['photos-only']) {
    const dir = join(HERE, 'photos')
    const file = join(dir, 'manifest.json')
    if (!existsSync(file)) {
      console.error(`No photo manifest at ${file} — see tests/harness/photos/README.md`)
      process.exit(2)
    }
    const photos = JSON.parse(readFileSync(file, 'utf8')).photos ?? []
    if (!photos.length) {
      console.log(`No photos yet in ${dir} — see its README for how to add one.`)
    }
    for (const photo of photos) {
      if (gamesFilter && !gamesFilter.includes(photo.game)) continue
      if (keysFilter && !keysFilter.includes(photo.key)) continue
      cells.push({
        // `number` is the printed set/collector code, when the manifest
        // records one — a photograph of a real card is the only Yu-Gi-Oh
        // ground truth that can answer the printing question at all.
        fixture: { game: photo.game, key: photo.key, name: photo.name, number: photo.number ?? null },
        degradation: photo.label ?? 'photo',
        hint: photo.game,
        imageUrl: `/tests/harness/photos/${photo.file}`,
        photo: true,
      })
    }
  }

  // Binder pages: the multi-card path end to end — detectCardRegions, a crop
  // and a full identification per region. Kept OUT of `cells` because the
  // per-game battery rates are a like-for-like series and a page is not a
  // cell; it is graded against a multiset and reported on its own.
  const binderCells = []
  if (args.binders || args['binders-only']) {
    const file = join(HERE, 'photos', 'manifest.json')
    if (!existsSync(file)) {
      console.error(`No photo manifest at ${file} — see tests/harness/photos/README.md`)
      process.exit(2)
    }
    for (const binder of JSON.parse(readFileSync(file, 'utf8')).binders ?? []) {
      if (gamesFilter && !gamesFilter.includes(binder.game)) continue
      if (keysFilter && !keysFilter.includes(binder.key)) continue
      binderCells.push(binder)
    }
    if (!binderCells.length) console.log('No binder pages match the filters.')
  }

  // Video clips: the LIVE-scan path, which nothing else here can reach.
  // Every other input is a still — the fixtures are flat scans, the
  // degradations compose onto a clean backdrop, and a photograph is one
  // exposure through the phone's PHOTO pipeline. A clip is the only sample of
  // what the scanner actually grabs, and the only place the specular pattern
  // MOVES between one candidate capture and the next.
  const clipCells = []
  if (args.clips || args['clips-only']) {
    const file = join(HERE, 'photos', 'manifest.json')
    if (!existsSync(file)) {
      console.error(`No photo manifest at ${file}`)
      process.exit(2)
    }
    for (const clip of JSON.parse(readFileSync(file, 'utf8')).clips ?? []) {
      if (gamesFilter && !gamesFilter.includes(clip.game)) continue
      if (keysFilter && !keysFilter.includes(clip.key)) continue
      clipCells.push(clip)
    }
    if (!clipCells.length) console.log('No clips match the filters.')
  }

  if (!cells.length && !binderCells.length && !clipCells.length) {
    console.error('Nothing matches the filters.')
    process.exit(2)
  }
  console.log(
    `${cells.length} cells on ${pages} page(s)` +
      `${binderCells.length ? ` + ${binderCells.length} binder page(s)` : ''}` +
      `${clipCells.length ? ` + ${clipCells.length} clip(s)` : ''}\n`,
  )

  // --- dev server -----------------------------------------------------------
  // `--host 127.0.0.1` is not decoration: vite's default binds the loopback
  // NAME, so on a machine where `localhost` resolves to ::1 nothing listens on
  // 127.0.0.1 — and every URL below is written against that literal. Without
  // it the run dies on the readiness probe's timeout, blaming the dev server.
  const vite = spawn(
    'node',
    [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  )
  let viteLog = ''
  vite.stdout.on('data', (d) => (viteLog += d))
  vite.stderr.on('data', (d) => (viteLog += d))
  const stopVite = () => {
    try {
      vite.kill('SIGTERM')
    } catch { /* gone */ }
  }
  process.on('exit', stopVite)

  let browser
  try {
    await waitFor(`http://127.0.0.1:${PORT}/tests/harness/page.html`)

    // --- browser ------------------------------------------------------------
    browser = await chromium.launch({
      executablePath: findChromium(),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    const context = await browser.newContext({ viewport: { width: 900, height: 1400 } })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith(`http://localhost:${PORT}/`)) return route.continue()
      // The ONE host allowed off the stub network, and only when --gemini gave
      // us a real key. There is no useful way to stub a cloud rescue: a canned
      // answer would measure the fixture, not the model. So this route is real
      // traffic, it costs real money (~$0.0004 a call), and it is off unless
      // asked for — which is why every other host still aborts.
      if (cloudKey && url.startsWith('https://generativelanguage.googleapis.com/')) {
        cloudCalls++
        return route.continue()
      }
      // The HOSTED rescue's edge function, bridged straight to Gemini.
      //
      // The app has exactly one cloud route left: `readCardHosted` POSTs the
      // frame to our own `scan-card`, which holds the key and checks
      // entitlement. The harness cannot call that — it would need a real
      // account, a live entitlement row and a token that expires mid-run — so
      // this stands in for the server half ONLY: same prompt, same schema, same
      // pinned model, same response shape, real traffic to the real model.
      //
      // What that measures and what it does not, stated plainly: everything in
      // `identify.ts` is exercised for real — the arming checks, the race, the
      // thresholds, `relatedNames`, the tie-break's guards and the merge. Auth,
      // entitlement and the monthly meter are NOT, because the function they
      // live in is the part being stood in for. A green run here says the model
      // and the pipeline agree; it says nothing about whether a given user is
      // owed the call.
      if (cloudKey && /\/functions\/v1\/scan-card$/.test(url)) {
        cloudCalls++
        let body = null
        try {
          const sent = JSON.parse(route.request().postData() ?? '{}')
          if (!sent?.image) throw new Error('no image')
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${cloudModel || CLOUD_SCAN_MODEL}:generateContent`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cloudKey },
              body: JSON.stringify({
                contents: [{ parts: [{ text: SCAN_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: sent.image } }] }],
                // maxOutputTokens is load-bearing: a low cap makes a thinking
                // model burn its budget and return an empty body at full price.
                generationConfig: {
                  temperature: 0,
                  maxOutputTokens: 2000,
                  responseMimeType: 'application/json',
                  responseSchema: SCAN_SCHEMA,
                },
              }),
            },
          )
          if (res.ok) {
            const raw = await res.json()
            const text = raw?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
            const parsed = JSON.parse(text)
            if (parsed?.name) body = { ...parsed, remaining: 999 }
          } else {
            cloudErrors.push(`gemini ${res.status}`)
          }
        } catch (err) {
          cloudErrors.push(String(err).slice(0, 120))
        }
        // A refusal must look to the client exactly like the edge function's
        // own — non-200, no explanation. `readCardHosted` maps every failure to
        // null, and the pipeline must fall through to the local answer.
        return body
          ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
          : route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"unreadable"}' })
      }
      const hit = stubs.handle(url, route.request())
      if (hit) return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body })
      return route.abort('failed')
    })

    const freshPage = async (i) => {
      const page = await context.newPage()
      if (args.verbose) page.on('console', (msg) => console.log(`  [page${i}]`, msg.text().slice(0, 200)))
      page.on('pageerror', (err) => console.error(`  [page${i}] pageerror:`, String(err).slice(0, 300)))
      await page.goto(`http://127.0.0.1:${PORT}/tests/harness/page.html`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__harness != null, { timeout: 20_000 })
      await page.evaluate(() => window.__harness.warm())
      return page
    }
    const workers = []
    for (let i = 0; i < pages; i++) workers.push(await freshPage(i))

    // --- run ----------------------------------------------------------------
    const results = []
    let next = 0
    const t0 = Date.now()
    await Promise.all(
      workers.map(async (page, i) => {
        while (next < cells.length) {
          const at = next++
          const cell = cells[at]
          const run = (p) =>
            p.evaluate(
              (c) => window.__harness.runCell(c),
              {
                imageUrl: cell.imageUrl,
                degradation: cell.degradation,
                hint: cell.hint,
                cloudKey,
                game: cell.fixture.game,
                photo: cell.photo ?? false,
                stack: Number(args.stack) || 1,
              },
            )
          let result
          try {
            result = await run(page)
          } catch (err) {
            // A crashed renderer (OOM under Tesseract WASM) takes __harness
            // with it, and this worker would fail every remaining cell in 0ms.
            // Stand up a fresh page and retry the cell once before recording.
            console.error(`  [page${i}] harness page lost — recreating (${String(err).slice(0, 140)})`)
            try {
              await page.close().catch(() => {})
              page = await freshPage(i)
              result = await run(page)
            } catch (err2) {
              result = { outcome: { ok: false, reason: 'exception', message: String(err2).slice(0, 300) }, ms: 0, trace: null }
            }
          }
          const pass = graded(cell.fixture, result.outcome)
          const stage = pass ? 'pass' : failureStage(cell.fixture, result)
          results.push({
            game: cell.fixture.game,
            key: cell.fixture.key,
            expected: cell.fixture.name,
            expectedNumber: cell.fixture.number ?? null,
            degradation: cell.degradation,
            hint: cell.hint,
            pass,
            printing: printingOf(cell, result.outcome),
            stage,
            ms: result.ms,
            outcome: result.outcome,
            trace: result.trace,
          })
          const mark = pass ? '✓' : '✗'
          console.log(
            `  ${mark} ${cell.fixture.game}/${cell.fixture.key} · ${cell.degradation} · ${cell.hint}` +
              ` → ${result.outcome.ok ? result.outcome.name : `${stage}${result.outcome.readName ? ` (read “${result.outcome.readName}”)` : ''}`}` +
              ` [${result.ms}ms]`,
          )
        }
      }),
    )
    // Clips run after the battery. Each frame is a separate identification, so
    // a clip is ~20 of them; they share one page for the same reason binder
    // pages do.
    const clipResults = []
    for (const clip of clipCells) {
      const page = workers[0]
      const url = (f) => `/tests/harness/photos/${clip.dir}/${f.file}`
      const one = async (urls) => {
        try {
          return await page.evaluate((c) => window.__harness.runFrames(c), {
            imageUrls: urls,
            hint: clip.game,
            cloudKey,
          })
        } catch (err) {
          return { outcome: { ok: false, reason: 'exception', message: String(err).slice(0, 200) }, ms: 0 }
        }
      }
      const singles = []
      for (const f of clip.frames) {
        const r = await one([url(f)])
        singles.push({ ...f, pass: graded(clip, r.outcome), name: r.outcome.ok ? r.outcome.name : null,
                       read: r.outcome.readName ?? null, ms: r.ms })
      }
      // One stacked capture per burst, from the same consecutive frames — the
      // question is whether averaging beats the BEST frame in that burst, not
      // whether it beats the average frame.
      const stacks = []
      for (let b = 0; b < (clip.bursts ?? 0); b++) {
        const urls = clip.frames.filter((f) => f.burst === b).map(url)
        if (urls.length < 2) continue
        const r = await one(urls)
        const bestSingle = singles.filter((s) => s.burst === b).some((s) => s.pass)
        stacks.push({ burst: b, pass: graded(clip, r.outcome), bestSingle,
                      name: r.outcome.ok ? r.outcome.name : null, read: r.outcome.readName ?? null, ms: r.ms })
      }
      // A frame that identified CONFIDENTLY but wrongly. This is the class the
      // clips exist to expose: the standard battery reports zero wrong cards,
      // and real video frames of an ordinary "ex" card produce them readily,
      // because a dropped two-letter suffix leaves a name that matches a
      // different, real, far cheaper card exactly.
      const wrong = singles.filter((s) => !s.pass && s.name).map((s) => ({ at: `b${s.burst}-${s.within}`, got: s.name }))
      const stackWrong = stacks.filter((s) => !s.pass && s.name).map((s) => ({ at: `stack-b${s.burst}`, got: s.name }))
      const framePass = singles.filter((s) => s.pass).length
      const burstAny = stacks.filter((s) => s.bestSingle).length
      const stackPass = stacks.filter((s) => s.pass).length
      clipResults.push({ key: clip.key, game: clip.game, name: clip.name, note: clip.note,
                         frames: singles, stacks, framePass, frameTotal: singles.length, stackPass, burstAny,
                         wrong: [...wrong, ...stackWrong] })
      console.log(
        `  ▶ ${clip.game}/${clip.key} · frames ${framePass}/${singles.length}` +
          ` · bursts with a readable frame ${burstAny}/${stacks.length}` +
          ` · stacked ${stackPass}/${stacks.length}`,
      )
      if (wrong.length || stackWrong.length) {
        for (const w of [...wrong, ...stackWrong]) console.log(`      WRONG CARD @${w.at}: “${w.got}”`)
      }
      const reads = singles.filter((s) => !s.pass && !s.name && s.read).slice(0, 3).map((s) => `“${s.read}”`)
      if (reads.length) console.log(`      misreads: ${reads.join(', ')}`)
    }

    // Binder pages run after the battery, one at a time on a single page: each
    // is ~9 identifications sharing one OCR worker pool, so racing them would
    // contend rather than finish sooner — the same reason scanPage is
    // sequential on the phone.
    const binderResults = []
    for (const binder of binderCells) {
      const page = workers[0]
      let out
      try {
        out = await page.evaluate((c) => window.__harness.runPage(c), {
          imageUrl: `/tests/harness/photos/${binder.file}`,
          hint: binder.game,
          photo: true,
        })
      } catch (err) {
        out = { found: [], ms: 0, error: String(err).slice(0, 200) }
      }
      const score = gradePage(binder.cards ?? [], out.found ?? [])
      binderResults.push({ key: binder.key, game: binder.game, note: binder.note, ms: out.ms, error: out.error, ...score,
        found: (out.found ?? []).map((f) => ({ region: f.region, ok: !!f.outcome?.ok, name: f.outcome?.ok ? f.outcome.name : null, stage: f.outcome?.ok ? 'pass' : f.outcome?.reason, readName: f.outcome?.readName ?? null })) })
      console.log(
        `  ▣ ${binder.game}/${binder.key} · boxes ${score.detected} (truth ${score.truth} cards)` +
          ` · identified ${score.identified}/${score.truth}` +
          ` · WRONG ${score.wrong.length}${out.error ? ` · ${out.error}` : ''} [${out.ms}ms]`,
      )
      for (const w of score.wrong) console.log(`      wrong: “${w.read}”`)
      if (score.missed.length) console.log(`      missed: ${score.missed.map((m) => `“${m}”`).join(', ')}`)
    }

    const wallMs = Date.now() - t0

    // --- report -------------------------------------------------------------
    const byGame = {}
    for (const r of results) {
      const g = (byGame[r.game] ??= {
        pass: 0,
        total: 0,
        stages: {},
        byDegradation: {},
        // Printing counters ride the report so a stored baseline can be gated
        // on them. Older baselines predate these fields, so every comparison
        // recomputes from `cells` rather than trusting them to exist.
        printingOk: 0,
        printingAsked: 0,
        printingClaimed: 0,
      })
      g.total++
      if (r.pass) g.pass++
      else g.stages[r.stage] = (g.stages[r.stage] ?? 0) + 1
      if (r.printing) {
        g.printingAsked++
        if (r.printing === 'ok') g.printingOk++
        else if (r.outcome?.pinned) g.printingClaimed++
      }
      const d = (g.byDegradation[r.degradation] ??= { pass: 0, total: 0 })
      d.total++
      if (r.pass) d.pass++
    }
    const overall = { pass: results.filter((r) => r.pass).length, total: results.length }
    const report = {
      at: new Date().toISOString(),
      wallMs,
      args: { games: gamesFilter, keys: keysFilter, degradations: degFilter, mode, pages },
      overall,
      byGame,
      binders: binderResults,
      clips: clipResults,
      stubCalls: stubs.stats.calls,
      cloud: cloudKey ? { model: cloudModel || CLOUD_SCAN_MODEL, calls: cloudCalls, errors: cloudErrors } : null,
      unknownHosts: [...new Set(stubs.stats.unknown)],
      cells: results,
    }
    const out = typeof args.out === 'string' ? args.out : join(HERE, 'report', `run-${Date.now()}.json`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(report, null, 1))

    if (overall.total) {
      console.log(`\n=== ${overall.pass}/${overall.total} identified (${((overall.pass / overall.total) * 100).toFixed(0)}%) in ${(wallMs / 1000).toFixed(0)}s ===`)
    }
    const degradationsSeen = [...new Set(results.map((r) => r.degradation))]
    const pad = (s, n) => String(s).padEnd(n)
    if (degradationsSeen.length) console.log(pad('', 14) + degradationsSeen.map((d) => pad(d, 13)).join(''))
    for (const [game, g] of Object.entries(byGame)) {
      const row = degradationsSeen
        .map((d) => {
          const cellsOf = results.filter((r) => r.game === game && r.degradation === d)
          return pad(cellsOf.length ? `${cellsOf.filter((r) => r.pass).length}/${cellsOf.length}` : '—', 13)
        })
        .join('')
      console.log(pad(`${game} ${g.pass}/${g.total}`, 14) + row)
    }
    for (const [game, g] of Object.entries(byGame)) {
      const stages = Object.entries(g.stages).sort((a, b) => b[1] - a[1])
      if (stages.length) console.log(`  ${game} failures: ${stages.map(([s, n]) => `${s}×${n}`).join(', ')}`)
    }
    // Right card, wrong printing — invisible to the pass gate, and the reason
    // a scan can be graded "identified" while filing a Secret Rare at a
    // reprint's price.
    const asked = results.filter((r) => r.printing)
    if (asked.length) {
      const right = asked.filter((r) => r.printing === 'ok').length
      // A wrong printing the app KNOWS it guessed is honest (the sheet says
      // so and offers the picker); a wrong printing it believes it read is a
      // lie the user has no way to catch. Count them separately.
      const claimed = asked.filter((r) => r.printing === 'wrong' && r.outcome.pinned).length
      console.log(`\n=== printing: ${right}/${asked.length} identified cells landed on the fixture's own printing` +
        ` · ${claimed} wrong while claiming the code was read ===`)
      for (const game of [...new Set(asked.map((r) => r.game))]) {
        const of = asked.filter((r) => r.game === game)
        console.log(`  ${pad(game, 11)} ${of.filter((r) => r.printing === 'ok').length}/${of.length}`)
      }
    }
    if (clipResults.length) {
      const t = clipResults.reduce(
        (a, c) => ({ fp: a.fp + c.framePass, ft: a.ft + c.frameTotal, sp: a.sp + c.stackPass, ba: a.ba + c.burstAny,
                     sn: a.sn + c.stacks.length }),
        { fp: 0, ft: 0, sp: 0, ba: 0, sn: 0 },
      )
      const cw = clipResults.reduce((n, c) => n + c.wrong.length, 0)
      console.log(
        `\n=== clips: ${t.fp}/${t.ft} frames identify · ${t.ba}/${t.sn} bursts contain a readable frame` +
          ` · stacking ${t.sp}/${t.sn} · WRONG ${cw} ===`,
      )
      // The gap between the middle number and the first is what frame
      // SELECTION is worth; the gap between the last and the middle is what
      // temporal STACKING is worth. Both are properties of the app, not of the
      // OCR.
    }
    if (binderResults.length) {
      const t = binderResults.reduce(
        (a, b) => ({ truth: a.truth + b.truth, detected: a.detected + b.detected, identified: a.identified + b.identified, wrong: a.wrong + b.wrong.length }),
        { truth: 0, detected: 0, identified: 0, wrong: 0 },
      )
      console.log(
        `\n=== binder pages: ${t.detected} boxes · identified ${t.identified}/${t.truth} · WRONG ${t.wrong} ===`,
      )
    }
    if (cloudKey) {
      // Print the spend. A rescue only fires on a local miss, so this number is
      // also the honest count of frames the on-device pipeline could not read.
      // Per-call cost is measured, not guessed: a 1600px card bills ~1,115
      // input tokens (1,100 image + 15 prompt) and ~53 output.
      const PRICE = {
        'gemini-3.1-flash-lite': [0.25, 1.5],
        'gemini-3.5-flash-lite': [0.3, 2.5],
        'gemini-3.7-flash': [0.75, 3.75],
        'gemini-3.6-flash': [0.75, 3.75],
        'gemini-3.5-flash': [1.5, 9.0],
      }
      // Empty cloudModel means the harness's own pinned CLOUD_SCAN_MODEL.
      const [inUsd, outUsd] = PRICE[cloudModel || CLOUD_SCAN_MODEL] ?? [0.25, 1.5]
      const each = (1115 / 1e6) * inUsd + (53 / 1e6) * outUsd
      console.log(
        `\n=== cloud rescue: ${cloudCalls} call(s) to ${cloudModel || CLOUD_SCAN_MODEL}` +
          ` · ~$${(cloudCalls * each).toFixed(4)} ($${each.toFixed(5)}/call) ===`,
      )
      // Zero calls means the cloud path was never REACHED, which reads exactly
      // like "the model changed nothing" on a summary line and is the trap
      // lesson 55 names. Say so loudly rather than letting the run be read as
      // evidence about the model.
      if (!cloudCalls) {
        console.error('  CLOUD NEVER FIRED — --gemini was set but no call was made.')
        console.error('  This measures NOTHING about the cloud path. Check the arming gate')
        console.error('  (isSignedIn) and the /functions/v1/scan-card interception.')
      }
      if (cloudErrors.length) {
        const tally = {}
        for (const e of cloudErrors) tally[e] = (tally[e] ?? 0) + 1
        console.log(`  cloud failures: ${Object.entries(tally).map(([e, n]) => `${e}×${n}`).join(', ')}`)
      }
    }
    if (report.unknownHosts.length) console.log(`  unstubbed hosts hit: ${report.unknownHosts.join(', ')}`)
    console.log(`  report: ${out}`)

    // --- assertions ---------------------------------------------------------
    // The regression gate compares per-game rates over the KEYS both runs
    // share — new fixtures (added cards, foreign-language prints) must not
    // read as a pipeline regression, nor mask one.
    let bad = false
    if (typeof args.baseline === 'string') {
      const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'))
      const baselineCells = Array.isArray(baseline.cells) ? baseline.cells : null
      const rateOverSharedKeys = (game) => {
        if (!baselineCells) return null
        const keysThen = new Set(baselineCells.filter((c) => c.game === game).map((c) => c.key))
        const nowCells = results.filter((r) => r.game === game && keysThen.has(r.key))
        const thenCells = baselineCells.filter((c) => c.game === game && results.some((r) => r.game === game && r.key === c.key))
        if (!nowCells.length || !thenCells.length) return null
        return {
          now: nowCells.filter((r) => r.pass).length / nowCells.length,
          then: thenCells.filter((c) => c.pass).length / thenCells.length,
        }
      }
      for (const [game, g] of Object.entries(byGame)) {
        const b = baseline.byGame?.[game]
        if (!b?.total) continue
        const shared = rateOverSharedKeys(game)
        const now = shared?.now ?? g.pass / g.total
        const then = shared?.then ?? b.pass / b.total
        if (now + 1e-9 < then) {
          console.error(`REGRESSION: ${game} ${(then * 100).toFixed(0)}% → ${(now * 100).toFixed(0)}%${shared ? ' (shared keys)' : ''}`)
          bad = true
        }
      }
      // Printing regression, gated SEPARATELY from the pass rate.
      //
      // Folding printing into the pass gate would move every stored baseline
      // at once and destroy the before/after comparison this harness exists
      // for (lesson 62) — so it stays its own number. But leaving it ungated
      // meant a change could improve the name rate while halving printing
      // accuracy and still exit 0, which is exactly the shape of regression
      // the printing work is meant to prevent.
      //
      // Recomputed from `cells` on both sides: baselines written before the
      // per-game printing counters existed still carry `cells[].printing`.
      const printingOverSharedKeys = (game) => {
        if (!baselineCells) return null
        const keysThen = new Set(baselineCells.filter((c) => c.game === game).map((c) => c.key))
        const keysNow = new Set(results.filter((r) => r.game === game).map((r) => r.key))
        const nowAsked = results.filter((r) => r.game === game && r.printing && keysThen.has(r.key))
        const thenAsked = baselineCells.filter((c) => c.game === game && c.printing && keysNow.has(c.key))
        if (!nowAsked.length || !thenAsked.length) return null
        return {
          now: nowAsked.filter((r) => r.printing === 'ok').length / nowAsked.length,
          then: thenAsked.filter((c) => c.printing === 'ok').length / thenAsked.length,
          // A wrong printing the app KNOWS it guessed is honest; one it
          // believes it read is a lie the user cannot catch. Never let that
          // class grow, even if the overall printing rate improves.
          claimedNow: nowAsked.filter((r) => r.printing === 'wrong' && r.outcome?.pinned).length,
          claimedThen: thenAsked.filter((c) => c.printing === 'wrong' && c.outcome?.pinned).length,
        }
      }
      for (const game of Object.keys(byGame)) {
        const p = printingOverSharedKeys(game)
        if (!p) continue
        if (p.now + 1e-9 < p.then) {
          console.error(`PRINTING REGRESSION: ${game} ${(p.then * 100).toFixed(0)}% → ${(p.now * 100).toFixed(0)}% (shared keys)`)
          bad = true
        }
        if (p.claimedNow > p.claimedThen) {
          console.error(`PRINTING CLAIMED WORSE: ${game} ${p.claimedThen} → ${p.claimedNow} wrong while claiming the code was read`)
          bad = true
        }
      }
    }
    if (args['min-printing-rate'] != null) {
      const min = Number(args['min-printing-rate'])
      for (const [game, g] of Object.entries(byGame)) {
        if (!g.printingAsked) continue
        if (g.printingOk / g.printingAsked < min) {
          console.error(
            `BELOW MIN PRINTING RATE: ${game} ${((g.printingOk / g.printingAsked) * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}%`,
          )
          bad = true
        }
      }
    }
    // A wrong card on a page is the expensive failure class — it arrives inside
    // a batch the user confirms once — so it fails the run outright rather than
    // being a number in a summary nobody reads.
    // Clips gate on wrong cards only. The frame-identification RATE is
    // expected to be partial — that is the finding, not a failure — but a
    // confident wrong answer must never become normal.
    for (const c of clipResults) {
      for (const w of c.wrong) {
        console.error(`CLIP WRONG CARD: ${c.key} @${w.at} — “${w.got}” for “${c.name}”`)
      }
      if (c.wrong.length > Number(args['clip-wrong-allowed'] ?? 0)) bad = true
    }
    for (const b of binderResults) {
      if (b.error) {
        console.error(`BINDER ERROR: ${b.key} — ${b.error}`)
        bad = true
      }
      if (b.wrong.length) {
        console.error(`BINDER WRONG CARDS: ${b.key} — ${b.wrong.map((w) => `“${w.read}”`).join(', ')}`)
        bad = true
      }
    }
    if (args['min-rate'] != null) {
      const min = Number(args['min-rate'])
      for (const [game, g] of Object.entries(byGame)) {
        if (g.pass / g.total < min) {
          console.error(`BELOW MIN RATE: ${game} ${((g.pass / g.total) * 100).toFixed(0)}% < ${(min * 100).toFixed(0)}%`)
          bad = true
        }
      }
    }
    process.exit(bad ? 1 : 0)
  } catch (err) {
    console.error(err)
    console.error('\nlast vite output:\n' + viteLog.split('\n').slice(-15).join('\n'))
    process.exit(1)
  } finally {
    await browser?.close().catch(() => {})
    stopVite()
  }
}

/** The standard battery. dim/dark (harsh low light) are opt-in via
 * --degradations so per-game regression gates stay comparable across
 * reports that predate them. */
const DEGRADATION_KEYS = ['clean', 'small-offset', 'soft-focus', 'rot+5', 'rot-5', 'perspective', 'glare', 'lowlight', 'worst']
const EXTRA_DEGRADATION_KEYS = [
  'dim', 'dark', 'sideways', 'sideways-ccw',
  'foil', 'foil-worst', 'foil-text', 'foil-text-silver', 'foil-text-worst',
]

main()
