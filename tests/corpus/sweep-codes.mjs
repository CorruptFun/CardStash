/**
 * The code sweep: every printed (set code, collector number) in the corpus,
 * through `parseCardCode` and the code-resolution path, asking two questions.
 *
 *   1. Does the parser recognise the number FORMAT this game actually prints?
 *   2. Does the lookup land the EXACT printing, not a neighbour?
 *
 * The second question is why this is separate from the name sweep. A printed
 * code names ONE printing where a name names a dozen, so "close" is not a
 * partial credit here — a code that resolves to the wrong printing puts a
 * common's price on a secret rare (ygo.ts's own words) and does it with the
 * confidence of a typed statement of intent.
 *
 * The first question is the one this harness exists to answer at scale. Every
 * collector-number format the sweep meets is INVENTORIED — regexp class,
 * count, three exemplars — so the shapes the parser refuses are enumerated on
 * a table rather than discovered one angry user at a time. `A-266`, `★8`,
 * `TG12`, `SV107`, `EN001a`: some of those are worth supporting and some are
 * not, but none of them should be a surprise.
 *
 * PRE-REGISTERED before the first full run (lesson 84):
 *   - Yu-Gi-Oh is the game whose codes are its identity, and the EN-prefix and
 *     zero-padding classes are already fixed (`codeCandidates` in ygo.ts).
 *     They must show as PASSING. A regression there is the headline.
 *   - MTG's collector numbers are the wildest of the three (Scryfall permits
 *     letters, stars and prefixes). A large `parse-refused` count there is
 *     expected and is a FORMAT INVENTORY result, not a bug report.
 *   - Pokémon's code path runs through pokemontcg.io's exact-field queries,
 *     and the corpus can feed both the `set.ptcgoCode` and `set.id` arms
 *     (TCGdex publishes an official abbreviation for 188 of 199 sets). Sets
 *     without one are counted and excluded from the ptcgo arm's denominator
 *     rather than scored as misses.
 *   - Zero live network calls. Asserted, not assumed.
 *
 * SCOPE: the mirror is inert (it is our own copy of these same feeds, so
 * letting it answer would grade the corpus against itself), and Pokémon's
 * primary is ALIVE here — a dead primary makes every Pokémon code lookup
 * return nothing, which would measure the stub rather than the parser.
 */

import { stubState } from './apistub.mjs'
import { loadCorpus, corpusInventory, digitsOf } from './corpus.mjs'
import { Buckets, compressPoliteWaits, loadMatchers, mdTable, parseArgs, pct, sample, sealNetwork, writeReport } from './harness.mjs'

const args = parseArgs(process.argv)
const EXEMPLAR_CAP = args.exemplars

/* ------------------------------------------------------ format inventory */

/**
 * The shape of a printed collector number, as a class rather than a value:
 * digits become `9`, letters `A`, everything else keeps itself. "266" → "999",
 * "266a" → "999A", "TG12" → "AA99", "A-266" → "A-999". Two cards share a class
 * exactly when the parser has the same job to do on both.
 */
export function numberClass(number) {
  return String(number ?? '')
    .replace(/\d/g, '9')
    .replace(/[A-Za-z]/g, 'A')
    .replace(/9{5,}/g, '9999+')
    .slice(0, 24)
}

/**
 * Which half of the printed code did the parser refuse?
 *
 * "12% of MTG printings do not parse" is a number nobody can act on. "5,261 of
 * them are sets whose code starts with a digit — 10E, 4ED, 2X2, 40K — because
 * `PREFIX` is `[A-Z][A-Z0-9]{1,5}`" is a one-character fix with a measured
 * size. The classifier reproduces cardcode.ts's own two shapes rather than
 * guessing, so a refusal is always attributed to the rule that made it.
 */
const PREFIX_SHAPE = /^[A-Z][A-Z0-9]{1,5}$/
const SUFFIX_SHAPE = /^(?:[A-Z]{2})?\d{1,4}[A-Z]?$/

