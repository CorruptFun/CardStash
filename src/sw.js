/* Cardstock service worker — hand-rolled, three caches:
 *   shell : precached build assets (cache-first, versioned by build id)
 *   img   : card images from the data-source CDNs (stale-while-revalidate, capped)
 *   ext   : the lazily-loaded OCR engine, self-hosted under ocr/ (cache-first;
 *           deliberately NOT precached so only devices that scan download it)
 * Price/search API calls are never cached — prices must be live.
 */

const BUILD = '__BUILD_ID__';
const SHELL = `cardstock-shell-${BUILD}`;
// Version-suffixed so a bad entry is recoverable by shipping a deploy: activate
// sweeps every cardstock-* cache that isn't one of these three. Opaque
// responses are unreadable — no status, no headers, no body length — so
// whatever slips in is otherwise permanent; bumping the suffix is the cure.
const IMG = 'cardstock-img-v2';
// v3: the OCR engine moved from third-party CDNs to our own ocr/ directory —
// the bump drops the orphaned CDN payloads (~10 MB) on activate.
const EXT = 'cardstock-ext-v3';
const KEEP = [SHELL, IMG, EXT];
const PRECACHE = "__PRECACHE_MANIFEST__";
const IMG_LIMIT = 480;

const IMAGE_HOSTS = [
  'cards.scryfall.io',
  'images.pokemontcg.io',
  'images.ygoprodeck.com',
  'tcgplayer-cdn.tcgplayer.com',
  'cards.lorcast.io',
];
const EXT_HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'unpkg.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Per-asset, not addAll: addAll is atomic, so one 404 (a stale manifest
      // entry, a host that rewrites paths) would leave the app with no offline
      // shell at all. `reload` keeps the HTTP cache from serving a stale copy.
      const failed = new Set();
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch {
            failed.add(url);
          }
        }),
      );
      // ...but tolerating *some* loss is not the same as tolerating any. The
      // entry document and the scripts/styles it names are the app: activate
      // deletes the previous shell, so committing a half-installed one turns
      // the next offline launch into a permanently blank screen. Throwing here
      // keeps the old worker — and its complete shell — serving.
      const missing = await missingCritical(cache, failed);
      if (missing.length) {
        await caches.delete(SHELL);
        throw new Error(`Precache incomplete, keeping the previous shell: ${missing.join(', ')}`);
      }
      // Deliberately NO skipWaiting here: an update that activates mid-session
      // strands the running bundle on caches that no longer hold its hashed
      // assets. The new worker waits; the page shows a restart toast and sends
      // SKIP_WAITING when the user taps it (or the next launch activates it).
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** Which precached assets index.html actually needs to boot, and didn't get. */
async function missingCritical(cache, failed) {
  const entry = PRECACHE.find((url) => url.endsWith('index.html'));
  if (!entry) return []; // no HTML entry in the manifest — nothing to promise
  if (failed.has(entry)) return [entry];
  const res = await cache.match(new Request(entry), { ignoreVary: true });
  if (!res) return [entry];
  let html = '';
  try {
    html = await res.text();
  } catch {
    return []; // unreadable body isn't evidence of a bad install
  }
  const abs = (url) => new URL(url, location.href).href;
  const failedAbs = new Set([...failed].map(abs));
  const missing = [];
  // The script and stylesheet the entry document names. Icons and the
  // webmanifest are `href`s too but the app boots fine without them, so
  // criticality stops at code: a missing chunk is a blank screen.
  for (const m of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    let ref;
    try {
      ref = new URL(m[1], abs(entry));
    } catch {
      continue; // data: URI, mailto:, junk — not a shell asset
    }
    if (!/\.(?:m?js|css)$/i.test(ref.pathname)) continue;
    if (failedAbs.has(ref.href) && !missing.includes(ref.href)) missing.push(ref.href);
  }
  return missing;
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('cardstock-') && !KEEP.includes(k)).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return; // not a URL we can reason about — leave it to the network
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // App shell: navigations fall back to the cached index for offline start.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        // The shell's asset URLs are relative (`base: './'`), so it can only
        // boot from the scope directory: served at /deep/path they resolve to
        // /deep/assets/… and 404. Routing is by hash, so nothing is lost by
        // sending the browser home first.
        const root = new URL('./', location.href);
        const dir = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
        if (url.origin === location.origin && dir !== root.pathname) {
          return Response.redirect(root.href, 302);
        }
        const cached = await caches.match('./index.html', { cacheName: SHELL, ignoreVary: true });
        return cached ?? new Response('Offline', { status: 503, statusText: 'Offline' });
      }),
    );
    return;
  }

  if (url.origin === location.origin) {
    // The self-hosted OCR engine (worker/wasm/traineddata under ocr/) is big
    // and lazily fetched — runtime-cached like the CDN engine it replaces,
    // and kept out of the precache so non-scanning devices never pay for it.
    if (url.pathname.includes('/ocr/')) {
      event.respondWith(cacheFirstExt(req));
      return;
    }
    event.respondWith(
      caches
        // ignoreVary: precache entries are stored from SW-made Requests, which
        // carry no headers at all, while the document's own asset requests
        // carry Origin. A host that answers `Vary: Origin` (vite preview does)
        // makes every one of those lookups miss — invisible while the network
        // is up, a blank app the moment it isn't. Every cache here is
        // single-variant by construction, so honouring Vary buys nothing.
        .match(req, { cacheName: SHELL, ignoreVary: true })
        .then((hit) => hit ?? fetch(req)),
    );
    return;
  }

  if (IMAGE_HOSTS.includes(url.host)) {
    event.respondWith(staleWhileRevalidate(req, IMG));
    return;
  }

  if (EXT_HOSTS.includes(url.host)) {
    event.respondWith(cacheFirstExt(req));
    return;
  }
  // Everything else (price APIs, Gemini) goes straight to the network.
});

