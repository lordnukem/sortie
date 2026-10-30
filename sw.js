// Offline play, and the installability Chrome asks for before it will offer "Install".
//
// Two rules, because the two kinds of file fail differently:
//   - the page itself goes network-first, so a deploy is picked up on the next load rather than
//     being shadowed by a cached copy until someone clears their site data;
//   - everything else goes cache-first, because the assets are large, immutable in practice, and
//     the whole point is that a bad connection does not stop a sortie.
// Bumping CACHE on deploy drops the previous generation wholesale.
const CACHE = 'sortie-v6';

// Fetched eagerly on install so the first offline launch works. Deliberately short: the voice
// pack and ship models are large and arrive on demand through the cache-first path.
const CORE = [
  './',
  './index.html',
  './assets/ship-models.js',
  './assets/icon/ship-192.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // One at a time and forgiving: a single 404 in addAll rejects the whole install.
    await Promise.all(CORE.map((u) => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // The leader board is never cached: a stale board is worse than no board.
  if (url.pathname.startsWith('/api/')) return;
  // Cross-origin (fonts, CDN modules) is left to the browser's own HTTP cache.
  if (url.origin !== location.origin) return;

  const isPage = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isPage) {
    e.respondWith((async () => {
      try {
        const net = await fetch(req);
        const c = await caches.open(CACHE);
        c.put(req, net.clone());
        return net;
      } catch {
        return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const net = await fetch(req);
      if (net.ok && net.type === 'basic') (await caches.open(CACHE)).put(req, net.clone());
      return net;
    } catch {
      return hit || Response.error();
    }
  })());
});
