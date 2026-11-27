// Steadwell Luka PWA Service Worker — fast offline app shell without interfering with live APIs or streams.
const CACHE_NAME = 'luka-mission-control-v1';
const SHELL_ASSETS = [
  './beat-the-bot.html',
  './beat-the-bot.css',
  './favicon.svg',
  './manifest.webmanifest',
  './src/beat-the-bot.js',
  './src/beat-the-bot-engine.mjs',
  './src/scenario-packs.js',
  './src/qr-svg.js',
  './src/voice-duplex.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/sim-api/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/rpc/')) return;

  // Network-first so fresh deploys appear immediately, falling back cleanly to cache offline
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok && res.type === 'basic' && !url.pathname.endsWith('.bin')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request)),
  );
});
