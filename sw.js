// Service worker : permet d'ouvrir l'application sans réseau.
var CACHE = 'cqr-v10';
var CDN = [];
var SHELL = ['./', 'index.html', 'app.js', 'style.css', 'config.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); })
      .concat(CDN.map(function (u) { return c.add(new Request(u, { mode: 'no-cors' })).catch(function () {}); })));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var same = url.origin === self.location.origin;
  var cdn = CDN.indexOf(req.url) !== -1;
  if (!same && !cdn) return;                      // l'API Apps Script passe toujours par le réseau
  if (cdn) {                                      // bibliothèques : cache d'abord
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); return res; });
    }));
    return;
  }
  // Fichiers de l'application : réseau d'abord (4 s max), sinon cache
  e.respondWith(new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () { fallback(); }, 4000);
    function fallback() {
      if (done) return;
      caches.match(req, { ignoreSearch: true }).then(function (hit) { if (hit && !done) { done = true; resolve(hit); } });
    }
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) { var cp = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
      if (!done) { done = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (!done) { done = true; resolve(hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())); }
      });
    });
  }));
});