function refusalCause(game, query) {
  const raw = query.toUpperCase()
  const at = game === 'yugioh' ? raw.indexOf('-') : raw.indexOf(' ')
  if (at < 0) return 'no-separator'
  const setHalf = raw.slice(0, at)
  const numberHalf = raw.slice(at + 1)
  if (!PREFIX_SHAPE.test(setHalf)) {
    if (/^\d/.test(setHalf)) return 'set-code-starts-with-a-digit'
    if (setHalf.length > 6) return 'set-code-longer-than-6'
    if (setHalf.length < 2) return 'set-code-shorter-than-2'
    return 'set-code-not-alphanumeric'
  }
  if (!SUFFIX_SHAPE.test(numberHalf)) {
    if (/^[A-Z]{3,}/.test(numberHalf)) return 'number-carries-a-3+-letter-prefix'
    if (/^[A-Z]\d/.test(numberHalf)) return 'number-carries-a-1-letter-prefix'
    if (/[^A-Z0-9]/.test(numberHalf)) return 'number-not-alphanumeric'
    if (/[A-Z]{2}\d+[A-Z]{2,}/.test(numberHalf)) return 'number-has-a-trailing-letter-run'
    return 'number-shape-otherwise'
  }
  return 'parsed-shape-but-refused-anyway'
}

/** The printed query a collector would type, per game's printed convention. */
function printedQuery(game, print) {
  if (game === 'yugioh') return print.printed // "BLMR-EN085", already joined
  return `${print.set.toUpperCase()} ${print.number}`
}

/* ---------------------------------------------------------------- verdicts */

/**
 * Did the lookup land the printing that was asked for?
 *
 * Identity is compared on api id AND printed location, because the two games
 * disagree about what an api id means: Scryfall mints one per printing, while
 * every Yu-Gi-Oh reprint shares the passcode and only the set code tells them
 * apart. Pokémon ids arrive with or without TCGdex's `dex-` prefix depending
 * on which arm answered — the same printing either way.
 */
function landedExactly(game, print, card) {
  if (!card) return false
  const gotId = String(card.apiId ?? '').replace(/^dex-/, '')
  const wantId = String(print.apiId ?? '').replace(/^dex-/, '')
  if (game === 'yugioh') {
    // The passcode plus the printing selected out of the card's set list.
    return gotId === wantId && String(card.number ?? '').toUpperCase() === print.printed
  }
  if (gotId !== wantId) return false
  // Strict on the printed number, not just its digits: "SL5" and "5" are
  // different cards in the same set, and both answer `digitsOf` with "5".
  // Both sides come out of the same corpus row, so exactness costs nothing.
  return String(card.number ?? '').toUpperCase() === String(print.number).toUpperCase()
}

/**
 * Why did this code answer something else? The distinction that matters is
 * whether the typed string HONESTLY names the answer too.
 *
 * - `number-truncated` — the answer's collector number is not the one asked
 *   for. "COL1 SL5" answering card 5 is the parser handing the lookup
 *   `digits` ("5") where the card prints "SL5": the alphabetic half of the
 *   number is dropped and a real, different card sits at the remainder. This
 *   is a defect.
 * - `code-collision` — the answer carries the SAME printed code, in a
 *   different set that also answers to it (a PTCGO code colliding with
 *   another set's catalog id). The catalog is genuinely ambiguous; the app
 *   picking one silently is a design question, not a mis-parse.
 * - `same-code-by-design` — Yu-Gi-Oh only: `sameCardCode` deliberately treats
 *   "IOC-EN017" and "IOC-017" as one printing, while the feed lists them as
 *   two rows with their own rarity and price. Not a parse fault; a
 *   consequence of the comparator's own rule.
 */
function wrongMechanism(app, game, print, code, got, sameName) {
  const wantDigits = digitsOf(print.number)
  const gotDigits = digitsOf(got.number)
  if (game === 'yugioh' && app.sameCardCode(got.number, print.printed)) return 'same-code-by-design'
  if (gotDigits !== wantDigits) return 'number-truncated'
  if (String(print.number).toUpperCase() !== String(got.number ?? '').toUpperCase()) return 'number-truncated'
  return sameName ? 'same-code-by-design' : 'code-collision'
}

/* ------------------------------------------------------------------- sweep */

