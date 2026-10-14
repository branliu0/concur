// Keeps a copy of the site so that it works offline.
//
// FILES, the ones any PDF needs, are saved on the first visit. The rest -
// fonts and character tables that only some PDFs ask for - are saved the
// first time one does. Online, every file comes fresh from the site (so an
// update shows at once) and the copy is refreshed; offline, the copy is used.
//
// VERSION and FILES are filled in by scripts/build-site.js; a new build has a
// new VERSION, and the old copy is dropped once the new one is saved.
const VERSION = '__VERSION__';
const FILES = __FILES__;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // the examples are for looking at, not for working offline with
  const keep = !url.pathname.includes('/examples/');
  e.respondWith(fetch(e.request).then((r) => {
    if (keep && r.ok) {
      const copy = r.clone();
      e.waitUntil(caches.open(VERSION).then((c) => c.put(e.request, copy)));
    }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || Response.error())));
});
