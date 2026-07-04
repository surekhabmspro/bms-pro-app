/* ══ BMS PRO — OFFLINE APP-SHELL SERVICE WORKER (v4) ═════════════════════
   Goal: the app must open instantly with NO internet connection, on both
   the very first cold start after this SW is installed AND every time
   after (including after a full device/browser restart).

   IMPORTANT FIX IN THIS VERSION: earlier versions hardcoded the exact
   filename "bms-pro-online.html" as the thing to cache and later look
   up. If the file is actually deployed under a different name or path
   (e.g. index.html, a subfolder, a different filename entirely), that
   hardcoded cache lookup silently never matched — so offline mode could
   fail 100% of the time no matter what, regardless of any other fix.
   This version caches and looks things up using whatever URL the
   browser is ACTUALLY requesting, so it works no matter what the file
   is named or where it lives.

   Strategy:
   - Never let install fail. Precaching is best-effort only.
   - The very first time the app is opened online, the real fix happens
     at runtime: the navigation request's own URL is cached as-is. Every
     open after that (online or fully offline) is served from that same
     cache entry instantly, then quietly refreshed in the background.
   - Data/API calls to a different origin (the sync server) are never
     touched here — they always go straight to the network.
   - Old caches from previous versions are cleaned up on activate.

   IMPORTANT: bump CACHE_VERSION any time this file changes, so
   returning users actually receive the update instead of being stuck on
   an old cached shell. This registration also uses
   `{ updateViaCache: 'none' }` and an auto-reload-on-update so browsers
   can't keep serving a stale copy of this very file from their own HTTP
   cache and silently skip the update. ════════════════════════════════ */

const CACHE_VERSION = 'bms-pro-shell-v5';

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      // Best-effort only — never block/fail install over a missing file,
      // since we don't actually know the exact deployed filename here.
      const cache = await caches.open(CACHE_VERSION);
      await Promise.allSettled([
        cache.add('./').catch(() => {}),
        cache.add('./manifest.json').catch(() => {}),
        cache.add('./favicon-32.png').catch(() => {}),
        cache.add('./favicon-16.png').catch(() => {}),
        cache.add('./icon-192.png').catch(() => {}),
        cache.add('./icon-512.png').catch(() => {})
      ]);
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter(n => n !== CACHE_VERSION).map(n => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

function stripQuery(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only handle same-origin requests — sync/API calls to the backend
  // server are left completely untouched, straight to the network.
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(shellFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function shellFirst(req) {
  const cache = await caches.open(CACHE_VERSION);
  const key = stripQuery(req.url);
  const cached = await cache.match(key) || await cache.match(req);

  // Always try to refresh in the background so next time (online or
  // offline) has the latest version — never lets this block the
  // response that's about to be shown.
  const refresh = fetch(req).then(res => {
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  }).catch(() => null);

  if (cached) return cached;
  const fresh = await refresh;
  return fresh || new Response(
    `<!doctype html><html><body style="font-family:sans-serif;background:#121019;color:#F4F2FC;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px">
      <div><h2>Offline — first load not complete yet</h2><p>This device hasn't finished its first successful online load. Please connect to the internet once, open the app, and it will then work offline from then on.</p></div>
    </body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_VERSION);
  const key = stripQuery(req.url);
  const cached = await cache.match(key) || await cache.match(req);
  const refresh = fetch(req).then(res => {
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}
