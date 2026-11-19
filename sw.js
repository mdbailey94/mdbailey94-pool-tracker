// Offline support. App files go to the network first so files from different
// releases are never mixed; the cached copy is used only when offline.
// The pose model files (vendor/mediapipe/) are large and never change for a
// given version, so they are cached on first use and served cache-first.
const PREFIX = 'jump-height-';
const CACHE = `${PREFIX}v1`;
// Named after the vendored MediaPipe version: change it whenever those files
// change, so an old bundle is never served alongside a new wasm or model.
const VENDOR_CACHE = `${PREFIX}mediapipe-0.10.14`;
const ASSETS = [
  './', 'index.html', 'app.css', 'manifest.webmanifest', 'icon.svg', 'icon-180.png',
  'src/app.js', 'src/capture.js', 'src/pose.js', 'src/jump.js', 'src/lanes.js', 'src/store.js',
];
const VENDOR = 'vendor/mediapipe/';
const VENDOR_FILES = [
  'vision_bundle.mjs', 'vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'pose_landmarker_lite.task',
].map((f) => VENDOR + f);

const abs = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (e) => {
  // One file failing must not stop the install.
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(ASSETS.map((url) => c.add(new Request(url, { cache: 'reload' })))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // Cache Storage is shared by every app on this origin (all of a user's
      // GitHub Pages sites), so only this app's own old caches are removed.
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith(PREFIX) && k !== CACHE && k !== VENDOR_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(warmVendor),
  );
});

// Fetch the model files in the background, one at a time. Never blocks or fails the install.
async function warmVendor() {
  try {
    const c = await caches.open(VENDOR_CACHE);
    for (const f of VENDOR_FILES) {
      if (await c.match(abs(f))) continue;
      try {
        const res = await fetch(abs(f));
        if (res.ok) await c.put(abs(f), res);
      } catch { /* try again on next start */ }
    }
  } catch { /* ignore */ }
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isVendor = url.pathname.includes(`/${VENDOR}`);
  e.respondWith((async () => {
    if (isVendor) {
      const cached = await caches.match(url.href, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(e.request);
      if (res.ok && res.status === 200) {
        const copy = res.clone();
        caches.open(VENDOR_CACHE).then((c) => c.put(url.href, copy));
      }
      return res;
    }
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
