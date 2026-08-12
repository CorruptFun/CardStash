import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

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
        .filter((f) => f !== 'sw.js')
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
  plugins: [react(), serviceWorker()],
  build: { assetsInlineLimit: 0 },
})
