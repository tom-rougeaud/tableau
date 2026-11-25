/* ============================================================
 * Tableau Virtuel — protocole des messages (liste blanche stricte)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Tout message reçu est reconstruit champ par champ : un champ inconnu
 * ou hors bornes fait rejeter le message entier.
 * ============================================================ */
(function (g) {
  "use strict";

  function entier(v, a, b) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= a && v <= b; }
  function nombre(v, a, b) { return typeof v === "number" && isFinite(v) && v >= a && v <= b; }
  function texte(v, max) { return typeof v === "string" && v.length <= max; }
  function urlHttps(v) {
    if (!texte(v, 500)) return false;
    try { var u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; }
    catch (e) { return false; }
  }

  // Commandes téléphone -> PC. Chaque entrée : liste des champs permis + contrôle.
  var COMMANDES = {
    suivant:   { champs: [], ok: function () { return true; } },
    precedent: { champs: [], ok: function () { return true; } },
    contenuSuivant:   { champs: [], ok: function () { return true; } },
    contenuPrecedent: { champs: [], ok: function () { return true; } },
    ouvrir: { champs: ["i"], ok: function (m) { return entier(m.i, 0, 199); } },
    zoom:   { champs: ["v"], ok: function (m) { return nombre(m.v, 0.25, 5); } },
    lecture: { champs: ["on"], ok: function (m) { return typeof m.on === "boolean"; } },
    saut:   { champs: ["v"], ok: function (m) { return nombre(m.v, -3600, 3600); } },
    laser:  { champs: ["x", "y", "on"], ok: function (m) { return nombre(m.x, 0, 1) && nombre(m.y, 0, 1) && typeof m.on === "boolean"; } },
    noir:   { champs: ["on"], ok: function (m) { return typeof m.on === "boolean"; } },
    defiler: { champs: ["dy"], ok: function (m) { return nombre(m.dy, -2000, 2000); } },
    message: { champs: ["v"], ok: function (m) { return texte(m.v, 500); } },
    url:    { champs: ["v"], ok: function (m) { return urlHttps(m.v); } },
    etat:   { champs: [], ok: function () { return true; } }   // demande d’état
  };

  // Vérifie une commande reçue par le PC ; renvoie l’objet nettoyé ou null.
  function validerCommande(m) {
    if (!m || typeof m !== "object" || typeof m.c !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(COMMANDES, m.c)) return null;
    var def = COMMANDES[m.c], propre = { c: m.c }, cles = Object.keys(m), i;
    for (i = 0; i < cles.length; i++) {
      if (cles[i] !== "c" && def.champs.indexOf(cles[i]) < 0) return null; // champ inconnu
    }
    if (!def.ok(m)) return null;
    for (i = 0; i < def.champs.length; i++) propre[def.champs[i]] = m[def.champs[i]];
    return propre;
  }

  // Vérifie l’état envoyé par le PC au téléphone (affichage uniquement).
  function validerEtat(m) {
    if (!m || m.c !== "etat" || !Array.isArray(m.items) || m.items.length > 200) return null;
    var items = [];
    for (var i = 0; i < m.items.length; i++) {
      var it = m.items[i];
      if (!it || !texte(it.n, 120) || !texte(it.k, 10)) return null;
      items.push({ n: it.n, k: it.k });
    }
    return {
      c: "etat", items: items,
      cur: entier(m.cur, -1, 199) ? m.cur : -1,
      page: entier(m.page, 0, 100000) ? m.page : 0,
      pages: entier(m.pages, 0, 100000) ? m.pages : 0,
      zoom: nombre(m.zoom, 0.25, 5) ? m.zoom : 1,
      lecture: m.lecture === true,
      noir: m.noir === true
    };
  }

  g.TVProto = { validerCommande: validerCommande, validerEtat: validerEtat };
})(self);
