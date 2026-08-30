/* Network-first for same-origin app files: always try to fetch the latest
   version first, so code fixes reach the user on next load without needing
   to remember to bump CACHE_NAME. The fetch itself uses {cache:'reload'} to
   bypass the browser's own HTTP cache too, not just this service worker's —
   otherwise "network-first" could still silently serve a locally-cached
   response depending on the host's cache headers. Falls back to the cached
   copy only when the network is unavailable (offline at the gym), which is
   what keeps the app usable without a connection. Cross-origin requests
   (e.g. Firebase SDK imports from gstatic.com) are left alone entirely —
   never cached, always fetched normally, since caching third-party CDN
   code here isn't useful. */

const CACHE_NAME = 'gym-tracker-cache-v48';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './exercises.js',
  './manifest.json',
  './firebase-config.js',
  './firebase-sync.js',
  './groups.js',
  './muscle-map-bridge.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './body/MuscleMap.js',
  './body/registry.js',
  './body/constants.js',
  './body/front.js',
  './body/back.js',
  './body/male-front-dark.webp',
  './body/male-back-dark.webp'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = event.request.url;
  if (!url.startsWith(self.location.origin)) return; // let cross-origin requests pass through untouched

  event.respondWith(
    // 'reload' forces this fetch to bypass the *browser's own* HTTP cache
    // (separate from this service worker's Cache Storage) and genuinely
    // hit the network — without it, "network-first" is only as fresh as
    // whatever cache headers the host happens to send, which could still
    // silently hand back a locally-cached response instead of the actual
    // latest deploy.
    fetch(event.request, { cache: 'reload' })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request)) // offline fallback to last cached copy
  );
});

// Tapping a rest-timer (or other local) notification should bring the app
// to the foreground instead of just dismissing it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
