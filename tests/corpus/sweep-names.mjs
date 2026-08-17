/**
 * The name sweep: every card in the corpus, put through the OCR-corruption
 * ladder and handed to the REAL matching layer, looking for one thing.
 *
 *   A corruption must land on the card itself, or on nothing.
 *   Landing confidently on a DIFFERENT card is the crime.
 *
 * That is the failure this project keeps paying for one card at a time —
 * Krookodile ex answering as Krookodile, a hyphen eaten out of "Tauros-GX",
 * a bare champion lead answering the wrong epithet. Each of those was found
 * by a person holding the card. This finds them by exhaustion instead.
 *
 * PRE-REGISTERED before the first full run (scan-harness lesson 84 — a target
 * written down afterwards cannot be wrong):
 *
 *   1. `identity` must self-match at ~100% for every game. A catalog card that
 *      cannot find itself by its own printed name is a bug with no excuses.
 *      Any shortfall is reported as `identity-miss` and is the headline.
 *   2. `suffix-drop` is EXPECTED to answer the bare card and is bucketed, not
 *      failed — the pipeline's defence there is the rules box, which a
 *      name-only sweep cannot see. Its population size is the deliverable.
 *   3. Everything else must be `self` or `refused`. `confident-wrong` counts
 *      are the finding; `weak-wrong` (below the bar identify.ts would apply)
 *      is a safe refusal wearing a different hat and is counted separately.
 *   4. Zero live network calls. Asserted, not assumed.
 *
 * SCOPE, stated because the run output will never warn you (lesson 82):
 *   - This grades the MATCHER, not the camera. No images, no OCR engine, no
 *     collector line. A rung's query is a string.
 *   - Pokémon is swept on BOTH arms — a healthy pokemontcg.io and a dead one
 *     (`--arms=primary,dex`). The dead-primary arm is the only way to reach
 *     `rankBriefs`/`dexMatch`, which sit behind a healthy primary, and it is
 *     also the shape production increasingly meets.
 *   - The MTG arm depends on this harness's model of Scryfall's `fuzzy`
 *     resolver (see apistub.mjs), which is deliberately stricter than the real
 *     one. MTG `refused` is therefore an upper bound and MTG `confident-wrong`
 *     a lower bound. Pokémon and Yu-Gi-Oh ride documented exact/prefix/
 *     substring filters and carry no such caveat.
 *   - The localized-name arm (DE/FR/ES/IT/PT via TCGdex) has no corpus to feed
 *     it, so it is left switched off (`thorough: false`) rather than measured
 *     as a silent zero.
 */

import { stubState } from './apistub.mjs'
import { loadCorpus, corpusInventory } from './corpus.mjs'
import { ladderFor, RUNG_NAMES, splitSuffix } from './ladder.mjs'
import { Buckets, compressPoliteWaits, loadMatchers, mdTable, parseArgs, pct, sample, sealNetwork, writeReport } from './harness.mjs'

const args = parseArgs(process.argv)
const EXEMPLAR_CAP = args.exemplars

/** Pokémon runs twice; the other two have one catalog each. */
function armsFor(game) {
  if (game !== 'pokemon') return ['primary']
  const asked = args.arms.length ? args.arms : ['primary', 'dex']
  return asked
}

/* ------------------------------------------------------------ classifying */

/**
 * What did the matcher just do, and by what mechanism?
 *
 * The bar is `matchThresholdFor` out of identify.ts — the real one, bundled,
 * not a copy — because "wrong card" and "wrong card the user was shown" are
 * different claims and only the second one costs anybody money.
 */
function classify(app, names, printedName, query, answer) {
  if (!answer) return { bucket: 'refused', mechanism: 'refused', score: 0 }
  const same = app.normalizeName(answer.name) === app.normalizeName(printedName)
  if (same) return { bucket: 'self', mechanism: 'self', score: 1 }

  const score = app.nameScore(query, answer.name)
  const bar = app.matchThresholdFor(query)
  const confident = score >= bar

  const mechanism = wrongMechanism(app, printedName, query, answer)
  // Did the CORRUPTION land on another real card's name?
  //
  // This is the distinction that decides whether a finding is a defect. "Bind"
  // glyph-shaped into "Bird" is a Magic card, and answering Bird is correct for
  // the input — the ladder manufactured the ambiguity, the matcher did nothing
  // wrong, and no ranking change could help. "Aerodactyl V" read as
  // "Aerodactyl \/" normalises to "Aerodactyl", which is ALSO another real
  // card — same shape, but reached by a two-character OCR slip that happens
  // constantly, between two cards at very different prices.
  //
  // So both are reported, and neither is reported as the other: the matcher
  // cannot separate them from a name, and the report says which population is
  // which so the fix is aimed at the right layer.
  const collides = names.byNorm.has(app.normalizeName(query))
  return {
    bucket: `${confident ? 'confident' : 'weak'}-${mechanism}${collides ? '/query-is-a-real-name' : ''}`,
    mechanism,
    collides,
    score,
    bar,
    confident,
  }
}

