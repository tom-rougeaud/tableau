/* ============================================================
 * Tableau Virtuel — service worker
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Met en cache les fichiers de l’interface (jamais les échanges avec Supabase).
 * À CHAQUE MISE À JOUR : changer VERSION, sinon les anciens fichiers restent servis.
 * ============================================================ */
var VERSION = "tv-cache-1.2.1";
var FICHIERS = [
  "./", "index.html", "projection.html", "viewer.html", "a-propos.html", "confidentialite.html",
  "manifest.webmanifest", "css/style.css",
  "js/config.js", "js/crypto.js", "js/proto.js", "js/clic.js", "js/suggestions.js", "js/transfert.js", "js/maj.js", "js/remote.js", "js/projection.js", "js/viewer.js", "js/pwa.js",
  "js/lib/supabase.js", "js/lib/qrcode.js", "js/lib/pdf.min.js", "js/lib/pdf.worker.min.js",
  "img/logo-icone.svg", "img/logo-icone-nom-une-ligne.svg", "img/icone-installation-192.png",
  "img/icone-installation-512.png", "img/icone-installation-512-maskable.png", "img/apple-touch-icon-180.png"
];

// Installation : cache neuf (fichiers relus sur le réseau, pas dans le cache HTTP) puis activation immédiate.
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return c.addAll(FICHIERS.map(function (f) { return new Request(f, { cache: "reload" }); }));
  }).then(function () { return self.skipWaiting(); }));
});

// Les anciens caches sont supprimés à l’activation.
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (cles) {
    return Promise.all(cles.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Réseau d’abord pour TOUS les fichiers (version la plus récente), cache en secours hors ligne.
self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;   // Supabase : jamais intercepté
  e.respondWith(fetch(req, { cache: "no-cache" }).then(function (r) {
    if (r.ok) { var copie = r.clone(); caches.open(VERSION).then(function (c) { c.put(req, copie); }); }
    return r;
  }).catch(function () {
    return caches.match(req).then(function (r) { return r || (req.mode === "navigate" ? caches.match("index.html") : Response.error()); });
  }));
});
