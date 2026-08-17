import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

/*
 * Looking a card up by the number printed on it, against stubbed networks:
 * Yu-Gi-Oh through YGOPRODeck's exact-match set-code endpoint, and the
 * TCGCSV games through the day-cached catalog already in memory.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { ygoBySetCode, ygoById, ygoVariantByCode } = await bundleImport('src/lib/ygo.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'ygo-net.mjs') },
})
const { parseCardCode } = await bundleImport('src/lib/cardcode.ts')
const { catalogByCode } = await bundleImport('src/lib/tcgcsv.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'riftbound-net.mjs') },
})

test('a print code answers with THAT printing, not the card in general', async () => {
  const card = await ygoBySetCode('BLMR-EN085')
  assert.ok(card, 'expected a card')
  assert.equal(card.name, 'I:P Masquerena')
  assert.equal(card.number, 'BLMR-EN085')
  assert.equal(card.setCode, 'BLMR')
  assert.equal(card.rarity, 'Secret Rare')
  // Rarity moves Yu-Gi-Oh prices by orders of magnitude: answering a secret
  // rare's code with the reprint's headline price would be the wrong card's
  // money on the right card's face.
  assert.equal(card.prices.best, 25)
})

test('region and padding are the app’s problem, not the collector’s', async () => {
  for (const typed of ['BLMR-085', 'blmr en85', 'BLMR-EN85', 'blmr 085']) {
    const card = await ygoBySetCode(typed)
    assert.ok(card, typed)
    assert.equal(card.number, 'BLMR-EN085', typed)
  }
})

test('a code no set ever printed answers nothing rather than something close', async () => {
  assert.equal(await ygoBySetCode('BLMR-EN999'), null)
  assert.equal(await ygoBySetCode('ZZZZ-EN001'), null)
})

test('the region infix picks the printing — an English code is not an Asian one', async () => {
  // Fixed 2026-08-17. `sameYgoCode` folds PSV-089, PSV-E089 and PSV-EN089 into
  // one printing so a scan of a card in any language finds it; asked FIRST,
  // that rule answered a typed "PSV-EN089" with whichever row the feed listed
  // earliest — here the region-less Short Print at $1.74, on a query that
  // named the English Common. Selection now prefers the exact spelling and
  // falls back to the cross-language set only when there is no exact row.
  // Corpus gate for the fix: yugioh wrong-printing 1,348 → 0.
  const en = await ygoBySetCode('PSV-EN089')
  assert.equal(en.number, 'PSV-EN089')
  assert.notEqual(en.number, 'PSV-089', 'the region-less row is a different print at a different price')
  const bare = await ygoBySetCode('PSV-089')
  assert.equal(bare.number, 'PSV-089')
  assert.equal(bare.rarity, 'Short Print')
  assert.equal(bare.prices.best, 1.74)
})

test('padding is still the app’s problem — exactness is about the region, not the zeroes', async () => {
  // The exact rule normalises case, whitespace and zero-padding and nothing
  // else, so every way a collector spells ONE printing still lands it.
  // (Surrounding whitespace is `parseCardCode`'s job upstream — it trims
  // before this is ever called, and `codeCandidates` has never accepted it.)
  for (const typed of ['PSV-EN089', 'psv-en089', 'PSV-EN89', 'psv en089']) {
    assert.equal((await ygoBySetCode(typed))?.number, 'PSV-EN089', typed)
  }
})

test('a region with no printing of its own still answers the print that exists', async () => {
  // The cross-language rule, which the fix must not cost. 3-Hump Lacooda's
  // Ancient Sanctuary printing is listed only as "AST-070"; a collector
  // reading the code off a French card gets it anyway, because the candidate
  // ladder tries the region-less spelling once the regional one finds nothing.
  assert.equal((await ygoBySetCode('AST-FR070'))?.number, 'AST-070')
  // And the same answer by the other road: `printingByCode`'s own fallback,
  // for when the set-code index resolves a spelling the card's set list does
  // not carry (the stub models that disagreement deliberately). Without the
  // fallback this would answer the whole card instead of the printing.
  const en = await ygoBySetCode('AST-EN070')
  assert.equal(en?.number, 'AST-070')
  assert.equal(en?.rarity, 'Common')
})

test('CHARACTERISATION: one code printed at two rarities is settled by feed order', async () => {
  // Not a fix and not fixable here. YGOPRODeck lists PSV-EN089 twice — Common
  // and Short Print — and the printed code is identical on both, so nothing in
  // the query can choose. Selection stays deterministic (the feed's own order,
  // which is what the card sheet's variant picker then lets a user correct)
  // and the residual is counted rather than hidden: of the 40,670 Yu-Gi-Oh
  // codes the corpus sweep asks, 9,442 (3,656 distinct codes) share their
  // exact spelling with a sibling row at another rarity. The sweep scores
  // those `exact` — it compares api id and printed number, and both rows
  // answer to both — so this is the one part of the finding its verdict cannot
  // see. Pinned here so a change of order is a decision, not a surprise.
  const card = await ygoBySetCode('PSV-EN089')
  assert.equal(card.number, 'PSV-EN089')
  assert.equal(card.rarity, 'Common', 'the first PSV-EN089 row in the feed')
  // The Short Print sibling is $2 and is NOT what a bare "PSV-EN089" answers.
  assert.ok(
    card.printings.filter((p) => p.setCode === 'PSV-EN089').length === 2,
    'both rows are still offered to the variant picker',
  )
})

test('the scan road picks the printing the read code spells — not a cross-language cousin', async () => {
  // identify.ts in miniature: the passcode names the card (`ygoById`), the
  // mid-card code read off the face picks the printing (`ygoVariantByCode`
  // at the corner path and the refine). Same two-pass rule as search.
  const card = await ygoById('10000089')
  assert.equal(card.name, 'Gradius')
  const en = ygoVariantByCode(card, 'PSV-EN089')
  assert.equal(en?.number, 'PSV-EN089')
  assert.equal(en?.rarity, 'Common', 'feed order decides the same-code-twice residual')
  const bare = ygoVariantByCode(card, 'PSV-089')
  assert.equal(bare?.number, 'PSV-089')
  assert.equal(bare?.rarity, 'Short Print')
  assert.equal(ygoVariantByCode(card, 'psv-e89')?.number, 'PSV-E089', 'case and padding are noise; the region is not')
})

test('cross-language confirmation survives the exact-first pass', async () => {
  // The catalog lists only AST-070; an EN read off the physical card must
  // still pin it — that is what `sameYgoCode` exists for, and the fallback
  // pass keeps it. A French card reading Latin digits confirms the same way.
  const card = await ygoById('10000070')
  assert.equal(ygoVariantByCode(card, 'AST-EN070')?.number, 'AST-070')
})

test('a code confirming NO printing answers null, so the refine declines instead of guessing', async () => {
  const card = await ygoById('10000089')
  assert.equal(ygoVariantByCode(card, 'LOB-001'), null)
  assert.equal(ygoVariantByCode(card, undefined), null)
})

test('catalog games match the printed number out of the cached catalog', async () => {
  const hits = await catalogByCode('riftbound', parseCardCode('UNL 041'))
  assert.equal(hits.length, 1)
  assert.equal(hits[0].name, 'Ahri - Inquisitive')
})

test('every printing sharing the number comes back, base art first', async () => {
  // 040/219 is one card with three products; the number cannot choose
  // between them, so the query gets all three with the base printing leading.
  const hits = await catalogByCode('riftbound', parseCardCode('UNL-40'))
  assert.deepEqual(
    hits.map((c) => c.name),
    ['Ahri - Alluring', 'Ahri - Alluring (Alternate Art)', 'Ahri - Alluring (Launch Exclusive)'],
  )
})

test('a bare fraction identifies only when the set size agrees', async () => {
  assert.equal((await catalogByCode('riftbound', parseCardCode('115/219')))[0].name, 'Nilah - Joyful Ascetic')
  // Right number, wrong set size — that is a different set's card.
  assert.deepEqual(await catalogByCode('riftbound', parseCardCode('115/198')), [])
})

test('a set code that is not this set matches nothing', async () => {
  assert.deepEqual(await catalogByCode('riftbound', parseCardCode('OGN-041')), [])
})