/**
 * Which shape of wrong is this? Named buckets, never a vibe — a failure with
 * no mechanism is an anecdote (lesson 84's rule, applied to the crime side).
 */
function wrongMechanism(app, printedName, query, answer) {
  const printed = app.normalizeName(printedName)
  const got = app.normalizeName(answer.name)

  const printedSplit = splitSuffix(printedName)
  const gotSplit = splitSuffix(answer.name)
  const printedBase = printedSplit ? app.normalizeName(printedSplit.base) : printed
  const gotBase = gotSplit ? app.normalizeName(gotSplit.base) : got
  // Same species, different variant token: Krookodile vs Krookodile ex. The
  // single most expensive confusion in the pipeline, and the one a name can
  // never settle on its own.
  if (printedBase === gotBase) return 'suffix-sibling'
  // Mega is the same trap moved to the front of the name.
  if (printedBase.replace(/^(mega|m) /, '') === gotBase.replace(/^(mega|m) /, '')) return 'mega-sibling'
  // The read only ever accounted for the name's leading segment; identify.ts
  // has a guard for exactly this, gated on the mirror being reachable.
  if (app.isLeadOnlyMatch(query, answer.name)) return 'lead-only'
  if (got.startsWith(printed) || printed.startsWith(got)) return 'prefix-sibling'
  if (got.includes(printed) || printed.includes(got)) return 'substring-sibling'
  return 'unrelated'
}

/* ------------------------------------------------------------------- sweep */

async function sweepGame(app, corpus, game, arm, log) {
  stubState().pokemonPrimary = arm === 'dex' ? 'dead' : 'alive'
  const entries = sample(corpus[game].names.list, args.sample)
  const rungs = new Map(RUNG_NAMES.map((name) => [name, { applicable: 0, buckets: new Buckets(EXEMPLAR_CAP) }]))
  const confidentWrong = []
  const suffixDrop = { population: 0, answeredBare: 0, answeredSuffixed: 0, answeredOtherSibling: 0, refused: 0, other: 0 }

  let done = 0
  const started = Date.now()
  for (const entry of entries) {
    const apiId = String(entry.sample.apiId ?? entry.sample.id ?? entry.name)
    for (const { rung, query } of ladderFor(entry.name, apiId)) {
      if (query == null) continue
      const slot = rungs.get(rung)
      slot.applicable++
      const answer = await app.matchGame(game, query, null, null, {}).catch(() => null)
      const verdict = classify(app, corpus[game].names, entry.name, query, answer)

      if (rung === 'suffix-drop') {
        suffixDrop.population++
        if (!answer) suffixDrop.refused++
        else if (app.normalizeName(answer.name) === app.normalizeName(query)) suffixDrop.answeredBare++
        else if (verdict.bucket === 'self') suffixDrop.answeredSuffixed++
        else if (verdict.mechanism === 'suffix-sibling' || verdict.mechanism === 'mega-sibling') suffixDrop.answeredOtherSibling++
        else suffixDrop.other++
      }

      // A card that cannot find itself is worth an exemplar even when the way
      // it failed was a refusal — that is the whole point of the identity rung.
      const missedItself = rung === 'identity' && verdict.bucket !== 'self'
      const exemplar =
        !missedItself && (verdict.bucket === 'self' || verdict.bucket === 'refused')
          ? null
          : { apiId, printed: entry.name, query, got: answer?.name ?? null, score: Number(verdict.score.toFixed(3)) }
      slot.buckets.add(missedItself ? `identity-miss:${verdict.bucket}` : verdict.bucket, exemplar)

      // The crime list, kept whole for the top-N table rather than capped per
      // bucket: a report that shows three examples of the worst thing it found
      // has hidden the rest of it.
      if (verdict.confident && rung !== 'suffix-drop') {
        confidentWrong.push({
          game,
          arm,
          rung,
          mechanism: verdict.mechanism,
          queryIsARealName: verdict.collides,
          apiId,
          printed: entry.name,
          query,
          got: answer.name,
          gotId: answer.apiId,
          score: Number(verdict.score.toFixed(3)),
          bar: Number(verdict.bar.toFixed(3)),
        })
      }
    }
    if (++done % 2000 === 0) {
      const rate = done / ((Date.now() - started) / 1000)
      log(`  ${game}/${arm}: ${done}/${entries.length} names (${rate.toFixed(0)}/s)`)
    }
  }
  return {
    game,
    arm,
    names: entries.length,
    printings: corpus[game].prints.length,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    rungs: Object.fromEntries([...rungs].map(([name, slot]) => [name, { applicable: slot.applicable, ...slot.buckets.toJSON() }])),
    suffixDrop,
    confidentWrong,
  }
}

