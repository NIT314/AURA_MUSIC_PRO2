const CACHE_NAME = 'aura-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/equalizer.js',
  '/js/visualizer.js',
  '/js/jam.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Bypass cache for API streaming requests
  if (e.request.url.includes('/api/')) {
    return;
  }
  
  e.respondWith(
    // 🔥 NETWORK-FIRST STRATEGY: Pehle internet se naya code fetch karo
    fetch(e.request)
      .then((response) => {
        // Agar naya code mil gaya, toh use cache mein update kar lo
        const resClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, resClone);
        });
        return response; // Naya code user ko dikhao
      })
      .catch(() => {
        // Agar internet band hai (Offline), tabhi purana cache serve karo
        return caches.match(e.request).then((cachedResponse) => {
          return cachedResponse || (e.request.mode === 'navigate' ? caches.match('/index.html') : null);
        });
      })
  );
});
