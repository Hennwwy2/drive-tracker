const CACHE_NAME = 'drive-tracker-v2';
const ASSETS = [
  '/',
  '/index.html',
  '/tracker.html',
  '/route-setup.html',
  '/settings.html',
  '/shared.css',
  '/route.js',
  '/predictor.js',
  '/firebase.js',
  '/tracker.js',
  '/manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for API calls, Firebase, and map tiles
  if (url.hostname !== location.hostname &&
      !url.href.startsWith('https://unpkg.com/leaflet')) {
    return;
  }

  // Cache-first for app shell
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
