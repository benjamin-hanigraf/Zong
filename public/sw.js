/**
 * Zong Service Worker
 *
 * Strategy:
 *  - On install: pre-cache the app shell (HTML + icons) and skip waiting so
 *    the new worker activates immediately on all platforms.
 *  - On activate: delete old caches so stale bundles never block startup.
 *  - On fetch (GET only):
 *      1. HTML navigation → serve the shell from cache, update in background
 *         (stale-while-revalidate) so the app opens instantly every time.
 *      2. Same-origin JS/CSS/font assets → cache-first with network fallback
 *         so the main bundle is served from cache after the first visit,
 *         preventing the "stuck before opening" freeze on slow connections.
 *      3. External/API requests (Supabase, CDNs) → network-only; never cache
 *         dynamic data.
 *
 * Bump CACHE_VERSION when you deploy a new build to force cache refresh.
 */

const CACHE_VERSION = 'zong-v2';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const ASSET_CACHE   = `${CACHE_VERSION}-assets`;

// Core shell files that must be pre-cached at install time
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

// ── Install: pre-cache shell, activate immediately ─────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())   // don't wait for old tabs to close
  );
});

// ── Activate: remove every cache from previous versions ────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())  // take control of all open pages now
  );
});

// ── Fetch ──────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip non-http(s) schemes (e.g. chrome-extension://)
  if (!url.protocol.startsWith('http')) return;

  // Skip external API/CDN requests (Supabase, fonts loaded at runtime, etc.)
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return;

  // ── HTML navigation: stale-while-revalidate ─────────────────────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match('/index.html');
        // Kick off a background refresh regardless
        const networkFetch = fetch(request).then((res) => {
          if (res.ok) cache.put('/index.html', res.clone());
          return res;
        }).catch(() => null);
        // Return cached shell immediately if available; otherwise wait for network
        return cached || networkFetch || caches.match('/index.html');
      })
    );
    return;
  }

  // ── Same-origin JS / CSS / images: cache-first with network fallback ────
  // This ensures the Vite bundle is served from cache on subsequent opens,
  // preventing the startup freeze seen on slower Android devices.
  event.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      try {
        const response = await fetch(request);
        // Only cache successful, non-opaque responses
        if (response.ok && response.type !== 'opaque') {
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        // Network failed and no cache — return a simple offline fallback
        return caches.match('/index.html');
      }
    })
  );
});
