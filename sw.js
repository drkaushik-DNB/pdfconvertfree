/* PDF Convert Free offline cache.
   Site files: network first (always newest when online), cache when offline.
   Converter libraries from CDNs: cache first (they never change). */
const CACHE = 'pdfconvertfree-v5';
const CORE = ['./', './index.html', './app.js', './i18n.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !/^https?:/.test(req.url)) return;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  e.respondWith(caches.open(CACHE).then(async c => {
    if (sameOrigin) {
      try {
        const r = await fetch(req, { cache: 'no-cache' });
        if (r && r.ok) c.put(req, r.clone());
        return r;
      } catch (err) {
        return (await c.match(req)) || (await c.match('./index.html')) || Response.error();
      }
    }
    const hit = await c.match(req);
    if (hit) return hit;
    const r = await fetch(req);
    if (r && (r.ok || r.type === 'opaque')) c.put(req, r.clone());
    return r;
  }));
});
