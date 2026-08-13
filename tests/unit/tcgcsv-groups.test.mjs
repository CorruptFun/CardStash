import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

// The group-index merge (primary + "Pokemon Japan" categories) with the
// network stubbed out. Dexie loads fine in node; its cache reads fail soft
// (kvGet/kvPut catch), so only fetchJson needs replacing.
const HERE = fileURLToPath(new URL('.', import.meta.url))
const { tcgplayerGroups } = await bundleImport('src/lib/tcgcsv.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'tcgcsv-net.mjs') },
})

test('pokemon group index merges the Japanese category, tagged with its categoryId', async () => {
  const groups = await tcgplayerGroups('pokemon')
  const en = groups.find((g) => g.name === 'SV08: Surging Sparks')
  const jp = groups.find((g) => g.name === 'SV4K: Ancient Roar')
  assert.ok(en, 'English set present')
  assert.ok(jp, 'Japanese set present')
  assert.equal(en.categoryId, 3)
  assert.equal(jp.categoryId, 85)
})

test('games without aux categories stay single-category', async () => {
  const groups = await tcgplayerGroups('mtg')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].categoryId, 1)
})
