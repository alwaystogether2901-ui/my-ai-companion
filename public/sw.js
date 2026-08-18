/*
 * Always Together — service worker.
 *
 * Served as a real static file from /public, so /sw.js is always a 200 (the
 * previous generated-SW setup never emitted a file into the deployed output,
 * which is why production logged repeated 404s for /sw.js).
 *
 * Deliberately conservative: never caches HTML documents, API responses,
 * server functions, storage objects or anything carrying auth. Only
 * fingerprinted static build assets are cached.
 */
const VERSION = "at-v1";
const ASSET_CACHE = `${VERSION}-assets`;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

function isCacheableAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/_serverFn")) return false;
  if (url.pathname.startsWith("/api/")) return false;
  return /\.(?:js|css|woff2?|png|svg|ico|webp|avif)$/i.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (!isCacheableAsset(url)) return; // documents & data always go to the network

  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") cache.put(request, response.clone());
        return response;
      } catch (error) {
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});
