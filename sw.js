const CACHE_NAME = "gecaf-inv-v20";
const PAGE_FALLBACK = "./";
const ASSETS = [PAGE_FALLBACK, "./styles.css", "./app.js", "./supabase-config.js", "./manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of ASSETS) {
        const response = await fetch(asset, { cache: "reload", redirect: "follow" });
        if (isCacheable(response)) await cache.put(asset, response);
      }
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (requestUrl.pathname.endsWith("/rescue") || requestUrl.pathname.endsWith("/rescue.html")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(handleNavigation(event.request));
    return;
  }

  if (!isShellAsset(requestUrl)) return;

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached?.redirected) cached = null;
      return cached || fetch(event.request, { cache: "reload", redirect: "follow" });
    }),
  );
});

async function handleNavigation(request) {
  try {
    const response = await fetch(request, { redirect: "follow" });
    if (isCacheable(response)) return response;
  } catch {}

  const cached = await caches.match(PAGE_FALLBACK, { ignoreSearch: true });
  if (cached && !cached.redirected) return cached;

  return fetch(PAGE_FALLBACK, { cache: "reload", redirect: "follow" });
}

function isCacheable(response) {
  return Boolean(response && response.ok && !response.redirected && response.type !== "opaqueredirect");
}

function isShellAsset(url) {
  const path = "." + url.pathname.replace(/^\//, "/");
  return ASSETS.includes(path) || (url.pathname === "/" && ASSETS.includes(PAGE_FALLBACK));
}
