// Minimal service worker for offline-friendly behaviour.
//
// Strategy: cache-first for the app shell (eraser.html + manifest), with
// stale-while-revalidate behaviour for everything else (AI model files,
// JSZip CDN, transformers.js CDN). The huge AI weights are the most
// painful to re-fetch, so we explicitly cache them on first hit.
//
// Bump CACHE_VERSION to force a refresh on next load.

const CACHE_VERSION = 'v1';
const SHELL = 'eraser-shell-' + CACHE_VERSION;
const RUNTIME = 'eraser-runtime-' + CACHE_VERSION;

const SHELL_FILES = [
  './eraser.html',
  './manifest.webmanifest',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL).then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL && k !== RUNTIME).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // App shell: cache-first.
  if (SHELL_FILES.some(p => req.url.endsWith(p.replace('./', '')))) {
    event.respondWith(
      caches.match(req).then(r => r || fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
        return resp;
      }))
    );
    return;
  }

  // Everything else: stale-while-revalidate via runtime cache.
  event.respondWith(
    caches.open(RUNTIME).then(cache =>
      cache.match(req).then(cached => {
        const networkFetch = fetch(req).then(resp => {
          // Don't cache opaque error responses.
          if (resp && resp.status === 200) cache.put(req, resp.clone());
          return resp;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    )
  );
});
