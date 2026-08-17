/**
 * The OCR-corruption ladder: what a scanner does to a printed card name on the
 * way to the matcher, written down as a deterministic function of the name.
 *
 * Every rung is **seeded by the card's own api id**, so the corpus sweep is
 * reproducible to the character — a finding can be re-derived from its id
 * alone, and a re-run cannot quietly move because a different random draw
 * mangled a different letter.
 *
 * Every rung is also **allowed to not apply**. A name with no diacritic
 * cannot be stripped of one, and counting that as a pass would inflate every
 * denominator in the report with questions that were never asked. `null` means
 * "not applicable", never "no corruption".
 *
 * The rungs are the failure shapes this project has already paid for:
 * plates read in caps, accents lost, hyphens eaten, l/I/1 and O/0 swapped,
 * variant suffixes mangled — and the suffix DROPPED, which is the dangerous
 * one, because a dropped two-letter suffix hits a real DIFFERENT card exactly.
 *
 * Pure and node-tested (`tests/unit/corpus-ladder.test.mjs`). Nothing here
 * imports app code: it describes the input side, and the app code is what the
 * sweep is grading.
 */

/* ------------------------------------------------------- seeded randomness */

/** FNV-1a: a stable 32-bit seed from an api id. */
export function hashSeed(text) {
  let h = 0x811c9dc5
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h || 1
}

/** xorshift32 — small, deterministic, and dependency-free. */
export function seededRandom(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 0x100000000
  }
}

const pick = (rand, list) => list[Math.floor(rand() * list.length) % list.length]

/* --------------------------------------------------------- variant suffixes */

/**
 * The suffix tokens that make two cards different cards at different prices.
 * Lowercase comparison; the printed casing is whatever the catalog says.
 * `pokemonNameSuffix` in `src/lib/corner.ts` owns the Pokémon half of this
 * vocabulary for the pipeline — this list is wider because the ladder also
 * corrupts Magic's and Yu-Gi-Oh's trailing markers.
 */
export const VARIANT_SUFFIXES = ['vmax', 'vstar', 'gx', 'ex', 'v', 'lv.x', 'star', 'δ', 'prime']

/** The name split into base and trailing variant token, or null when there is none. */
export function splitSuffix(name) {
  const text = String(name ?? '').trim()
  const words = text.split(/\s+/)
  if (words.length < 2) return null
  const last = words[words.length - 1]
  const bare = last.toLowerCase().replace(/[^a-z0-9.δ]/g, '')
  if (!VARIANT_SUFFIXES.includes(bare)) return null
  return { base: words.slice(0, -1).join(' '), suffix: last }
}

/**
 * The shapes an OCR pass turns a variant suffix into, taken from what the
 * pipeline has actually been handed: "@x" for ex (the @ is the glyph a small
 * serifed e collapses to), "6X"/"CX" for GX, a split "G X", "\/" for V.
 */
const SUFFIX_SHAPES = {
  ex: ['@x', 'ox', 'cx', 'ex.', 'e x'],
  gx: ['6X', 'CX', 'G X', '6x'],
  v: ['\\/', 'Y', 'v.'],
  vmax: ['VMAk', 'V MAX', 'VMAY'],
  vstar: ['VSTAF', 'V STAR', 'VSTAB'],
  star: ['5TAR', 'STAB'],
  prime: ['PRIMF', 'PRIME.'],
  'lv.x': ['LV X', 'LVX', 'LV.k'],
  δ: ['6', 'd'],
}

/**
 * Letter shapes an engine confuses at the glyph level — the "Pokemon" → "Petar"
 * class, where a word survives as something pronounceable and wrong rather
 * than as obvious junk. Applied to ONE word so the read stays plausible; a
 * read that is junk end to end is refused by a threshold and was never the
 * dangerous case.
 */
const LETTER_SHAPES = [
  ['m', 'rn'],
  ['rn', 'm'],
  ['n', 'r'],
  ['o', 'e'],
  ['a', 'e'],
  ['u', 'v'],
  ['h', 'b'],
  ['t', 'f'],
  ['s', '5'],
  ['g', '9'],
]

/* -------------------------------------------------------------- the rungs */

/** Replace the `nth` (0-based, wrapping) occurrence of `re` in `text`. */
function replaceNth(text, re, replacer, nth) {
  const hits = [...text.matchAll(re)]
  if (!hits.length) return null
  const hit = hits[nth % hits.length]
  return text.slice(0, hit.index) + replacer(hit[0]) + text.slice(hit.index + hit[0].length)
}

