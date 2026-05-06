// Howdy Nash service worker. Caches static assets for offline use.
// Bump CACHE_VERSION when deploying changes you want users to see immediately.

const CACHE_VERSION = 'howdynash-v49';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const STATIC_ASSETS = [
  '/',
  '/nashville-chatbot.html',
  '/manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => !n.startsWith(CACHE_VERSION)).map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Never intercept non-GET requests. The Cache API only supports GET.
  // POST/PUT/DELETE need to pass through to the network untouched.
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Never cache API responses (they need to be fresh).
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-first for HTML, cache-first for everything else.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then(r => r || caches.match('/nashville-chatbot.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(STATIC_CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
