/* ══ BMS PRO — OFFLINE APP-SHELL SERVICE WORKER ══════════════════════════
   Goal: the app must open instantly with NO internet connection, on both
   the very first cold start after this SW is installed AND every time
   after (including after a full device/browser restart).

   Strategy:
   - On install, download and cache the app shell (this HTML file, the
     manifest, and the icons) into a versioned cache.
   - On every navigation (i.e. opening/reloading the app), serve the
     cached shell INSTANTLY so it never depends on the network being up,
     then quietly re-fetch a fresh copy in the background to keep the
     cache current for next time ("stale-while-revalidate"). If the
     network fetch fails (offline), the cached copy already shown is all
     that's needed — nothing breaks.
   - Data/API calls (anything going to the configured sync server) are
     NEVER cached here — they always hit the network directly, so sync
     behaves exactly as the app's own online/offline logic expects.
   - Old caches from previous versions are cleaned up on activate so
     updates don't pile up storage.

   IMPORTANT: bump CACHE_VERSION any time this file OR the app's file
   list changes, so returning users actually receive the update instead
   of an old cached shell forever. ════════════════════════════════════ */

const CACHE_VERSION = 'bms-pro-shell-v2';

// Files that make up the app shell. Keep this list in sync with what's
// actually deployed next to this service-worker.js file. If a file in
// this list doesn't exist on the server, its cache.addAll() call will
// fail the whole install step — so this list intentionally sticks to
// files that should always be present.
const SHELL_FILES = [
  './',
  './bms-pro-online.html',
  './manifest.json'
];

// Optional extras — nice to have offline (icons for the install prompt /
// home screen) but must NOT block install if missing on the server.
const OPTIONAL_FILES = [
  './favicon-32.png',
  './favicon-16.png',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Required shell files: fail loudly if these can't be cached.
      await cache.addAll(SHELL_FILES);
      // Optional files: best-effort, never block install on a 404.
      await Promise.all(
        OPTIONAL_FILES.map(url =>
          cache.add(url).catch(() => {/* fine if missing */})
        )
      );
      // Activate this new SW immediately instead of waiting for the old
      // one to be released (all tabs closed) — users get the offline fix
      // the moment they load the page once with internet, not on some
      // later visit.
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(n => n !== CACHE_VERSION)
          .map(n => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// Never intercept anything that isn't a plain GET (POST/PUT to the sync
// API must always go straight to the network, untouched).
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Only handle requests to this same origin/app. Sync/API calls to a
  // different origin (the server backend) are left completely alone —
  // they go straight to the network so online/offline sync logic in the
  // app itself behaves exactly as it already does.
  if (url.origin !== self.location.origin) return;

  // Navigations (opening the app / hitting refresh) — this is the case
  // that MUST work with zero internet connection.
  if (req.mode === 'navigate') {
    event.respondWith(shellFirst(req));
    return;
  }

  // Everything else same-origin (css/js/images/manifest/icons) —
  // stale-while-revalidate: instant from cache, refreshed in background.
  event.respondWith(staleWhileRevalidate(req));
});

async function shellFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match('./bms-pro-online.html') || await cache.match(req);
  // Kick off a background refresh so the next offline open has the
  // latest version, but never let it block or break the current load.
  const refresh = fetch(req).then(res => {
    if (res && res.ok) cache.put('./bms-pro-online.html', res.clone());
    return res;
  }).catch(() => null);

  if (cached) return cached;
  // Nothing cached yet (shouldn't normally happen) — try the network,
  // and only fail if that also fails.
  const fresh = await refresh;
  return fresh || new Response(
    '<h1>Offline</h1><p>This app has not finished its first online load yet. Please connect to the internet once, then it will work offline from then on.</p>',
    { headers: { 'Content-Type': 'text/html' } }
  );
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(req);
  const refresh = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}