export const RUNGS = [
  {
    name: 'identity',
    /** The card's own printed name. The one rung a miss is a bug on its face. */
    apply: (name) => name,
  },
  {
    name: 'case-fold',
    /** Name plates are read in caps far more often than in title case. */
    apply: (name) => {
      const up = name.toUpperCase()
      return up === name ? null : up
    },
  },
  {
    name: 'diacritic-strip',
    /** "Pokémon" → "Pokemon", "Lúthien" → "Luthien" — an eng engine's default. */
    apply: (name) => {
      const flat = name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[ÆæŒœØøÐðÞþ]/g, (c) => ({ Æ: 'AE', æ: 'ae', Œ: 'OE', œ: 'oe', Ø: 'O', ø: 'o', Ð: 'D', ð: 'd', Þ: 'Th', þ: 'th' })[c])
      return flat === name ? null : flat
    },
  },
  {
    name: 'separator-swap',
    /** Hyphen, space and interpunct are one smudge apart on a printed plate. */
    apply: (name, rand) => {
      const moves = []
      if (/[-–—]/.test(name)) moves.push(() => name.replace(/[-–—]/g, ' '), () => name.replace(/[-–—]/g, ''))
      if (/\s/.test(name)) moves.push(() => name.replace(/\s+/g, '-'), () => name.replace(/\s+/g, '·'))
      if (/·/.test(name)) moves.push(() => name.replace(/·/g, ' '))
      if (!moves.length) return null
      const out = pick(rand, moves)()
      return out === name ? null : out
    },
  },
  {
    name: 'glyph-l-i-1',
    /** The classic confusion set; one occurrence, so the read stays plausible. */
    apply: (name, rand) => {
      const nth = Math.floor(rand() * 8)
      const swap = { l: 'I', L: 'I', I: 'l', i: 'l', 1: 'l' }
      return replaceNth(name, /[lLIi1]/g, (c) => swap[c] ?? c, nth)
    },
  },
  {
    name: 'glyph-o-0',
    /** O ↔ 0, the other confusion pair every engine ships with. */
    apply: (name, rand) => {
      const nth = Math.floor(rand() * 8)
      const swap = { O: '0', o: '0', 0: 'O' }
      return replaceNth(name, /[Oo0]/g, (c) => swap[c] ?? c, nth)
    },
  },
  {
    name: 'glyph-shape',
    /** The "Pokemon" → "Petar" class: one word left pronounceable and wrong. */
    apply: (name, rand) => {
      const words = name.split(/(\s+)/)
      const wordIdx = words.map((w, i) => (/\S{4,}/.test(w) ? i : -1)).filter((i) => i >= 0)
      if (!wordIdx.length) return null
      const at = wordIdx[Math.floor(rand() * wordIdx.length) % wordIdx.length]
      const shapes = LETTER_SHAPES.filter(([from]) => words[at].toLowerCase().includes(from))
      if (!shapes.length) return null
      const [from, to] = pick(rand, shapes)
      const lower = words[at].toLowerCase()
      const at2 = lower.indexOf(from)
      words[at] = words[at].slice(0, at2) + to + words[at].slice(at2 + from.length)
      const out = words.join('')
      return out === name ? null : out
    },
  },
  {
    name: 'suffix-mangle',
    /** The variant token survives as something the catalog does not contain. */
    apply: (name, rand) => {
      const split = splitSuffix(name)
      if (!split) return null
      const key = split.suffix.toLowerCase().replace(/[^a-z0-9.δ]/g, '')
      const shapes = SUFFIX_SHAPES[key]
      if (!shapes) return null
      return `${split.base} ${pick(rand, shapes)}`
    },
  },
  {
    name: 'suffix-drop',
    /**
     * The Krookodile shape, and the reason this whole harness exists.
     *
     * A dropped two-letter suffix does not produce a weak read — it produces a
     * PERFECT read of a different, cheaper card, at score 1.0, past every
     * threshold the pipeline has. The pipeline's answer to it is not a
     * threshold at all but the rules box (`parsePokemonVariant` in corner.ts),
     * which a name-only sweep cannot see. So the sweep BUCKETS this rung
     * rather than failing it, and reports the bucket's size: that number is
     * the population the rules-box guard is the only defence for.
     */
    apply: (name) => splitSuffix(name)?.base ?? null,
  },
]

export const RUNG_NAMES = RUNGS.map((r) => r.name)

/**
 * Every rung's query for one card, in ladder order. Rungs that do not apply
 * are returned with `query: null` so a caller can report the applicable
 * denominator honestly instead of inferring it.
 */
export function ladderFor(name, apiId) {
  const seed = hashSeed(apiId)
  return RUNGS.map((rung, i) => ({
    rung: rung.name,
    // A fresh stream per rung, seeded by id and position: adding a rung must
    // not shift what every later rung draws, or the whole corpus re-rolls.
    query: rung.apply(name, seededRandom((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0)) ?? null,
  }))
}