async function sweepGame(app, corpus, game, log) {
  const all = corpus[game].prints
  const prints = sample(
    [...all].sort((a, b) => (a.apiId < b.apiId ? -1 : a.apiId > b.apiId ? 1 : a.number < b.number ? -1 : 1)),
    args.sample,
  )
  const buckets = new Buckets(EXEMPLAR_CAP)
  const formats = new Map()
  const refusedFormats = new Map()
  const refusalCauses = new Buckets(EXEMPLAR_CAP)
  const wrongPrintings = []

  let done = 0
  const started = Date.now()
  for (const print of prints) {
    const query = printedQuery(game, print)
    const cls = numberClass(print.number)
    let slot = formats.get(cls)
    if (!slot) formats.set(cls, (slot = { count: 0, exemplars: [], refusedExemplars: [], parsed: 0, hit: 0 }))
    slot.count++
    if (slot.exemplars.length < 3) slot.exemplars.push({ query, apiId: print.apiId })

    const code = app.parseCardCode(query)
    if (!code) {
      const cause = refusalCause(game, query)
      buckets.add('parse-refused', { apiId: print.apiId, query, class: cls, cause })
      refusalCauses.add(cause, { query, apiId: print.apiId })
      refusedFormats.set(cls, (refusedFormats.get(cls) ?? 0) + 1)
      if (slot.refusedExemplars.length < 3) slot.refusedExemplars.push({ query, cause })
      done++
      continue
    }
    slot.parsed++

    const hits = await app.searchByCode(game, code, {}).catch(() => [])
    if (!hits.length) {
      buckets.add('lookup-empty', { apiId: print.apiId, query, class: cls })
    } else if (landedExactly(game, print, hits[0])) {
      buckets.add('exact', null)
      slot.hit++
    } else if (hits.some((card) => landedExactly(game, print, card))) {
      // The right printing came back, but not first. On a typed code the head
      // is what search shows, so this is a miss with a consolation prize.
      buckets.add('exact-but-not-first', { apiId: print.apiId, query, got: hits[0]?.name, class: cls })
    } else {
      const got = hits[0]
      const sameName = app.normalizeName(got.name) === app.normalizeName(print.name)
      const mechanism = wrongMechanism(app, game, print, code, got, sameName)
      buckets.add(`${sameName ? 'right-card-wrong-printing' : 'wrong-card'}:${mechanism}`, {
        apiId: print.apiId,
        query,
        printed: print.name,
        got: got.name,
        gotNumber: got.number ?? null,
        class: cls,
      })
      wrongPrintings.push({
        game,
        apiId: print.apiId,
        query,
        mechanism,
        printed: `${print.name} (${print.set.toUpperCase()} ${print.number})`,
        got: `${got.name} (${got.setCode ?? '?'} ${got.number ?? '?'})`,
        sameName,
      })
    }
    if (++done % 5000 === 0) {
      const rate = done / ((Date.now() - started) / 1000)
      log(`  ${game}: ${done}/${prints.length} printings (${rate.toFixed(0)}/s)`)
    }
  }

  return {
    game,
    printings: prints.length,
    ofTotal: all.length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    buckets: buckets.toJSON(),
    refusalCauses: refusalCauses.toJSON(),
    formats: Object.fromEntries(
      [...formats.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([cls, v]) => [
          cls,
          {
            count: v.count,
            parsed: v.parsed,
            landedExactly: v.hit,
            refused: refusedFormats.get(cls) ?? 0,
            exemplars: v.exemplars,
            refusedExemplars: v.refusedExemplars,
          },
        ]),
    ),
    wrongPrintings,
  }
}

/* ----------------------------------------------------------------- reports */

