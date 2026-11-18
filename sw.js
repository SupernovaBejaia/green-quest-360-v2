// Service worker : met l'application en cache pour qu'elle s'ouvre et fonctionne sans Internet.
// Changer VERSION à chaque mise en ligne pour que les téléphones récupèrent la nouvelle version.
// Les caches sont partagés avec la V1 (même domaine github.io) : on ne touche qu'aux caches V2.
importScripts('js/upload-core.js');
const PREFIX = 'gq360v2-';
const VERSION = PREFIX + '2';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/capture.js', 'js/config.js', 'js/db.js', 'js/i18n.js', 'js/jpeg-meta.js',
  'js/math.js', 'js/pipeline.js', 'js/upload-core.js', 'js/stitch.worker.js', 'js/targets.js', 'js/upload.js', 'js/viewer.js', 'js/sim.js',
  'fonts/archivo-latin.woff2', 'fonts/archivo-latin-ext.woff2',
  'img/supernova.webp', 'img/comet.webp', 'img/greenquest.webp', 'img/gouraya.webp', 'img/provert.webp',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // envoi vers Google : jamais mis en cache
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});

// Envoi en arrière-plan (Android / Chrome) : déclenché par le navigateur quand le réseau revient,
// même si l'app est fermée. En cas d'échec, le navigateur réessaie plus tard.
self.addEventListener('sync', (e) => {
  if (e.tag !== 'gq-upload') return;
  e.waitUntil(self.GQUploadCore.uploadAll({}).then(async (r) => {
    const clients = await self.clients.matchAll();
    clients.forEach((c) => c.postMessage({ type: 'uploaded', r }));
  }));
});
