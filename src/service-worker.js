// Build replaces these constants with a content-derived version and integrity list.
const CACHE_NAME = __CACHE_NAME__;
const CACHE_PREFIX = `inkread:${self.registration.scope}:`;
const ASSETS = __PRECACHE_ASSETS__;
const INDEX = new URL('index.html',self.registration.scope).href;
const urls = ASSETS.map(asset=>new URL(asset.path,self.registration.scope).href);
const allowed = new Set(urls);

async function precache() {
  const cache = await caches.open(CACHE_PREFIX + CACHE_NAME);
  // A failed download or integrity check rejects the whole batch atomically.
  await cache.addAll(ASSETS.map(asset=>new Request(new URL(asset.path,self.registration.scope),{
    cache:'reload',credentials:'same-origin',mode:'same-origin',integrity:asset.integrity,
  })));
}
async function isReady() {
  const cache = await caches.open(CACHE_PREFIX + CACHE_NAME);
  const cached = new Set((await cache.keys()).map(request=>request.url));
  return urls.every(url=>cached.has(url));
}
self.addEventListener('install',event=>{
  event.waitUntil(precache().catch(async error=>{
    await caches.delete(CACHE_PREFIX + CACHE_NAME);
    throw error;
  }));
  // Updates wait for existing tabs to close, keeping their lazy chunks consistent.
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== CACHE_PREFIX + CACHE_NAME) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  const entry = request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(INDEX).pathname);
  // Version queries bypass old HTTP caches on first installation; offline assets
  // remain pinned to this worker's complete version, independently of the query.
  url.search = '';
  const key = entry ? INDEX : url.href;
  if (!allowed.has(key)) return;
  event.respondWith((async()=>{
    const cache = await caches.open(CACHE_PREFIX + CACHE_NAME);
    return await cache.match(key) || fetch(request);
  })());
});
self.addEventListener('message',event=>{
  // Only our own documents can query or repair this static app cache.
  if (!event.source?.url?.startsWith(self.registration.scope) || !event.ports[0]) return;
  if (!['OFFLINE_STATUS','REPAIR_CACHE'].includes(event.data?.type)) return;
  event.waitUntil((async()=>{
    try {
      if (event.data.type === 'REPAIR_CACHE') await precache();
      event.ports[0].postMessage({ready:await isReady()});
    } catch { event.ports[0].postMessage({ready:false}); }
  })());
});
