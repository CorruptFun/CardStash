import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStubs } from '../harness/stub-apis.mjs'

/**
 * The harness's stub card-APIs must honor each service's query semantics —
 * a stub that answers wrong would grade the scan pipeline against fiction.
 * Most tests run only when the fixtures snapshot is present (harness-fixtures
 * branch); the cards.scryfall.io image-mapping test builds its own scratch
 * store so the URL→file contract holds with or without a snapshot.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'harness', 'fixtures')
const present = existsSync(join(FIXTURES, 'manifest.json'))

test('fixture snapshot present (informational)', (t) => {
  if (!present) t.skip('no fixtures — pull the harness-fixtures branch to run stub tests')
})

test('scryfall imagery: small-front URLs map onto the print image store', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cardstash-print-stub-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const id = '7673784e-db4b-43a1-8d55-1bb9fc1e284f'
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
  mkdirSync(join(dir, 'images', 'prints'), { recursive: true })
  writeFileSync(join(dir, 'images', 'prints', `${id}.jpg`), bytes)
  const stubs = createStubs(dir)

  // The real URL shape, cache-buster included: answered with the stored bytes.
  const hit = stubs.handle(`https://cards.scryfall.io/small/front/7/6/${id}.jpg?1783903008`)
  assert.equal(hit.status, 200)
  assert.equal(hit.contentType, 'image/jpeg')
  assert.ok(Buffer.isBuffer(hit.body) && hit.body.equals(bytes), 'serves the stored bytes')
  assert.equal(stubs.handle(`https://cards.scryfall.io/small/front/7/6/${id}.jpg`).status, 200, 'no cache-buster')

  // An id in the right shape but not in the store: a clean 404 Response,
  // never a throw — the pipeline reads any failed image as "decline, keep
  // the current answer", and the harness must exercise that path honestly.
  const miss = stubs.handle('https://cards.scryfall.io/small/front/0/0/00000000-0000-4000-8000-000000000000.jpg?1')
  assert.equal(miss.status, 404)

  // Other sizes and faces are NOT served from the small file: they fall
  // through to the abort path like any unstubbed traffic, and are recorded
  // so a pipeline drifting onto uncaptured URLs fails loudly.
  for (const other of [
    `https://cards.scryfall.io/normal/front/7/6/${id}.jpg?1783903008`,
    `https://cards.scryfall.io/large/front/7/6/${id}.jpg`,
    `https://cards.scryfall.io/small/back/7/6/${id}.jpg`,
  ]) {
    assert.equal(stubs.handle(other), null, `${other} is not stubbed`)
  }
  assert.ok(stubs.stats.unknown.some((u) => u.includes('/normal/front/')), 'drift lands in stats.unknown')
})

if (present) {
  const stubs = createStubs(FIXTURES)
  const get = (url) => {
    const res = stubs.handle(url)
    return { status: res.status, body: JSON.parse(res.body) }
  }
  const manifest = (await import(`file://${join(FIXTURES, 'manifest.json')}`, { with: { type: 'json' } })).default

  test('tcgcsv: categories and riftbound catalog files served verbatim', () => {
    const categories = get('https://tcgcsv.com/tcgplayer/categories')
    assert.equal(categories.status, 200)
    assert.ok(Array.isArray(categories.body.results) && categories.body.results.length > 0)
    const catId = manifest.datasets.riftbound.tcgcsvCategoryId
    const groups = get(`https://tcgcsv.com/tcgplayer/${catId}/groups`)
    assert.equal(groups.status, 200)
    const groupId = groups.body.results[0].groupId
    const products = get(`https://tcgcsv.com/tcgplayer/${catId}/${groupId}/products`)
    assert.equal(products.status, 200)
    assert.ok(products.body.results.length > 0)
  })

  test('tcgdex: name search is a contains-filter; hydration answers for every brief hit', () => {
    const briefs = get('https://api.tcgdex.net/v2/en/cards?name=tauros')
    assert.equal(briefs.status, 200)
    assert.ok(briefs.body.length > 0, 'tauros briefs exist')
    for (const brief of briefs.body.filter((b) => /^tauros/i.test(b.name)).slice(-6)) {
      const full = get(`https://api.tcgdex.net/v2/en/cards/${brief.id}`)
      assert.equal(full.status, 200, `hydration for ${brief.id}`)
      assert.ok(full.body.set?.cardCount?.official != null, `set size rides on ${brief.id}`)
    }
  })

  test('tcgdex: unknown card 404s', () => {
    assert.equal(get('https://api.tcgdex.net/v2/en/cards/nope-999').status, 404)
  })

  test('scryfall: exact named, fuzzy near-miss, and unambiguity rule', () => {
    const exact = get('https://api.scryfall.com/cards/named?exact=Lightning%20Bolt')
    assert.equal(exact.status, 200)
    assert.equal(exact.body.name, 'Lightning Bolt')
    const fuzzy = get('https://api.scryfall.com/cards/named?fuzzy=Lighming%20Bolt')
    assert.equal(fuzzy.status, 200, 'small OCR-grade misread resolves')
    assert.equal(fuzzy.body.name, 'Lightning Bolt')
    const garbage = get('https://api.scryfall.com/cards/named?fuzzy=Talo%20meer%20fA%20xX')
    assert.equal(garbage.status, 404, 'garbage does not resolve')
  })

  test('scryfall: prints search by bang-exact name', () => {
    const res = get(`https://api.scryfall.com/cards/search?q=${encodeURIComponent('!"Lightning Bolt" game:paper')}&unique=prints`)
    assert.equal(res.status, 200)
    assert.ok(res.body.data.length >= 10)
    // Real data includes double-faced prints ("… // Lightning Bolt").
    assert.ok(res.body.data.every((p) => p.name.includes('Lightning Bolt')))
  })

  test('scryfall imagery: captured print URLs round-trip once the snapshot carries them', (t) => {
    const printsPath = join(FIXTURES, 'api', 'scryfall-prints.json')
    if (!existsSync(printsPath)) return t.skip('no scryfall prints in this snapshot')
    const prints = Object.values(JSON.parse(readFileSync(printsPath, 'utf8')))
      .flat()
      .filter((p) => p.image_uris?.small)
    const served = prints.filter((p) => existsSync(join(FIXTURES, 'images', 'prints', `${p.id}.jpg`)))
    // A pre-art-hash snapshot carries no print images; the mapping is still
    // covered by the scratch-store test above. Re-pull harness-fixtures after
    // CI regenerates to exercise the real captured URLs end to end.
    if (!served.length) return t.skip('snapshot predates print images — re-pull harness-fixtures')
    for (const p of served.slice(0, 5)) {
      const hit = stubs.handle(p.image_uris.small)
      assert.ok(hit && hit.status === 200 && hit.contentType === 'image/jpeg', p.image_uris.small)
    }
  })

  test('pokemontcg.io: phrase + number queries filter captured rows', () => {
    const ptcgio = get('https://api.pokemontcg.io/v2/cards?q=' + encodeURIComponent('name:"Iono\'s Bellibolt ex"') + '&pageSize=10')
    // 503: the whole API was dead at capture; 500: THIS query failed at
    // capture (it's a flaky, dying service — that's the point). Both are
    // honest replays; only a 200 must actually filter correctly.
    if (ptcgio.status === 503 || ptcgio.status === 500) return
    assert.equal(ptcgio.status, 200)
    assert.ok(ptcgio.body.data.every((r) => r.name.toLowerCase().includes("iono's bellibolt ex")))
  })

  test('ygoprodeck: fname contains vs name exact; empty answers 400 like the real API', () => {
    const contains = get('https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=blue-eyes')
    assert.equal(contains.status, 200)
    assert.ok(contains.body.data.some((r) => r.name === 'Blue-Eyes White Dragon'))
    const none = get('https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=zzzznope')
    assert.equal(none.status, 400)
  })

  test('every manifest fixture image exists on disk', () => {
    for (const f of manifest.fixtures) {
      assert.ok(existsSync(join(FIXTURES, f.image)), `${f.game}/${f.key} image`)
    }
  })
}
