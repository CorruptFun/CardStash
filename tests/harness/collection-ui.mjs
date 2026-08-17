/**
 * Drive the REAL collection screen and the card sheet it opens.
 *
 *   node tests/harness/collection-ui.mjs                  # pass/fail
 *   node tests/harness/collection-ui.mjs --shots=/tmp/x   # + screenshots
 *
 * No camera and no fixtures: the cards come from the demo collection, so a run
 * says nothing about (and cannot be broken by) the scan pipeline. External
 * requests are aborted so a sandbox without network reads the same as one with.
 *
 * The invariants worth a harness, none of which a screenshot or the type system
 * can hold on to:
 *
 *   - a card tapped in the collection opens ON ITS EDITOR. That is one useState
 *     seeded from `sheet.item`, and it is the kind of thing a later refactor
 *     "simplifies" into an effect (which flashes) or drops entirely (which
 *     silently restores the old add-first sheet);
 *   - the primary action is Edit there and Add everywhere else. A sheet handed
 *     no collection row has nothing to edit, and edit-first must not leak into
 *     it;
 *   - nothing in the action row clips or truncates. The owned sheet is the only
 *     one with three buttons, it already had ~3px of slack at 375px before any
 *     of this, and the failure is a button off the edge of a sticky bar — which
 *     looks like a missing feature rather than a layout bug;
 *   - "All" in select mode takes WHAT IS ON SCREEN, not the whole collection.
 *     The filters above it are how the user says what they mean;
 *   - sort composes with the subset chips. Spares and For-trade used to BE sort
 *     modes, so re-welding them together would pass every type check.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const PORT = Number(process.env.COLLECTION_UI_PORT ?? 5217)

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const SHOTS = typeof args.shots === 'string' ? args.shots : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const failures = []
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(what)
}

// `--host 127.0.0.1` for the reason the other harnesses carry it: vite binds
// the loopback NAME by default, so where `localhost` resolves to ::1 nothing
// listens on the literal this file is written against.
const vite = spawn(
  'node',
  [join(REPO, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
)
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
const stopVite = () => {
  try {
    vite.kill('SIGTERM')
  } catch {
    /* gone */
  }
}
process.on('exit', stopVite)

const waitFor = async (url, ms = 40_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`timed out waiting for ${url}\n${viteLog.split('\n').slice(-12).join('\n')}`)
}

const APP = (hash) => `http://127.0.0.1:${PORT}/index.html?welcome=0&nosw=1#/${hash}`

/**
 * Geometry of the sheet's sticky action row.
 *
 * `textContent` and not `innerText` throughout this file: `.cardcell` sets
 * `content-visibility: auto`, so an offscreen cell's `innerText` is the empty
 * string and every name assertion would pass against nothing.
 */
const readActionRow = (page) =>
  page.evaluate(() => {
    const row = document.querySelector('.addbar__actions')
    if (!row) return null
    const label = document.querySelector('.addbar__addlabel')
    const buttons = [...row.children].map((b) => {
      const r = b.getBoundingClientRect()
      return { text: b.textContent.trim(), width: Math.round(r.width), top: Math.round(r.top) }
    })
    return {
      primary: label?.textContent.trim() ?? null,
      // A label wider than its box is an ellipsis, i.e. a label that has stopped
      // saying what the button does.
      truncated: label ? label.scrollWidth > label.clientWidth + 1 : false,
      clipped: row.scrollWidth > row.clientWidth + 1,
      lines: new Set(buttons.map((b) => b.top)).size,
      buttons,
    }
  })

const sheetState = (page) =>
  page.evaluate(() => {
    const sheet = document.querySelector('.cardsheet')
    if (!sheet) return null
    return {
      copyEditorOpen: !!sheet.querySelector('.copyedit'),
      openCopyRows: sheet.querySelectorAll('.copyrow--open').length,
      addControlsOpen: !!sheet.querySelector('.addbar__opts'),
      addAnotherGhost: sheet.querySelector('.addbar__another')?.textContent.trim() ?? null,
      modeHeader: sheet.querySelector('.addbar__modelabel')?.textContent.trim() ?? null,
    }
  })

