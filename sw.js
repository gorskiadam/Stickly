// sw.js — service worker: makes Stickly open instantly and work with no connection.
// Bump CACHE whenever a file in SHELL is added or removed.

const CACHE = 'stickly-v24';

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/main.js',
  'js/store.js',
  'js/strings.js',
  'js/feedback.js',
  'js/settings.js',
  'js/ui.js',
  'js/motion.js',
  'js/drag.js',
  'js/later.js',
  'js/done.js',
  'js/focus.js',
  'js/capture.js',
  'js/parse.js',
  'js/sound.js',
  'js/trash.js',
  'js/menu.js',
  'js/binpeek.js',
  'js/sweep.js',
  'js/whatnow.js',
  'js/speech.js',
  'js/newday.js',
  'js/paper.js',
  'js/daytime.js',
  'js/time.js',
  'js/days.js',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

/** While developing on this machine, always prefer fresh files over cached ones. */
const DEVELOPING = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(removeOldCaches().then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(DEVELOPING ? networkFirst(request) : cacheFirst(request, event));
});

async function removeOldCaches() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
}

/** Fetch from the network and remember the answer for next time. */
async function fetchAndStore(request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

/** Answer from the cache at once, and refresh the cache in the background. */
async function cacheFirst(request, event) {
  const cached = await caches.match(request, { ignoreSearch: true });
  const fresh = fetchAndStore(request);
  if (!cached) return fresh;
  event.waitUntil(fresh.catch(() => {})); // offline: the cached copy is enough
  return cached;
}

/** Use the network when there is one; fall back to the cache offline. */
async function networkFirst(request) {
  try {
    return await fetchAndStore(request);
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    return cached || Response.error();
  }
}