/**
 * The OCR engine: cache-first, so a bad entry here is the one that really
 * hurts — nothing ever revalidates it, and OCR stays broken on that device
 * until the cache name changes.
 *
 * Tesseract fetches its wasm and traineddata `no-cors`, and an opaque response
 * carries no JS-observable signal at all: `status` is 0, the headers are
 * filtered away and the body reads as zero bytes however large it really is.
 * A CDN 403 and a 12 MB payload are literally the same object. So instead of
 * guessing, ask for a response we're allowed to read: all three EXT hosts send
 * `Access-Control-Allow-Origin: *`, so a `cors` request gets a real status and
 * we can cache honestly on `res.ok`. Handing that response to a `no-cors`
 * consumer is fine — it's strictly more readable than what it asked for.
 */
async function cacheFirstExt(req) {
  const cache = await caches.open(EXT);
  // ignoreVary throughout: one URL, one payload — see the same-origin note above.
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(new Request(req.url, { mode: 'cors', credentials: 'omit' }));
    // A readable failure is the whole point: return it, don't store it.
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    // A host that doesn't send ACAO (or a network blip on the cors attempt) —
    // fall back to the plain request and take the opaque payload on trust, the
    // way this cache always did. The version suffix on EXT is the escape
    // hatch: bumping it drops anything that turned out to be junk.
  }
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    return Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreVary: true });
  const refresh = fetch(req)
    .then((res) => {
      // Card images are `no-cors` too, so `res.ok` is false for a perfectly
      // good image and opaque is all we get. Unlike the ext cache, poisoning
      // here is self-healing: this is stale-while-revalidate, so the very next
      // request overwrites the entry with whatever the CDN says now, FIFO
      // eviction bounds it at IMG_LIMIT, and the versioned cache name clears
      // the lot on a deploy. Worst case is one blank card until it's asked for
      // again — cheaper than refusing to cache images at all.
      if (res.ok || res.type === 'opaque') {
        // Not awaited: a quota failure must not fail the response we're serving.
        cache.put(req, res.clone()).then(() => trimCache(cache)).catch(() => {});
      }
      return res;
    })
    // respondWith requires a Response — a rejected revalidate with no cached
    // copy previously resolved to `undefined` and blew up inside the SW.
    .catch(() => hit ?? Response.error());
  return hit ?? refresh;
}

let trimming = false;
async function trimCache(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > IMG_LIMIT) {
      // FIFO eviction — keys() preserves insertion order.
      for (const key of keys.slice(0, keys.length - IMG_LIMIT)) await cache.delete(key);
    }
  } finally {
    trimming = false;
  }
}