const openCell = async (page, name) => {
  await page.evaluate((wanted) => {
    const cell = [...document.querySelectorAll('.cardcell')].find((c) => c.textContent.includes(wanted))
    if (!cell) throw new Error(`no collection cell for ${wanted}`)
    cell.scrollIntoView({ block: 'center' })
    cell.click()
  }, name)
  await page.waitForSelector('.cardsheet', { timeout: 10_000 })
  await page.waitForTimeout(500)
}

const closeSheet = async (page) => {
  await page.goBack()
  await page.waitForTimeout(500)
}

const subsetChip = (page, label) =>
  page.evaluate((wanted) => {
    // The LAST chip row is the subset row; the first is games, and both use
    // `.gamefilter`, so "All" matches in both.
    const rows = [...document.querySelectorAll('.collhead__games')]
    const chip = [...rows[rows.length - 1].querySelectorAll('.gamefilter')].find((b) =>
      b.textContent.startsWith(wanted),
    )
    if (!chip) throw new Error(`no subset chip ${wanted}`)
    chip.click()
    return true
  }, label)

const toolButton = (page, label) =>
  page.evaluate((wanted) => {
    const btn = [...document.querySelectorAll('.colltools .btn')].find((b) => b.textContent.trim().startsWith(wanted))
    if (!btn) throw new Error(`no toolbar button ${wanted}`)
    btn.click()
    return true
  }, label)

const gridNames = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.cardcell__name')].map((n) => n.textContent))

