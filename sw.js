// Howdy Summit service worker. Caches static assets for offline use.
// Bump CACHE_VERSION when deploying changes you want users to see immediately.

const CACHE_VERSION = 'howdysummit-v7';
const STATIC_CACHE = `${CACHE_VERSION}-static`;

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  // Precached so the offline shell still renders branded instead of showing
  // a broken image where the logo should be.
  '/logo.png'
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
          // Store the app shell under a single canonical key. Caching by the
          // full request URL would create a separate permanent entry for every
          // distinct query string (?join=CODE group invites, ?q= deep links,
          // utm tags), growing the cache without bound and never serving a hit
          // since the next visitor's code differs. The app is a single-page
          // shell, so one copy answers every navigation.
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then(cache => cache.put('/index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html').then(r => r || caches.match('/')))
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
