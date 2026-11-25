/* ============================================================
 * Tableau Virtuel — chiffrement de bout en bout (partagé PC / téléphone)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Principe :
 *  - chaque appareil crée une paire de clés ECDH P-256 (clé privée non exportable) ;
 *  - la clé partagée donne, par HKDF : une clé par sens (PC->tél., tél.->PC),
 *    le nom secret du salon temps réel, et un code de contrôle à 4 chiffres ;
 *  - les messages sont chiffrés en AES-256-GCM avec un compteur anti-rejeu.
 * Le serveur (Supabase) ne voit que du texte chiffré.
 * ============================================================ */
(function (g) {
  "use strict";
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var subtle = g.crypto.subtle;

  // --- Utilitaires base64 « url » (sans + / =) ---
  function b64u(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function unb64u(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var r = atob(s), u = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) u[i] = r.charCodeAt(i);
    return u;
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (x) {
      return ("0" + x.toString(16)).slice(-2);
    }).join("");
  }

  // --- Paires de clés ---
  function genPaire() {
    return subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  }
  function pubVersTexte(paire) {
    return subtle.exportKey("raw", paire.publicKey).then(b64u);
  }
  function importerPub(txt) {
    return subtle.importKey("raw", unb64u(txt), { name: "ECDH", namedCurve: "P-256" }, false, []);
  }

  // --- Secret du PC (jamais stocké côté serveur : seule son empreinte l’est) ---
  function genSecret() {
    return b64u(g.crypto.getRandomValues(new Uint8Array(32)));
  }
  function empreinte(txt) {
    return subtle.digest("SHA-256", enc.encode(txt)).then(hex);
  }

  // --- Dérivation des clés de session ---
  // maClePrivee : clé privée de cet appareil ; pubAutre : clé publique de l’autre (texte)
  // pubPc / pubTel : les deux clés publiques (texte), dans le même ordre des deux côtés.
  function deriver(maClePrivee, pubAutre, pubPc, pubTel) {
    return importerPub(pubAutre).then(function (autre) {
      return subtle.deriveBits({ name: "ECDH", public: autre }, maClePrivee, 256);
    }).then(function (bits) {
      return subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
    }).then(function (base) {
      var sel = enc.encode(pubPc + "|" + pubTel);
      function hk(info, octets) {
        return subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: sel, info: enc.encode(info) }, base, octets * 8);
      }
      function cleAes(buf) {
        return subtle.importKey("raw", buf, "AES-GCM", false, ["encrypt", "decrypt"]);
      }
      return Promise.all([
        hk("tv1 pc->tel", 32).then(cleAes),
        hk("tv1 tel->pc", 32).then(cleAes),
        hk("tv1 salon", 16),
        hk("tv1 controle", 4)
      ]).then(function (r) {
        var n = new DataView(r[3]).getUint32(0) % 10000;
        return {
          clePcVersTel: r[0],
          cleTelVersPc: r[1],
          salon: "tv-" + hex(r[2]),
          code: ("000" + n).slice(-4)
        };
      });
    });
  }

  // --- Chiffrement / déchiffrement d’un message ---
  // sens : "pc->tel" ou "tel->pc" (authentifié comme donnée associée)
  var dernierEnvoi = 0;
  function chiffrer(cle, sens, objet) {
    // Compteur strictement croissant, même après un rechargement de page.
    dernierEnvoi = Math.max(dernierEnvoi + 1, Date.now() * 1000);
    var clair = enc.encode(JSON.stringify({ n: dernierEnvoi, m: objet }));
    var iv = g.crypto.getRandomValues(new Uint8Array(12));
    return subtle.encrypt({ name: "AES-GCM", iv: iv, additionalData: enc.encode(sens) }, cle, clair)
      .then(function (ct) { return b64u(iv) + "." + b64u(ct); });
  }
  // Renvoie une promesse de { n, m } ou rejette si invalide.
  function dechiffrer(cle, sens, texte) {
    if (typeof texte !== "string" || texte.length > 400000) return Promise.reject(new Error("taille"));
    var p = texte.split(".");
    if (p.length !== 2) return Promise.reject(new Error("format"));
    return subtle.decrypt({ name: "AES-GCM", iv: unb64u(p[0]), additionalData: enc.encode(sens) }, cle, unb64u(p[1]))
      .then(function (clair) {
        var o = JSON.parse(dec.decode(clair));
        if (typeof o.n !== "number" || typeof o.m !== "object" || o.m === null) throw new Error("contenu");
        return o;
      });
  }

  // Garde anti-rejeu : un message est accepté une seule fois, et seulement s’il a moins de 30 s de retard
  // sur le plus récent (le réseau peut livrer deux messages dans un ordre légèrement différent).
  function garde() {
    var vus = new Set(), maxN = 0, FENETRE = 30e6;      // n est en « microsecondes » (ms x 1000)
    return function accepte(n) {
      if (n < maxN - FENETRE || vus.has(n)) return false;
      vus.add(n); if (n > maxN) maxN = n;
      if (vus.size > 3000) vus.forEach(function (v) { if (v < maxN - FENETRE) vus.delete(v); });
      return true;
    };
  }

  g.TVCrypto = {
    garde: garde,
    b64u: b64u, unb64u: unb64u, genPaire: genPaire, pubVersTexte: pubVersTexte,
    genSecret: genSecret, empreinte: empreinte, deriver: deriver,
    chiffrer: chiffrer, dechiffrer: dechiffrer
  };
})(self);
