/* ============================================================
 * Tableau Virtuel — envoi d’un fichier du téléphone vers le PC, en blocs
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Le fichier est coupé en blocs de 45 Ko, chaque bloc voyage chiffré.
 * Le PC contrôle l’ordre, la taille totale et le type avant d’afficher.
 * ============================================================ */
(function (g) {
  "use strict";
  var TAILLE_BLOC = 45000;

  function versB64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(s);
  }
  // Coupe des octets en blocs de texte base64.
  function decouper(u8) {
    var blocs = [];
    for (var i = 0; i < u8.length; i += TAILLE_BLOC) blocs.push(versB64(u8.subarray(i, i + TAILLE_BLOC)));
    return blocs;
  }

  // Reconstitue un fichier à partir des blocs reçus (côté PC).
  function Assembleur(meta) {
    this.meta = meta; this.blocs = new Array(meta.n); this.recus = 0; this.octets = 0; this.dernier = Date.now();
  }
  Assembleur.prototype.ajouter = function (i, d) {
    if (i >= this.meta.n || this.blocs[i]) return false;                 // hors plage ou doublon
    var r; try { r = atob(d); } catch (e) { return false; }
    if (r.length > TAILLE_BLOC || this.octets + r.length > this.meta.taille) return false;
    var u = new Uint8Array(r.length); for (var k = 0; k < r.length; k++) u[k] = r.charCodeAt(k);
    this.blocs[i] = u; this.recus++; this.octets += u.length; this.dernier = Date.now();
    return true;
  };
  Assembleur.prototype.complet = function () { return this.recus === this.meta.n && this.octets === this.meta.taille; };
  Assembleur.prototype.blob = function () { return new Blob(this.blocs, { type: this.meta.type }); };

  g.TVTransfert = { TAILLE_BLOC: TAILLE_BLOC, decouper: decouper, Assembleur: Assembleur };
})(self);
