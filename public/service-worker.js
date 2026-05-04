// gordy-v6 — increment this string on every index.html or src/ update to bust cache for installed PWA users
var CACHE = 'gordy-v6';

var SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/main.png',
  '/icon.png',
  '/styles.css',
  '/src/geo.js',
  '/src/constants.js',
  '/src/dispersion.js',
  '/src/store.js',
  '/src/viz.js',
  '/src/clubs.js',
  '/src/courses.js',
  '/src/rounds.js',
  '/src/live-round.js',
  '/src/sync.js',
  '/src/caddie.js',
  '/src/ui.js',
  '/src/geomap.js',
  '/src/gps-view.js',
  '/src/shot-tracker.js'
];

// These URLs always require live network — never serve from cache
var NETWORK_ONLY = [
  'gordythevirtualcaddie.workers.dev',
  'github.com/abzabhi/gordy-courses',
  'raw.githubusercontent.com',
  'nominatim.openstreetmap.org/',
  'overpass-api.de/',
  'server.arcgisonline.com/'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(c) { return c.addAll(SHELL); })
  );
  // skipWaiting moved to message handler — only fires on explicit user action
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  var url = e.request.url;

  // Network-only: sync API and course repo — never intercept
  for (var i = 0; i < NETWORK_ONLY.length; i++) {
    if (url.indexOf(NETWORK_ONLY[i]) !== -1) return;
  }

  // Determine strategy: Network-First for HTML and JS, Cache-First for everything else
  var isHtmlOrJs = url.endsWith('/') ||
                   url.endsWith('/index.html') ||
                   url.endsWith('.js') ||
                   url.endsWith('.css');

  if (isHtmlOrJs) {
    // Network-First: always try network, fall back to cache
    e.respondWith(
      fetch(e.request).then(function(response) {
        // Write fresh response back to cache for offline resilience
        if (response && response.status === 200 && response.type === 'basic') {
          var clone = response.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return response;
      }).catch(function() {
        // Network failed — serve cached version if available
        return caches.match(e.request).then(function(cached) {
          return cached || new Response('', { status: 503, statusText: 'Offline' });
        });
      })
    );
  } else {
    // Cache-First: serve from cache, fall back to network
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(response) {
          // Dynamically cache any new valid GET responses (e.g. font files)
          if (response && response.status === 200 && response.type === 'basic') {
            var clone = response.clone();
            caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
          }
          return response;
        }).catch(function() {
          return new Response('', { status: 503, statusText: 'Offline' });
        });
      })
    );
  }
});

// Background sync — fires when connection returns after offline push was queued
self.addEventListener('sync', function(e) {
  if (e.tag === 'gordy-sync') {
    e.waitUntil(self.clients.matchAll().then(function(clients) {
      clients.forEach(function(client) {
        client.postMessage({ type: 'BACKGROUND_SYNC' });
      });
    }));
  }
});

// Update on explicit user action only
self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
