// Service worker généré au build par le plugin Vite de vite.config.ts.
// Les URLs de précache et la version sont injectées à la génération de dist/sw.js.

const VERSION = '__VERSION__';
const PRECACHE = `precache-${VERSION}`;
const RUNTIME = `runtime-${VERSION}`;
const PRECACHE_URLS = __PRECACHE_URLS__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(PRECACHE);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== PRECACHE && k !== RUNTIME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations : réseau d'abord, coquille précacheée hors ligne.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(PRECACHE);
          return (await cache.match('/index.html')) ?? Response.error();
        }
      })(),
    );
    return;
  }

  // API : réseau d'abord, dernier résultat en cache hors ligne (lectures seules).
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RUNTIME);
        try {
          const fresh = await fetch(request);
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await cache.match(request);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: 'Hors ligne.' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
      })(),
    );
    return;
  }

  // Statiques (assets hashés) : cache d'abord.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const fresh = await fetch(request);
      const cache = await caches.open(PRECACHE);
      cache.put(request, fresh.clone());
      return fresh;
    })(),
  );
});
