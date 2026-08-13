import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundleImport } from './bundle.mjs'

/*
 * "I scanned Ambessa and it gave me the wrong Ambessa."
 *
 * Riftbound prints the champion's name and the epithet that distinguishes one
 * of their cards from another on the SAME narrow plate — the hardest thing on
 * the card to read. When only the top line survives, `nameScore` forgives the
 * missing epithet by design, which parks every lead-only read at exactly 0.95
 * and sails past every threshold. The matcher then returns whichever sibling
 * happened to rank first: measured, a clipped plate on "Ambessa - Respected
 * and Feared" came back as "Ambessa - The Wolf" with confidence.
 *
 * The catalogue makes this the common case, not a corner: of the 98 champion
 * leads in the captured Riftbound catalogue, 48 carry more than one epithet
 * (Vi has four; Ahri, Teemo, Jinx and Viktor have three each).
 *
 * These tests pin the mechanism and the guard that stops it.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const { nameScore, nameLead, isLeadOnlyMatch } = await bundleImport('src/lib/util.ts')
const { catalogLeadVariants } = await bundleImport('src/lib/tcgcsv.ts', {
  alias: { './fetchJson': join(HERE, 'stubs', 'riftbound-net.mjs') },
})

test('a bare champion lead scores 0.95 against EVERY sibling — the loophole', () => {
  // The read cannot possibly tell these apart, yet both clear the 0.66 bar
  // and the 0.82 short-read bar. This is why a score cannot be the guard.
  assert.equal(Number(nameScore('Ambessa', 'Ambessa - Respected and Feared').toFixed(2)), 0.95)
  assert.equal(Number(nameScore('Ambessa', 'Ambessa - The Wolf').toFixed(2)), 0.95)
  assert.equal(Number(nameScore('Ahri', 'Ahri - Inquisitive').toFixed(2)), 0.95)
  assert.equal(Number(nameScore('Ahri', 'Ahri - Alluring').toFixed(2)), 0.95)
})

test('nameLead splits the epithet off, and only when there is one', () => {
  assert.equal(nameLead('Ahri - Inquisitive'), 'Ahri')
  assert.equal(nameLead('Masa, Crashing Thunder'), 'Masa')
  assert.equal(nameLead('Jinx, Loose Cannon'), 'Jinx')
  // An all-lead name has no epithet to have missed.
  assert.equal(nameLead('Body Rune'), null)
  assert.equal(nameLead('Counterspell'), null)
})

test('isLeadOnlyMatch separates a half-read plate from a whole one', () => {
  // Epithet unread — the read cannot distinguish siblings.
  assert.equal(isLeadOnlyMatch('Ambessa', 'Ambessa - Respected and Feared'), true)
  assert.equal(isLeadOnlyMatch('Ahri', 'Ahri - Inquisitive'), true)
  // Epithet read: the whole name carried the match, siblings are excluded.
  assert.equal(isLeadOnlyMatch('Ahri Inquisitive', 'Ahri - Inquisitive'), false)
  assert.equal(isLeadOnlyMatch('Masa, Crashing Thunder', 'Masa, Crashing Thunder'), false)
  // The epithet ALONE also distinguishes — Riftbound's plate prints it under
  // the name, so a band that clips the top still identifies the card.
  assert.equal(isLeadOnlyMatch('JOYFUL ASCETIC', 'Nilah - Joyful Ascetic'), false)
  // A name with no epithet can never be lead-only.
  assert.equal(isLeadOnlyMatch('Body Rune', 'Body Rune'), false)
})

test('catalogLeadVariants counts epithets, not printings', async () => {
  assert.equal(await catalogLeadVariants('riftbound', 'Ahri'), 2, 'three Alluring printings are ONE answer')
  assert.equal(await catalogLeadVariants('riftbound', 'Nilah'), 1, 'a lone champion is unambiguous — do not refuse it')
  assert.equal(await catalogLeadVariants('riftbound', 'Body Rune'), 1, 'a name with no epithet is its own answer')
})

test('the guard fires on the ambiguous champion and spares the lone one', async () => {
  // This is the decision identifyViaOcr makes, assembled from its two halves:
  // refuse a lead-only read ONLY where the catalogue really holds siblings.
  const refuses = async (read, cardName) => {
    if (!isLeadOnlyMatch(read, cardName)) return false
    const lead = nameLead(cardName)
    return lead ? (await catalogLeadVariants('riftbound', lead)) > 1 : false
  }
  assert.equal(await refuses('Ahri', 'Ahri - Inquisitive'), true, 'cannot tell Inquisitive from Alluring')
  // The user's card: one Nilah in the catalogue, so the lead decides it and
  // refusing would be a miss invented out of nothing.
  assert.equal(await refuses('Nilah', 'Nilah - Joyful Ascetic'), false)
  assert.equal(await refuses('Nilah Joyful Ascetic', 'Nilah - Joyful Ascetic'), false)
  assert.equal(await refuses('Body Rune', 'Body Rune'), false)
})