function markdown(payload) {
  const lines = []
  lines.push('# Corpus code sweep', '')
  lines.push(`- mode: **${payload.mode}**, exemplar cap ${EXEMPLAR_CAP}`)
  lines.push(`- runtime: ${payload.seconds}s`)
  lines.push(`- catalog calls served from the corpus: ${payload.stubCalls}`)
  lines.push(`- live network attempts: **${payload.liveNetworkAttempts.length}** (must be 0)`)

  for (const run of payload.runs) {
    lines.push('', `## ${run.game}`, '')
    lines.push(`${run.printings} of ${run.ofTotal} printings in ${run.seconds}s`, '')
    lines.push(
      mdTable(
        ['outcome', 'count', 'share'],
        Object.entries(run.buckets).map(([k, v]) => [k, v.count, pct(v.count, run.printings)]),
      ),
    )
    lines.push('', '### Why a printed code was refused', '')
    lines.push(
      Object.keys(run.refusalCauses).length
        ? mdTable(
            ['cause', 'count', 'exemplars'],
            Object.entries(run.refusalCauses).map(([cause, v]) => [
              cause,
              v.count,
              v.exemplars.map((e) => `\`${e.query}\``).join(' '),
            ]),
          )
        : '_nothing refused_',
    )
    lines.push('', '### Collector-number formats encountered', '')
    lines.push(
      mdTable(
        ['class', 'printings', 'parsed', 'landed exactly', 'parse-refused', 'exemplars'],
        Object.entries(run.formats)
          .slice(0, 40)
          .map(([cls, v]) => [
            `\`${cls}\``,
            v.count,
            `${v.parsed} (${pct(v.parsed, v.count)})`,
            `${v.landedExactly} (${pct(v.landedExactly, v.count)})`,
            v.refused,
            (v.refused ? v.refusedExemplars.map((e) => `\`${e.query}\`✗`) : v.exemplars.map((e) => `\`${e.query}\``)).join(' '),
          ]),
      ),
    )
    const shown = Object.keys(run.formats).length
    if (shown > 40) lines.push('', `_(${shown - 40} rarer classes omitted — full list in the JSON)_`)
  }

  lines.push('', '## Codes that answered a different card', '')
  lines.push(
    payload.topWrongCard.length
      ? mdTable(
          ['game', 'typed', 'asked for', 'answered', 'api id'],
          payload.topWrongCard.map((w) => [w.game, `\`${w.query}\``, w.printed, w.got, w.apiId]),
        )
      : '_none_',
  )
  return `${lines.join('\n')}\n`
}

/* -------------------------------------------------------------------- main */

const log = (msg) => console.log(msg)
const liveNetworkAttempts = sealNetwork()
const restoreTimers = compressPoliteWaits()

const corpus = await loadCorpus(args.games, { log })
const inventory = corpusInventory(corpus)
for (const game of args.games) {
  if (!inventory[game]?.printings) throw new Error(`corpus: ${game} loaded 0 printings — nothing to sweep`)
}
stubState().pokemonPrimary = 'alive'

const app = await loadMatchers()
const started = Date.now()
const runs = []
for (const game of args.games) {
  log(`sweep-codes: ${game}…`)
  runs.push(await sweepGame(app, corpus, game, log))
}
restoreTimers()

const wrong = runs.flatMap((r) => r.wrongPrintings)
const payload = {
  mode: args.sample ? `sample=${args.sample}` : 'full',
  seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  inventory,
  stubCalls: stubState().calls,
  unstubbedHosts: stubState().unstubbed.slice(0, 20),
  liveNetworkAttempts: [...new Set(liveNetworkAttempts)].slice(0, 20),
  runs: runs.map((r) => ({ ...r, wrongPrintings: r.wrongPrintings.length })),
  wrongCardTotal: wrong.filter((w) => !w.sameName).length,
  wrongPrintingTotal: wrong.filter((w) => w.sameName).length,
  topWrongCard: wrong.filter((w) => !w.sameName).slice(0, 40),
  allWrong: wrong.slice(0, 5000),
}

const written = writeReport(args.out ?? 'codes', payload, markdown(payload))
log(`\nwrote ${written.json}\n      ${written.md}`)
for (const run of runs) {
  const b = run.buckets
  // Buckets carry their mechanism (`wrong-card:number-truncated`), so the
  // console line sums the family rather than looking for a bare name that no
  // longer exists — the quiet way a summary starts reporting zero.
  const family = (prefix) =>
    Object.entries(b).reduce((n, [k, v]) => n + (k === prefix || k.startsWith(`${prefix}:`) ? v.count : 0), 0)
  log(
    `  ${run.game}: exact ${family('exact')}/${run.printings}, ` +
      `parse-refused ${family('parse-refused')}, empty ${family('lookup-empty')}, ` +
      `wrong-card ${family('wrong-card')}, wrong-printing ${family('right-card-wrong-printing')}`,
  )
}

if (liveNetworkAttempts.length) {
  console.error(`FAIL: ${liveNetworkAttempts.length} live network attempts — ${liveNetworkAttempts[0]}`)
  process.exit(1)
}
if (stubState().unstubbed.length) {
  console.error(`FAIL: ${stubState().unstubbed.length} unstubbed endpoints — ${stubState().unstubbed[0]}`)
  process.exit(1)
}
log('network floor: 0 live attempts, 0 unstubbed endpoints')
process.exit(0)
