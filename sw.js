/* Network-first for same-origin app files: always try to fetch the latest
   version first, so code fixes reach the user on next load without needing
   to remember to bump CACHE_NAME. Falls back to the cached copy only when
   the network is unavailable (offline at the gym), which is what keeps the
   app usable without a connection. Cross-origin requests (e.g. Firebase SDK
   imports from gstatic.com) are left alone entirely — never cached, always
   fetched normally, since caching third-party CDN code here isn't useful. */

const CACHE_NAME = 'gym-tracker-cache-v16';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './exercises.js',
  './manifest.json',
  './firebase-config.js',
  './firebase-sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
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
    fetch(event.request)
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
