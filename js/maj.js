/* ============================================================
 * Tableau Virtuel — mise à jour forcée (PC et téléphone)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * - enregistre le service worker sans cache HTTP (updateViaCache: "none") ;
 * - cherche une nouvelle version automatiquement toutes les 24 h (à l’ouverture si la dernière
 *   recherche date de plus de 24 h, et toutes les 24 h pour une page laissée ouverte) ;
 * - à la demande : bouton « Rechercher une mise à jour » et bouton « Forcer la mise à jour »
 *   (vide le cache de l’appli, retire le service worker et recharge : les réglages sont gardés) ;
 * - la nouvelle version s’active seule (skipWaiting) puis la page se recharge ;
 * - si une session est en cours (window.TV_OCCUPE() vrai), le rechargement attend
 *   la fin de la session, avec un bouton « Mettre à jour maintenant ».
 * ============================================================ */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  var VERSION_APPLI = "1.1.0", deja = !!navigator.serviceWorker.controller, attente = false;

  function occupe() { try { return typeof window.TV_OCCUPE === "function" && window.TV_OCCUPE(); } catch (e) { return false; } }
  function bandeau() {
    var b = document.getElementById("bandeauMaj"); if (!b) return;
    b.classList.remove("cache");
    var bt = document.getElementById("bMaj"); if (bt) bt.onclick = function () { location.reload(); };
  }
  function recharger() {
    if (!occupe()) { location.reload(); return; }
    bandeau();                                   // session en cours : on prévient et on réessaie
    if (!attente) { attente = true; setInterval(function () { if (!occupe()) location.reload(); }, 5000); }
  }

  var enregistrement = null;
  function etat(t) { Array.prototype.forEach.call(document.querySelectorAll(".js-etat-maj"), function (e) { e.textContent = t; }); }
  etat("Version installée : " + VERSION_APPLI);

  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(function (reg) { enregistrement = reg; })
    .catch(function () { /* hors ligne non disponible : l’appli reste utilisable */ });

  // Recherche à la demande : télécharge sw.js sur le réseau et compare avec la version en place.
  function chercher() {
    if (!navigator.onLine) { etat("Pas de connexion : impossible de chercher une mise à jour."); return; }
    if (!enregistrement) { etat("Mise à jour indisponible sur ce navigateur."); return; }
    etat("Recherche en cours…");
    noter(); enregistrement.update().then(function () {
      if (enregistrement.installing || enregistrement.waiting) etat("Nouvelle version trouvée : installation, la page va se recharger…");
      else etat("Déjà à jour (version " + VERSION_APPLI + ").");
    }).catch(function () { etat("La recherche a échoué. Réessaie avec une meilleure connexion."); });
  }
  // Recherche automatique : au plus une fois par 24 h.
  var CLE_VERIF = "tv1_maj_verif", JOUR_MS = 86400000;
  function derniere() { try { return parseInt(localStorage.getItem(CLE_VERIF), 10) || 0; } catch (e) { return 0; } }
  function noter() { try { localStorage.setItem(CLE_VERIF, String(Date.now())); } catch (e) { /* tant pis */ } }
  function auto() {
    if (!enregistrement || !navigator.onLine || Date.now() - derniere() < JOUR_MS) return;
    noter(); try { enregistrement.update(); } catch (e) { /* hors ligne */ }
  }
  navigator.serviceWorker.ready.then(function () { setTimeout(auto, 3000); });
  setInterval(auto, JOUR_MS);

  // Mise à jour forcée : cache vidé, service worker retiré, rechargement depuis le réseau.
  function forcer() {
    etat("Mise à jour forcée en cours…");
    var p1 = window.caches ? caches.keys().then(function (k) { return Promise.all(k.map(function (n) { return caches.delete(n); })); }) : Promise.resolve();
    var p2 = navigator.serviceWorker.getRegistrations().then(function (r) { return Promise.all(r.map(function (x) { return x.unregister(); })); });
    Promise.all([p1, p2]).then(function () { location.reload(); }).catch(function () { etat("Échec : ferme puis rouvre l’appli."); });
  }
  Array.prototype.forEach.call(document.querySelectorAll(".js-forcer-maj"), function (b) { b.addEventListener("click", forcer); });
  Array.prototype.forEach.call(document.querySelectorAll(".js-chercher-maj"), function (b) { b.addEventListener("click", chercher); });

  // Un nouveau service worker prend la main : seulement si la page était déjà contrôlée (pas à la 1re visite).
  navigator.serviceWorker.addEventListener("controllerchange", function () { if (deja) recharger(); deja = true; });
})();
