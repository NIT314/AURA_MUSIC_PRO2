const CACHE_NAME = 'aura-v9'; // Updated: icons removed from mandatory cache
const ASSETS = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/equalizer.js',
  'js/visualizer.js',
  'js/jam.js',
  'manifest.json'
  // Icons cached lazily on first fetch — not blocking SW install
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          // 🔥 FIX: 'aura-audio-cache' ko delete hone se bachaya (Offline gaane safe rahenge)
          if (key !== CACHE_NAME && key !== 'aura-audio-cache') {
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
    fetch(e.request)
      .then((response) => {
        // 🔥 FIX 1: Sirf 'opaque' (YouTube Thumbnails) ko cache hone se roko. 
        // Fonts aur CSS (cors/basic) ko cache hone do.
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        
        const resClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(e.request, resClone);
        });
        return response;
      })
      .catch(() => {
        return caches.match(e.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse; // Cache mil gaya toh de do
          if (e.request.mode === 'navigate') return caches.match('/index.html');
          return Response.error(); // 🔥 FIX 2: Null ki jagah proper error do jisse TypeError na aaye
        });
      })
  );
});