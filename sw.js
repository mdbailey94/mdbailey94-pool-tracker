// Offline support (pool decks often have poor Wi-Fi). Every request goes to
// the network first so files from different releases are never mixed; the
// cached copy is used only when offline.
const CACHE = 'pool-tracker-v1';
const ASSETS = [
  './', 'index.html', 'pool.css', 'manifest.webmanifest', 'icon.svg',
  'src/app.js', 'src/capture.js', 'src/grid.js', 'src/homography.js', 'src/laps.js',
  'src/session.js', 'src/store.js', 'src/strokes.js', 'src/tracker.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.href, copy));
      }
      return res;
    } catch {
      const cached = await caches.match(url.href, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});
