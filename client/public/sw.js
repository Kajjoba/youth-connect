/**
 * =====================================================================
 * YCP service worker
 *
 * REQ-NFR-007: the application must remain usable through connection
 * interruptions, which the brief names as a core problem for
 * participants across the region.
 *
 * Two strategies, chosen per resource type rather than applied blindly:
 *
 *   Application shell (HTML, JS, CSS)  cache first
 *     These are content-hashed by Vite, so a cached copy is never
 *     stale: a new build produces new filenames. Serving from cache
 *     makes a repeat visit open instantly with no network at all.
 *
 *   API responses                       network first, cache fallback
 *     Data must be fresh when the network allows, so the network is
 *     tried first. The cached copy is the fallback that keeps the app
 *     readable when the connection drops mid-session.
 *
 * Deliberately NOT cached: anything that is not a GET. A queued write
 * belongs in the application's own replay queue where the participant
 * can see it pending, not silently inside a worker.
 * =====================================================================
 */

const VERSION = 'v1';
const SHELL_CACHE = `ycp-shell-${VERSION}`;
const DATA_CACHE = `ycp-data-${VERSION}`;

const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigations fall back to the cached shell so a deep link opened
  // offline still boots the app rather than showing the browser's
  // dinosaur.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);

  try {
    const response = await fetch(request);

    // Only successful responses are stored. Caching a 401 would mean
    // serving a signed-out error to a signed-in participant.
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      // Marked so the interface can tell the participant they are
      // looking at data from their last connection rather than now.
      const headers = new Headers(cached.headers);
      headers.set('X-From-Cache', 'true');
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers
      });
    }
    return new Response(
      JSON.stringify({ error: { code: 'OFFLINE', message: 'You are offline and this has not been loaded before.' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
