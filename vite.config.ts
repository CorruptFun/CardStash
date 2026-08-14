import { createReadStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The self-hosted OCR engine: Tesseract's worker, the two LSTM wasm cores
 * (SIMD + plain — the only ones OEM 1 ever requests; the wasm is embedded in
 * the .wasm.js, so nothing else is fetched) and the English traineddata
 * (4.0.0_best_int — the exact variant tesseract.js v6 would pull from its
 * CDN). Copied from node_modules into `ocr/`: middleware serves them in dev,
 * builds emit them into dist. They are deliberately EXCLUDED from the
 * service-worker precache — only devices that actually scan download them,
 * and sw.js runtime-caches them in its ext cache.
 */
const OCR_ASSETS: Record<string, string> = {
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'core/tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'core/tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'eng.traineddata.gz': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
}

function ocrAssets(): Plugin {
  const source = (route: string) => join(process.cwd(), 'node_modules', ...OCR_ASSETS[route].split('/'))
  return {
    name: 'cardstock-ocr-assets',
    generateBundle() {
      for (const route of Object.keys(OCR_ASSETS)) {
        this.emitFile({ type: 'asset', fileName: `ocr/${route}`, source: readFileSync(source(route)) })
      }
    },
    configureServer(server) {
      server.middlewares.use('/ocr', (req, res, next) => {
        const route = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0])
        if (!OCR_ASSETS[route]) return next()
        res.setHeader('Content-Type', route.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        createReadStream(source(route))
          .on('error', () => {
            res.statusCode = 404
            res.end()
          })
          .pipe(res)
      })
    },
  }
}

/**
 * Emits sw.js from src/sw.js with the build id and precache manifest stamped
 * in. The worker itself is plain JS — keeping it out of the module graph means
 * its lifecycle is governed only by the registration, never by Vite hashing.
 */
function serviceWorker(): Plugin {
  return {
    name: 'cardstock-sw',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        // ocr/ is the lazily-fetched OCR engine — runtime-cached, never precached.
        .filter((f) => f !== 'sw.js' && !f.startsWith('ocr/'))
        .map((f) => `./${f}`)
      const precache = [...assets, './index.html', './manifest.webmanifest', './favicon.svg']
        .concat(['./icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png'])
        .sort()
      const build = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      const src = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace('__BUILD_ID__', build)
        .replace('"__PRECACHE_MANIFEST__"', JSON.stringify(precache))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), ocrAssets(), serviceWorker()],
  build: {
    assetsInlineLimit: 0,
    /**
     * The 500 kB default is a false alarm here, and silencing it is the
     * considered answer rather than the lazy one (docs/roadmap.md round 5).
     * The main chunk is ~630 kB raw but ~200 kB gzipped, and the service worker
     * precaches it as ONE build-keyed unit that is then served from cache
     * offline — so splitting buys nothing on repeat visits and actively costs
     * robustness: precache is all-or-nothing for critical assets, so more
     * chunks means more ways for a half-installed shell to become a
     * permanently blank offline launch (decision 8). The genuinely large
     * payload is the ~11 MB OCR engine, already excluded from precache and
     * fetched only by devices that actually scan.
     */
    chunkSizeWarningLimit: 800,
  },
})
