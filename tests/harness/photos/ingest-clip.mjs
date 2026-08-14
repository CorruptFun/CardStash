/**
 * Bring a real card VIDEO into the harness, as frames.
 *
 * A clip is the only honest sample of what LIVE scanning sees. Every other
 * input here is a still: the fixtures are flat scans, the degradations compose
 * onto a clean backdrop, and even a photograph is a single exposure through
 * the phone's photo pipeline. None of them can show what a video frame is —
 * rolling shutter, codec artefacts, focus hunting, and above all a specular
 * pattern that MOVES, so the card's name is legible in some frames and washed
 * out in others. That last property is the whole reason to have clips: it
 * turns "is this card readable" into "which frame should the scanner have
 * taken", which is a question about the app, not about Tesseract.
 *
 *   node tests/harness/photos/ingest-clip.mjs <video> \
 *     --key=ygo-azure-eyes-clip --game=yugioh --name="Azure-Eyes Silver Dragon" \
 *     --note="secret rare, sleeved, handheld under a ceiling light"
 *
 * Needs ffmpeg. It is NOT a repo dependency — this runs once, by hand, like
 * the Chromium in ingest.mjs. Point FFMPEG_PATH at one, or `npm i --no-save
 * ffmpeg-static` and it is found automatically. Playwright's bundled ffmpeg is
 * built --disable-everything and cannot demux QuickTime, and its Chromium has
 * no H.264 at all, so neither can stand in.
 *
 * Frames are committed, the video is not: a 5s 1080p clip is ~10MB against a
 * 16MB repo, and the harness cannot decode it anyway.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(HERE, 'manifest.json')

/**
 * Sample points across the clip, each a BURST of consecutive frames.
 *
 * The two shapes answer different questions and both are needed. Across
 * bursts: does the clip contain a frame that identifies at all — i.e. is the
 * scanner's job frame SELECTION? Within a burst: do consecutive frames average
 * into something better than any of them — i.e. is it temporal STACKING
 * (`captureFrameStacked`, which today only fires in dark scenes)? Frames 5
 * seconds apart cannot answer the second question, and three frames 33ms apart
 * cannot answer the first.
 */
const BURSTS = 5
const BURST_FRAMES = 3
/** Long edge: what captureFrame hands identifyFrame for a single card. */
const MAX_EDGE = 1600
const QUALITY = 3 // ffmpeg -q:v, ~0.8 JPEG

const positional = []
const args = {}
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, ...rest] = a.slice(2).split('=')
    args[k] = rest.length ? rest.join('=') : true
  } else positional.push(a)
}
const [source] = positional
if (!source || !args.key || !args.game || !args.name) {
  console.error('usage: ingest-clip.mjs <video> --key=… --game=… --name="Card Name" [--note=…] [--label=…]')
  process.exit(2)
}
if (!existsSync(source)) {
  console.error(`No such video: ${source}`)
  process.exit(2)
}

const ffmpeg =
  process.env.FFMPEG_PATH ??
  [join(HERE, '..', '..', '..', 'node_modules', 'ffmpeg-static', 'ffmpeg')].find((p) => existsSync(p))
if (!ffmpeg) {
  console.error('No ffmpeg. Set FFMPEG_PATH, or: npm i --no-save ffmpeg-static')
  process.exit(2)
}
const run = (a) => execFileSync(ffmpeg, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// Duration, so bursts can be spread across the whole clip rather than bunched
// at the start (where a hand is usually still settling).
const probe = (() => {
  try {
    run(['-hide_banner', '-i', source])
    return ''
  } catch (err) {
    return String(err.stderr ?? '')
  }
})()
const durMatch = probe.match(/Duration:\s*(\d+):(\d+):([\d.]+)/)
if (!durMatch) {
  console.error('Could not read the clip duration:\n' + probe.split('\n').slice(-5).join('\n'))
  process.exit(1)
}
const duration = Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
const fpsMatch = probe.match(/([\d.]+)\s*fps/)
const fps = fpsMatch ? Number(fpsMatch[1]) : 30
console.log(`${source}: ${duration.toFixed(2)}s @ ${fps}fps`)

const dir = join(HERE, 'clips', args.key)
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

// Skip the first and last 8%: the start is the hand arriving, the end is it
// leaving, and neither is a frame a scanner would ever have chosen.
const usable = duration * 0.84
const first = duration * 0.08
const frames = []
for (let b = 0; b < BURSTS; b++) {
  const at = first + (usable * b) / Math.max(1, BURSTS - 1)
  const tmp = mkdtempSync(join(tmpdir(), 'clip-'))
  try {
    run([
      '-hide_banner', '-loglevel', 'error',
      '-ss', at.toFixed(3), '-i', source,
      '-frames:v', String(BURST_FRAMES),
      // -vf scale keeps the long edge at MAX_EDGE; ffmpeg applies the
      // container's rotation matrix itself, so a portrait clip comes out
      // portrait rather than needing the fix EXIF needs for photos.
      '-vf', `scale='if(gt(iw,ih),${MAX_EDGE},-2)':'if(gt(iw,ih),-2,${MAX_EDGE})'`,
      '-q:v', String(QUALITY),
      join(tmp, 'f-%02d.jpg'),
    ])
    readdirSync(tmp).sort().forEach((f, i) => {
      const name = `b${b}-${i}.jpg`
      renameSync(join(tmp, f), join(dir, name))
      frames.push({ file: name, at: Number((at + i / fps).toFixed(3)), burst: b, within: i })
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
if (!frames.length) {
  console.error('ffmpeg produced no frames')
  process.exit(1)
}

const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
manifest.clips ??= []
const row = {
  key: args.key,
  game: args.game,
  name: args.name,
  label: args.label ?? 'clip',
  dir: `clips/${args.key}`,
  fps,
  bursts: BURSTS,
  burstFrames: BURST_FRAMES,
  frames,
  ...(args.note ? { note: String(args.note) } : {}),
  ...(args.source ? { source: String(args.source) } : {}),
}
manifest.clips = [...manifest.clips.filter((c) => c.key !== args.key), row]
writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
console.log(`${frames.length} frames → ${dir}`)
console.log(`manifest: clips[${args.key}] — ${args.game} “${args.name}”`)