let browser
try {
  await waitFor(`http://127.0.0.1:${PORT}/index.html`)
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  // 375px, the width the action row's budget was measured against.
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 })
  await ctx.route('**/*', (route) => {
    const url = route.request().url()
    const local = url.startsWith(`http://127.0.0.1:${PORT}/`) || url.startsWith('data:') || url.startsWith('blob:')
    return local ? route.continue() : route.abort('failed')
  })
  const page = await ctx.newPage()
  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(String(err).slice(0, 200)))
  const shot = async (name) => {
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `collection-${name}.png`) })
  }

  // `welcome=0` because a harness is a first-time visitor every run and the
  // welcome dialog is modal — see onboarding.ts.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?demo=1&welcome=0&nosw=1`)
  await page.waitForSelector('.nav', { timeout: 30_000 })
  await page.waitForTimeout(2000)
  await page.goto(APP('collection'))
  await page.waitForSelector('.cardcell', { timeout: 20_000 })
  // The diagnostics disclosure is modal on a first run and sits over the grid.
  await page.evaluate(() => {
    ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Got it')?.click()
  })
  await page.waitForTimeout(400)

  /* --- edit-first: a card you own opens on its editor ---------------------- */

  console.log('\nThe card you already own')
  await openCell(page, 'Charizard')
  const owned = await sheetState(page)
  await shot('owned-sheet')
  check(owned?.copyEditorOpen === true, 'tapping a collection card opens that copy’s editor, with no second tap')
  check(owned?.openCopyRows === 1, 'exactly one copy row is open', `${owned?.openCopyRows} open`)
  check(owned?.addControlsOpen === false, 'and the add controls are NOT what the sheet leads with')

  const ownedRow = await readActionRow(page)
  check(/^Edit copy/.test(ownedRow?.primary ?? ''), 'the primary action is Edit', ownedRow?.primary)
  check(
    (ownedRow?.addAnotherGhost ?? owned?.addAnotherGhost ?? '').startsWith('Add another copy'),
    'adding another copy is offered as the secondary, priced',
    owned?.addAnotherGhost,
  )
  check(!ownedRow?.clipped, 'no action button is clipped off the sticky bar', JSON.stringify(ownedRow?.buttons))
  check(!ownedRow?.truncated, 'and the primary’s label is not ellipsised', ownedRow?.primary)

  /* --- the demoted add is still one tap away -------------------------------- */

  await page.click('.addbar__another')
  await page.waitForTimeout(400)
  const adding = await sheetState(page)
  const addingRow = await readActionRow(page)
  await shot('owned-adding')
  check(adding?.addControlsOpen === true, 'tapping it reveals the add controls')
  check(adding?.modeHeader === 'Adding another copy', 'which say which of the bar’s two jobs is on screen', adding?.modeHeader)
  check(/^Add/.test(addingRow?.primary ?? ''), 'and the primary becomes Add', addingRow?.primary)
  check(!addingRow?.clipped && !addingRow?.truncated, 'still without clipping or truncating', addingRow?.primary)
  check(adding?.copyEditorOpen === true, 'the copy editor above is left alone — adding is not editing')

  /* --- and the editor is what actually writes ------------------------------- */

  const finishBefore = await page.locator('.copyrow--open .copyrow__finish').textContent()
  await page.evaluate(() => {
    const seg = document.querySelector('.copyedit .seg')
    const opt = [...seg.querySelectorAll('button')].find((b) => b.textContent === '1st Edition')
    if (!opt) throw new Error('no 1st Edition finish for this game')
    opt.click()
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.copyedit__actions .btn')].find((b) => b.textContent.trim() === 'Save').click()
  })
  await page.waitForTimeout(900)
  const afterSave = await page.evaluate(() => ({
    editorClosed: !document.querySelector('.copyedit'),
    rowSays: document.querySelector('.copyrow__finish')?.textContent,
  }))
  check(afterSave.editorClosed, 'saving closes the editor')
  check(afterSave.rowSays === '1st Edition', 'and the copy row shows what was saved', `${finishBefore} → ${afterSave.rowSays}`)

  /* --- a 1st-edition STAMP is not a foil ------------------------------------ */

  await closeSheet(page)
  await page.waitForSelector('.cardcell', { timeout: 10_000 })
  const stamp = await page.evaluate(() => {
    const cell = [...document.querySelectorAll('.cardcell')].find((c) => c.textContent.includes('Charizard'))
    const tag = cell.querySelector('.cardcell__finish')
    return {
      label: tag?.textContent,
      isStamp: tag?.classList.contains('cardcell__finish--stamp'),
      artGlares: !!cell.querySelector('.cardimg--foil'),
      // Every holoshift surface must travel a whole tile or it snaps; 200% is
      // the only size where the end position and the size are the same number.
      size: tag ? getComputedStyle(tag).backgroundSize : null,
    }
  })
  check(stamp.label === '1st Edition' && stamp.isStamp === true, 'a 1st-edition tag is drawn as a stamp, not as foil', stamp.label)
  check(stamp.artGlares === false, 'and its art does not glare either — the two agree')
  check(stamp.size === '200% 100%', 'the shine is sized 200% so its loop is seamless', stamp.size)

  const shine = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((el) => el.getAnimations().some((a) => a.animationName === 'holoshift'))
      .map((el) => getComputedStyle(el).backgroundSize),
  )
  check(
    shine.length > 0 && shine.every((s) => s.split(',').every((layer) => /(^|\s)200%/.test(layer.trim()))),
    'every animated holo layer on screen is 200%-sized',
    shine.join(' | ') || 'none on screen',
  )

  // Put the demo row back, so a second run starts where the first did.
  await openCell(page, 'Charizard')
  await page.evaluate(() => {
    const seg = document.querySelector('.copyedit .seg')
    ;[...seg.querySelectorAll('button')].find((b) => b.textContent === 'Holo').click()
  })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    ;[...document.querySelectorAll('.copyedit__actions .btn')].find((b) => b.textContent.trim() === 'Save').click()
  })
  await page.waitForTimeout(800)
  await closeSheet(page)

  /* --- a sheet handed no row has nothing to edit ---------------------------- */

  console.log('\nA sheet opened without a collection row')
  await page.waitForSelector('.ins-mover', { timeout: 10_000 })
  await page.evaluate(() => {
    const mover = document.querySelector('.ins-mover')
    mover.scrollIntoView({ block: 'center' })
    mover.click()
  })
  await page.waitForSelector('.cardsheet', { timeout: 10_000 })
  await page.waitForTimeout(600)
  const bare = await sheetState(page)
  const bareRow = await readActionRow(page)
  check(/^Add/.test(bareRow?.primary ?? ''), 'the primary is Add — edit-first does not leak here', bareRow?.primary)
  check(bare?.addControlsOpen === true, 'the add controls open with the sheet, as they always did')
  check(bare?.copyEditorOpen === false, 'and no copy editor is opened on a guess')
  check(!bareRow?.clipped && !bareRow?.truncated, 'this row fits on one line', JSON.stringify(bareRow?.buttons))
  await closeSheet(page)

  /* --- the narrowest phone the stylesheet targets --------------------------- */

  console.log('\nAt 320px')
  await page.setViewportSize({ width: 320, height: 780 })
  await page.waitForTimeout(400)
  await openCell(page, 'Charizard')
  const narrow = await readActionRow(page)
  await shot('owned-320')
  check(!narrow?.clipped, 'the owned sheet still clips nothing at 320px', JSON.stringify(narrow?.buttons))
  check(!narrow?.truncated, 'and still says what its primary does', narrow?.primary)
  await closeSheet(page)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForTimeout(400)

  /* --- subsets are filters, and they compose with the sort ------------------ */

  console.log('\nThe subset chips')
  const chips = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.collhead__games')]
    return [...rows[rows.length - 1].querySelectorAll('.gamefilter')].map((b) => b.textContent.replace(/\s+/g, ' '))
  })
  check(
    chips.some((c) => c.startsWith('Spares')) && chips.some((c) => c.startsWith('For trade')),
    'spares and for-trade are chips with their counts on them, not options in a dropdown',
    chips.join(' | '),
  )
  const sortOptions = await page.evaluate(() =>
    [...document.querySelector('.colltools select').options].map((o) => o.value),
  )
  check(
    sortOptions.join(',') === 'value,name,newest',
    'and the sort control is orderings only',
    sortOptions.join(','),
  )

  const allRows = (await gridNames(page)).length
  await subsetChip(page, 'For trade')
  await page.waitForTimeout(400)
  const tradeRows = await gridNames(page)
  check(tradeRows.length > 0 && tradeRows.length < allRows, 'a subset chip filters the grid', `${allRows} → ${tradeRows.length}`)
  check(
    await page.evaluate(() =>
      [...document.querySelectorAll('.cardcell')].every((c) => c.querySelector('.cardcell__trade')),
    ),
    'and every row it leaves is actually offered for trade',
  )

  const orderOf = async (mode) => {
    await page.selectOption('.colltools select', mode)
    await page.waitForTimeout(400)
    return (await gridNames(page)).join('>')
  }
  const byValue = await orderOf('value')
  const byNewest = await orderOf('newest')
  check(
    byValue !== byNewest,
    'sort still reorders INSIDE a subset — the thing the old sort modes could not do',
    `${byValue} vs ${byNewest}`,
  )

  /* --- select-all takes what is on screen ---------------------------------- */

  console.log('\nSelect mode')
  await toolButton(page, 'Select')
  await page.waitForTimeout(400)
  const selectTools = await page.evaluate(() =>
    [...document.querySelectorAll('.colltools .btn')].map((b) => b.textContent.trim()),
  )
  check(
    selectTools.some((t) => t === 'Done') && !selectTools.some((t) => t === 'Edit'),
    'the toolbar says Select/Done — never Edit, which now means editing a card',
    selectTools.join(' | '),
  )
  check(
    (await page.getAttribute('.cardcell', 'aria-pressed')) === 'false',
    'and the cells announce themselves as toggles only while selecting',
  )

  await toolButton(page, 'All')
  await page.waitForTimeout(500)
  const picked = await page.evaluate(() => ({
    bar: document.querySelector('.bulkbar__count')?.textContent ?? '',
    checks: document.querySelectorAll('.cardcell__check--on').length,
  }))
  await shot('select-all')
  check(
    picked.checks === tradeRows.length && picked.bar.startsWith(String(tradeRows.length)),
    'All takes exactly the rows on screen, not the whole collection',
    `${picked.bar} of ${tradeRows.length} shown, ${allRows} owned`,
  )

  await toolButton(page, 'None')
  await page.waitForTimeout(500)
  check(
    await page.evaluate(() => !document.querySelector('.bulkbar')),
    'and drops them again, taking the bulk bar with it',
  )

  check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '))
} catch (err) {
  check(false, 'harness ran', String(err).split('\n')[0])
} finally {
  await browser?.close()
  stopVite()
}

console.log(
  failures.length
    ? `\nFAILED: ${failures.length}\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nCOLLECTION UI OK — the collection edits first, the sheet fits, and the filters compose.',
)
process.exit(failures.length ? 1 : 0)
