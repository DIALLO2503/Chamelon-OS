// App shell cache: pages fall back to the cached shell when offline; hashed assets are cached on first use. API calls are never cached.
const CACHE = 'nexus-shell-v1'
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.add('/')).then(() => self.skipWaiting())))
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())))
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api')) return
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(r => { caches.open(CACHE).then(c => c.put('/', r.clone())); return r }).catch(() => caches.match('/')))
  } else if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r })))
  }
})
