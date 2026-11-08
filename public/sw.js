// public/sw.js — service worker Nokos.ID V2
// Strategi: stale-while-revalidate untuk aset statis, network-first untuk API,
// fallback ke halaman offline bila gagal.

const CACHE = "nokos-id-v2";
const PRECACHE = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest", "/assets/nokos-logo.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API: network-first, jangan cache
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({ error: "offline" }), { status: 503, headers: { "Content-Type": "application/json" } })));
    return;
  }
  // Aset statis: stale-while-revalidate
  if (e.request.method === "GET") {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(e.request);
        const fetchPromise = fetch(e.request).then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      }),
    );
  }
});
