import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStubs } from '../harness/stub-apis.mjs'

/**
 * The harness's stub card-APIs must honor each service's query semantics —
 * a stub that answers wrong would grade the scan pipeline against fiction.
 * Runs only when the fixtures snapshot is present (harness-fixtures branch).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'harness', 'fixtures')
const present = existsSync(join(FIXTURES, 'manifest.json'))

test('fixture snapshot present (informational)', (t) => {
  if (!present) t.skip('no fixtures — pull the harness-fixtures branch to run stub tests')
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
