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

  var MIMES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/html", "video/mp4", "video/webm"];
  var GENRES = ["image", "pdf", "video", "html", "url", "ecran"];
  var TAILLE_MAX_FICHIER = 25 * 1024 * 1024;
  var BLOCS_MAX = 600;

  function entier(v, a, b) { return typeof v === "number" && isFinite(v) && Math.floor(v) === v && v >= a && v <= b; }
  function nombre(v, a, b) { return typeof v === "number" && isFinite(v) && v >= a && v <= b; }
  function texte(v, max) { return typeof v === "string" && v.length <= max; }
  function idTransfert(v) { return typeof v === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(v); }
  function urlHttps(v) {
    if (!texte(v, 500)) return false;
    try { var u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && u.hostname.indexOf(".") > 0; }
    catch (e) { return false; }
  }
  var rien = { champs: [], ok: function () { return true; } };

  // Commandes téléphone -> PC. Chaque entrée : liste des champs permis + contrôle.
  var COMMANDES = {
    suivant: rien, precedent: rien, contenuSuivant: rien, contenuPrecedent: rien, toutFermer: rien, etat: rien,
    ouvrir: { champs: ["i"], ok: function (m) { return entier(m.i, 0, 199); } },
    fermer: { champs: ["i"], ok: function (m) { return entier(m.i, 0, 199); } },
    zoom:   { champs: ["v"], ok: function (m) { return nombre(m.v, 0.25, 5); } },
    lecture: { champs: ["on"], ok: function (m) { return typeof m.on === "boolean"; } },
    page:   { champs: ["v"], ok: function (m) { return entier(m.v, 1, 100000); } },
    saut:   { champs: ["v"], ok: function (m) { return nombre(m.v, -3600, 3600); } },
    laser:  { champs: ["x", "y", "on"], ok: function (m) { return nombre(m.x, 0, 1) && nombre(m.y, 0, 1) && typeof m.on === "boolean"; } },
    clic:   { champs: ["x", "y", "b"], ok: function (m) { return nombre(m.x, 0, 1) && nombre(m.y, 0, 1) && (m.b === "g" || m.b === "d"); } },
    texte:  { champs: ["v"], ok: function (m) { return texte(m.v, 500); } },
    touche: { champs: ["k"], ok: function (m) { return m.k === "Entree"; } },
    noir:   { champs: ["on"], ok: function (m) { return typeof m.on === "boolean"; } },
    apercu: { champs: ["on"], ok: function (m) { return typeof m.on === "boolean"; } },
    defiler: { champs: ["dy"], ok: function (m) { return nombre(m.dy, -2000, 2000); } },
    message: { champs: ["v"], ok: function (m) { return texte(m.v, 500); } },
    url:    { champs: ["v"], ok: function (m) { return urlHttps(m.v); } },
    fichierDebut: { champs: ["id", "nom", "type", "taille", "n"], ok: function (m) {
      return idTransfert(m.id) && texte(m.nom, 120) && m.nom.length > 0 && MIMES.indexOf(m.type) >= 0 &&
             entier(m.taille, 1, TAILLE_MAX_FICHIER) && entier(m.n, 1, BLOCS_MAX); } },
    fichierBloc: { champs: ["id", "i", "d"], ok: function (m) {
      return idTransfert(m.id) && entier(m.i, 0, BLOCS_MAX - 1) && texte(m.d, 90000) && /^[A-Za-z0-9+\/]*={0,2}$/.test(m.d); } },
    fichierFin: { champs: ["id"], ok: function (m) { return idTransfert(m.id); } },
    fichierAnnuler: { champs: ["id"], ok: function (m) { return idTransfert(m.id); } }
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
      if (!it || !texte(it.n, 120) || GENRES.indexOf(it.k) < 0 || (it.o !== "pc" && it.o !== "tel")) return null;
      items.push({ n: it.n, k: it.k, o: it.o });
    }
    return {
      c: "etat", items: items,
      cur: entier(m.cur, -1, 199) ? m.cur : -1,
      page: entier(m.page, 0, 100000) ? m.page : 0,
      pages: entier(m.pages, 0, 100000) ? m.pages : 0,
      zoom: nombre(m.zoom, 0.25, 5) ? m.zoom : 1,
      lecture: m.lecture === true, noir: m.noir === true,
      champ: m.champ === true, val: texte(m.val, 500) ? m.val : "",
      cl: m.cl === true, ap: m.ap === true
    };
  }

  // Image d’aperçu de l’écran du PC (JPEG en texte, affichée telle quelle sur le téléphone).
  function validerImage(m) {
    if (!m || m.c !== "image" || typeof m.d !== "string" || m.d.length > 180000) return null;
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+\/]+={0,2}$/.test(m.d)) return null;
    return { c: "image", d: m.d };
  }

  g.TVProto = { validerCommande: validerCommande, validerEtat: validerEtat, validerImage: validerImage, MIMES: MIMES };
})(self);
