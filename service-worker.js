// BMS Pro — Service Worker
// ----------------------------------------------------------------------------
// What this does, in plain terms:
//  - Caches the app's own HTML/icon files so the app SCREEN can open even
//    with zero internet (your business DATA already works offline via
//    localStorage + the sync system — this just makes the app itself
//    installable like a real app, with an icon, and able to launch offline).
//  - Every time you reconnect, it quietly checks for a newer version of the
//    app file and updates the cache for next time — it never blocks you from
//    using whatever version is already cached.
// ----------------------------------------------------------------------------
const CACHE_NAME = 'bms-pro-shell-v1';
const SHELL_FILES = [
  './bms-pro-online.html',
  './manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
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
  // Only handle our own app-shell files this way. Everything else (your
  // backend API calls, etc.) passes straight through untouched.
  const url = new URL(event.request.url);
  const isShellFile = SHELL_FILES.some((f) => url.pathname.endsWith(f.replace('./', '/')));
  if (!isShellFile) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resp.clone()));
          return resp;
        })
        .catch(() => cached); // offline — fall back to cached copy
      return cached || network;
    })
  );
});
