// sw.js — Service Worker v50 (arquitectura v2). Network-first para archivos propios;
// nunca intercepta API, WebSockets, Telegram, TON Connect ni CDNs (origen distinto).
const CACHE_VERSION = 'v50';
const CACHE_NAME = `alphabunker-${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './privacy.html',
  './terms.html',
  './css/style.css',
  './css/hybrid.css',
  './js/config.js',
  './js/translations.js',
  './js/translations_patch.js',
  './js/hybrid_bridge.js',
  './js/media_manager.js',
  './js/api_v2.js',
  './js/chat_v2.js',
  './js/ui_bridge.js',
  './js/webrtc_room.js',
  './js/app.js',
  './js/app_secure.js',
];

self.addEventListener('install', (event) => {
  // Precarga tolerante: un archivo ausente no debe impedir la instalación.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => null)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Borra cachés v1 (alphatom-vault-*) y versiones anteriores, que contenían api.js/chat.js inseguros.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // API, wss, Telegram, TON, CDNs: red directa

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
