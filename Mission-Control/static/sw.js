// Mission Control Service Worker — NUKE MODE
// Deletes all caches on activate, does NOT cache anything (pure pass-through).
// Required only for iOS PWA install; never interferes with content.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// No fetch handler → all requests bypass SW and go to network directly.
