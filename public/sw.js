/* VasulBook service worker: app shell offline, last ledger data offline, fonts cached. */
const VERSION = "vb-v5";
const SHELL = ["/", "/app", "/app.css", "/app.js", "/ledger.js", "/i18n/meta.js", "/landing.css", "/landing.js", "/manifest.webmanifest",
  "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"];
const DATA = "vb-data";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== DATA && !k.startsWith("vb-fonts")).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("message", (e) => {
  if (e.data === "clear-data") caches.delete(DATA);
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Google Fonts: cache first
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open("vb-fonts").then(async (c) => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  // Ledger data and account: network first, fall back to the last copy when offline
  if (url.pathname === "/api/data" || url.pathname === "/api/me" || url.pathname === "/api/config") {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(DATA).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.open(DATA).then((c) => c.match(req)).then((hit) => hit || Response.error())));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/") || url.pathname === "/whatsapp") return;

  // Page navigations: network first, shell when offline
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(url.pathname.startsWith("/app") ? "/app" : "/")));
    return;
  }
  // Static files: stale while revalidate
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
