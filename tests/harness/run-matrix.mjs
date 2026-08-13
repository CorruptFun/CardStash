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
 *     --keys=tauros-fa-secret     --mode=hinted|auto|both
 *     --pages=3                   # parallel browser pages
 *     --out=tests/harness/report/run.json
 *     --baseline=path.json        # exit 1 on any per-game pass-rate regression
 *     --min-rate=0.0              # exit 1 if a game's overall rate dips below
 *
 * Fixtures come from tests/harness/fixtures (see fetch-fixtures.mjs); in
 * sandboxes without open internet pull the machine-generated branch:
 *   git fetch origin harness-fixtures
 *   git --work-tree=tests/harness/fixtures checkout origin/harness-fixtures -- .
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
 * (normalized) or ≥0.9 — a confident hit in the wrong game is a failure. */
function graded(expected, outcome) {
  if (!outcome?.ok) return false
  if (outcome.game && outcome.game !== expected.game) return false
  return similarity(expected.name, outcome.name) >= 0.9
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
    console.error('  git fetch origin harness-fixtures && git --work-tree=tests/harness/fixtures checkout origin/harness-fixtures -- .')
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

  const fixtures = manifest.fixtures.filter(
    (f) => (!gamesFilter || gamesFilter.includes(f.game)) && (!keysFilter || keysFilter.includes(f.key)),
  )
  if (!fixtures.length) {
    console.error('Nothing matches the filters.')
    process.exit(2)
  }

  // Cell list: hinted runs for everything; auto runs for a subset.
  const cells = []
  const degradations = (all) => (degFilter ? all.filter((d) => degFilter.includes(d)) : all)
  for (const fixture of fixtures) {
    const imageUrl = `/tests/harness/fixtures/${fixture.image}`
    for (const degradation of degradations(DEGRADATION_KEYS)) {
      if (mode !== 'auto') cells.push({ fixture, degradation, hint: fixture.game, imageUrl })
      if (mode !== 'hinted' && AUTO_GAMES.has(fixture.game) && AUTO_DEGRADATIONS.has(degradation)) {
        cells.push({ fixture, degradation, hint: 'auto', imageUrl })
      }
    }
  }
  console.log(`${fixtures.length} fixtures → ${cells.length} cells on ${pages} page(s)\n`)

  // --- dev server -----------------------------------------------------------
  const vite = spawn('node', [join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
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
      const hit = stubs.handle(url, route.request())
      if (hit) return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body })
      return route.abort('failed')
    })

    const workers = []
    for (let i = 0; i < pages; i++) {
      const page = await context.newPage()
      if (args.verbose) page.on('console', (msg) => console.log(`  [page${i}]`, msg.text().slice(0, 200)))
      page.on('pageerror', (err) => console.error(`  [page${i}] pageerror:`, String(err).slice(0, 300)))
      await page.goto(`http://127.0.0.1:${PORT}/tests/harness/page.html`, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => window.__harness != null, { timeout: 20_000 })
      await page.evaluate(() => window.__harness.warm())
      workers.push(page)
    }

    // --- run ----------------------------------------------------------------
    const results = []
    let next = 0
    const t0 = Date.now()
    await Promise.all(
      workers.map(async (page) => {
        while (next < cells.length) {
          const at = next++
          const cell = cells[at]
          let result
          try {
            result = await page.evaluate(
              (c) => window.__harness.runCell(c),
              { imageUrl: cell.imageUrl, degradation: cell.degradation, hint: cell.hint },
            )
          } catch (err) {
            result = { outcome: { ok: false, reason: 'exception', message: String(err).slice(0, 300) }, ms: 0, trace: null }
          }
          const pass = graded(cell.fixture, result.outcome)
          const stage = pass ? 'pass' : failureStage(cell.fixture, result)
          results.push({
            game: cell.fixture.game,
            key: cell.fixture.key,
            expected: cell.fixture.name,
            degradation: cell.degradation,
            hint: cell.hint,
            pass,
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
    const wallMs = Date.now() - t0

    // --- report -------------------------------------------------------------
    const byGame = {}
    for (const r of results) {
      const g = (byGame[r.game] ??= { pass: 0, total: 0, stages: {}, byDegradation: {} })
      g.total++
      if (r.pass) g.pass++
      else g.stages[r.stage] = (g.stages[r.stage] ?? 0) + 1
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
      stubCalls: stubs.stats.calls,
      unknownHosts: [...new Set(stubs.stats.unknown)],
      cells: results,
    }
    const out = typeof args.out === 'string' ? args.out : join(HERE, 'report', `run-${Date.now()}.json`)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(report, null, 1))

    console.log(`\n=== ${overall.pass}/${overall.total} identified (${((overall.pass / overall.total) * 100).toFixed(0)}%) in ${(wallMs / 1000).toFixed(0)}s ===`)
    const degradationsSeen = [...new Set(results.map((r) => r.degradation))]
    const pad = (s, n) => String(s).padEnd(n)
    console.log(pad('', 14) + degradationsSeen.map((d) => pad(d, 13)).join(''))
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
    if (report.unknownHosts.length) console.log(`  unstubbed hosts hit: ${report.unknownHosts.join(', ')}`)
    console.log(`  report: ${out}`)

    // --- assertions ---------------------------------------------------------
    let bad = false
    if (typeof args.baseline === 'string') {
      const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'))
      for (const [game, g] of Object.entries(byGame)) {
        const b = baseline.byGame?.[game]
        if (!b?.total) continue
        const now = g.pass / g.total
        const then = b.pass / b.total
        if (now + 1e-9 < then) {
          console.error(`REGRESSION: ${game} ${(then * 100).toFixed(0)}% → ${(now * 100).toFixed(0)}%`)
          bad = true
        }
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

const DEGRADATION_KEYS = ['clean', 'small-offset', 'soft-focus', 'rot+5', 'rot-5', 'perspective', 'glare', 'lowlight', 'worst']

main()
