/* ================================================================================================
   Service worker for Qpy Engage.

   Its only job is to make the app shell load instantly and survive a flaky connection. It never
   caches anything from the API. A support inbox that serves a stale conversation is worse than one
   that fails to load: an agent would reply to a message that has already been answered, or miss the
   one that arrived while they were on the underground.
   ============================================================================================== */

const SHELL_CACHE = "qpy-shell-v1";

// Only the frame. Hashed build assets are cached opportunistically as they are requested, because
// their names change every deploy and listing them here would go stale immediately.
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  // Take over as soon as the new worker is ready. Waiting for every tab to close means a bug fix
  // can sit undelivered for days on a phone that is never fully closed.
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)).catch(() => null));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL_CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isApiRequest(url) {
  // The API lives on its own origin, so anything cross-origin is left entirely alone. The /api
  // prefix is also checked in case the app is ever served from the same host as the worker.
  return url.origin !== self.location.origin || url.pathname.startsWith("/api/");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isApiRequest(url)) return; // straight to the network, never cached

  // Navigations are network-first so a deploy is picked up immediately, falling back to the cached
  // shell only when the network genuinely fails.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL_CACHE);
        cache.put("/", fresh.clone()).catch(() => null);
        return fresh;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // Build assets are content-hashed, so a cache hit is always correct and the network is only
  // consulted the first time each new filename appears.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh.ok && fresh.type === "basic") {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, fresh.clone()).catch(() => null);
      }
      return fresh;
    } catch {
      return cached || Response.error();
    }
  })());
});