/* ----------------------------------------------------------------- reports */

/**
 * The headline table, capped per family.
 *
 * Sorted by score alone it fills with forty rows of the same finding — the
 * "V" → "\/" family alone is 130 rows at a flat 1.0 — and a table that shows
 * one thing forty times has hidden everything else it found. Score still
 * orders it; the cap only stops one family owning the page.
 */
function diverseTop(findings, limit, perFamily) {
  const seen = new Map()
  const out = []
  for (const f of [...findings].sort((a, b) => b.score - a.score || a.printed.localeCompare(b.printed))) {
    const family = `${f.game}/${f.arm}/${f.rung}/${f.mechanism}/${f.queryIsARealName}`
    const n = seen.get(family) ?? 0
    if (n >= perFamily) continue
    seen.set(family, n + 1)
    out.push(f)
    if (out.length >= limit) break
  }
  return out
}

function markdown(payload) {
  const lines = []
  lines.push('# Corpus name sweep', '')
  lines.push(`- mode: **${payload.mode}**, exemplar cap ${EXEMPLAR_CAP}`)
  lines.push(`- runtime: ${payload.seconds}s`)
  lines.push(`- catalog calls served from the corpus: ${payload.stubCalls}`)
  lines.push(`- live network attempts: **${payload.liveNetworkAttempts.length}** (must be 0)`)
  lines.push('')
  lines.push('## Corpus', '')
  lines.push(
    mdTable(
      ['game', 'printings', 'unique names', 'sets'],
      Object.entries(payload.inventory).map(([g, i]) => [g, i.printings, i.names, i.sets]),
    ),
  )

  for (const run of payload.runs) {
    lines.push('', `## ${run.game} — ${run.arm} arm`, '')
    lines.push(`${run.names} names swept (${run.printings} printings behind them) in ${run.seconds}s`, '')
    const rows = []
    for (const [rung, slot] of Object.entries(run.rungs)) {
      const buckets = Object.entries(slot).filter(([k]) => k !== 'applicable')
      const sum = (pred) => buckets.filter(([k]) => pred(k)).reduce((n, [, v]) => n + v.count, 0)
      const self = sum((k) => k === 'self')
      const refused = sum((k) => k === 'refused')
      const confident = sum((k) => k.startsWith('confident-'))
      const weak = sum((k) => k.startsWith('weak-'))
      const miss = sum((k) => k.startsWith('identity-miss'))
      rows.push([
        rung,
        slot.applicable,
        `${self} (${pct(self, slot.applicable)})`,
        refused,
        weak,
        `**${confident}**`,
        miss ? `**${miss}**` : '0',
      ])
    }
    lines.push(
      mdTable(
        ['rung', 'applicable', 'self', 'refused (safe)', 'weak-wrong (rejected)', 'CONFIDENT-WRONG', 'identity-miss'],
        rows,
      ),
    )

    lines.push('', '### Mechanism buckets', '')
    const mech = new Map()
    for (const slot of Object.values(run.rungs)) {
      for (const [bucket, v] of Object.entries(slot)) {
        if (bucket === 'applicable' || bucket === 'self' || bucket === 'refused') continue
        mech.set(bucket, (mech.get(bucket) ?? 0) + v.count)
      }
    }
    lines.push(
      mdTable(
        ['bucket', 'count'],
        [...mech.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
      ),
    )

    lines.push('', '### suffix-drop (the Krookodile population)', '')
    lines.push(
      mdTable(
        ['population', 'answered the bare card', 'answered the suffixed card', 'answered another sibling', 'refused', 'other'],
        [
          [
            run.suffixDrop.population,
            run.suffixDrop.answeredBare,
            run.suffixDrop.answeredSuffixed,
            run.suffixDrop.answeredOtherSibling,
            run.suffixDrop.refused,
            run.suffixDrop.other,
          ],
        ],
      ),
    )
  }

  lines.push('', '## Confident-wrong, split by whether the matcher had a chance', '')
  lines.push(
    'A corrupted read that IS another card\'s printed name cannot be separated from that card by any name matcher —',
    'the fix, if there is one, lives in evidence off the card (the rules box, the collector line), not in ranking.',
    'A corrupted read that names NO card and still got a confident answer is a ranking or threshold failure.',
    '',
  )
  lines.push(
    mdTable(
      ['population', 'count'],
      [
        ['the corrupted read is another card\'s exact name', payload.confidentWrongCollisions],
        ['the corrupted read names no card at all', payload.confidentWrongTotal - payload.confidentWrongCollisions],
      ],
    ),
  )
  lines.push('', '## Top confident-wrong findings', '')
  const top = payload.topConfidentWrong
  lines.push(
    top.length
      ? mdTable(
          ['game/arm', 'rung', 'mechanism', 'read is a real name?', 'printed', 'read as', 'answered', 'score/bar', 'api id'],
          top.map((f) => [
            `${f.game}/${f.arm}`,
            f.rung,
            f.mechanism,
            f.queryIsARealName ? 'yes' : 'no',
            f.printed,
            f.query,
            f.got,
            `${f.score} / ${f.bar}`,
            f.apiId,
          ]),
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
// Assert the corpus can FEED what is about to be measured, before measuring it
// (lesson 82). A game with no printings would otherwise report a flawless zero.
for (const game of args.games) {
  if (!inventory[game]?.printings) throw new Error(`corpus: ${game} loaded 0 printings — nothing to sweep`)
  if (!inventory[game]?.names) throw new Error(`corpus: ${game} loaded 0 names — nothing to sweep`)
}
log(`corpus: ${Object.values(inventory).reduce((n, i) => n + i.printings, 0)} printings, ` +
  `${Object.values(inventory).reduce((n, i) => n + i.names, 0)} unique names`)

const app = await loadMatchers()
const started = Date.now()
const runs = []
for (const game of args.games) {
  for (const arm of armsFor(game)) {
    log(`sweep-names: ${game} (${arm} arm)…`)
    runs.push(await sweepGame(app, corpus, game, arm, log))
  }
}
restoreTimers()

const allConfident = runs.flatMap((r) => r.confidentWrong)
const payload = {
  mode: args.sample ? `sample=${args.sample}` : 'full',
  seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
  inventory,
  stubCalls: globalThis.__CARDSTOCK_STUB__?.calls ?? 0,
  unstubbedHosts: globalThis.__CARDSTOCK_STUB__?.unstubbed?.slice(0, 20) ?? [],
  liveNetworkAttempts: [...new Set(liveNetworkAttempts)].slice(0, 20),
  runs: runs.map((r) => ({ ...r, confidentWrong: r.confidentWrong.length })),
  confidentWrongTotal: allConfident.length,
  confidentWrongCollisions: allConfident.filter((f) => f.queryIsARealName).length,
  // Most interesting = highest score first: a wrong card at 1.0 cleared every
  // bar the pipeline owns, where one at 0.67 squeaked past the lowest.
  topConfidentWrong: diverseTop(allConfident, 40, 2),
  allConfidentWrong: allConfident,
}

const written = writeReport(args.out ?? 'names', payload, markdown(payload))
log(`\nwrote ${written.json}\n      ${written.md}`)
log(`confident-wrong: ${allConfident.length} across ${runs.length} runs`)
for (const run of runs) log(`  ${run.game}/${run.arm}: suffix-drop population ${run.suffixDrop.population}`)

const unstubbed = globalThis.__CARDSTOCK_STUB__?.unstubbed ?? []
if (liveNetworkAttempts.length) {
  console.error(`FAIL: ${liveNetworkAttempts.length} live network attempts — ${liveNetworkAttempts[0]}`)
  process.exit(1)
}
if (unstubbed.length) {
  console.error(`FAIL: ${unstubbed.length} unstubbed endpoints — ${unstubbed[0]}`)
  process.exit(1)
}
log('network floor: 0 live attempts, 0 unstubbed endpoints')
process.exit(0)
