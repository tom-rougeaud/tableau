/* ============================================================
 * Tableau Virtuel — logique du téléphone (télécommande)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Étapes : connexion -> double authentification (TOTP, niveau aal2)
 *          -> rattachement d’un PC (QR + code de contrôle) -> télécommande.
 * Toutes les décisions de sécurité sont aussi prises côté base (fonctions tv_*) :
 * cette page ne fait qu’aider l’utilisateur(trice).
 * ============================================================ */
(function () {
  "use strict";

  // Anti-cadrage : si la page est placée dans le cadre d’un autre site, on la masque.
  try { if (window.top !== window.self) { document.documentElement.hidden = true; return; } }
  catch (e) { document.documentElement.hidden = true; return; }

  // ---------- Constantes ----------
  var PREFIXE = "tv1_";                       // préfixe des clés de stockage (application + version)
  var RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var RE_PUB = /^[A-Za-z0-9_-]{80,120}$/;
  var DELAI_LASER_MS = 50;                    // 20 envois par seconde au plus
  var DELAI_VERIF_MS = 30000;                 // vérification de la session côté base

  function $(id) { return document.getElementById(id); }

  // ---------- Stockage protégé (localStorage avec repli en mémoire) ----------
  var memoire = {};
  function lire(cle) { try { var v = localStorage.getItem(PREFIXE + cle); return v === null ? (memoire[cle] || null) : v; } catch (e) { return memoire[cle] || null; } }
  function ecrire(cle, v) { memoire[cle] = v; try { localStorage.setItem(PREFIXE + cle, v); } catch (e) { /* stockage indisponible : mémoire seule */ } }
  function retirer(cle) { delete memoire[cle]; try { localStorage.removeItem(PREFIXE + cle); } catch (e) { /* rien */ } }

  // ---------- Stockage des clés de session (IndexedDB, clés non exportables) ----------
  var memIdb = {};
  function ouvrirIdb() {
    return new Promise(function (ok, ko) {
      try {
        var r = indexedDB.open(PREFIXE + "sessions", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("s"); };
        r.onsuccess = function () { ok(r.result); };
        r.onerror = function () { ko(r.error); };
      } catch (e) { ko(e); }
    });
  }
  function idbPut(k, v) {
    memIdb[k] = v;
    return ouvrirIdb().then(function (db) {
      return new Promise(function (ok, ko) { var t = db.transaction("s", "readwrite"); t.objectStore("s").put(v, k); t.oncomplete = ok; t.onerror = function () { ko(t.error); }; });
    }).catch(function () { /* repli mémoire */ });
  }
  function idbGet(k) {
    return ouvrirIdb().then(function (db) {
      return new Promise(function (ok, ko) { var r = db.transaction("s").objectStore("s").get(k); r.onsuccess = function () { ok(r.result || null); }; r.onerror = function () { ko(r.error); }; });
    }).catch(function () { return memIdb[k] || null; });
  }
  function idbDel(k) {
    delete memIdb[k];
    return ouvrirIdb().then(function (db) {
      return new Promise(function (ok) { var t = db.transaction("s", "readwrite"); t.objectStore("s").delete(k); t.oncomplete = ok; t.onerror = ok; });
    }).catch(function () { /* rien */ });
  }

  // ---------- Client Supabase (session conservée, clé de stockage propre à l’appli) ----------
  var sb = supabase.createClient(TV_CONFIG.SUPABASE_URL, TV_CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: PREFIXE + "auth" }
  });

  // ---------- État ----------
  var rattachementEnAttente = null;   // { id, pub } lu dans le lien du QR code
  var courant = null;                 // rattachement en cours : { id, paire, pubTxt, pcPub, cles }
  var session = null;                 // session active : { id, cles, maxUntil }
  var salon = null, etat = null, minuteurVerif = null, factorEnCours = null, essaisCode = 0;

  // ---------- Affichage ----------
  var VUES = ["Connexion", "Mfa", "Accueil", "Scanner", "Rattacher", "Telecommande"];
  function montrer(nom) {
    VUES.forEach(function (v) { $("vue" + v).classList.toggle("cache", v !== nom); });
    document.body.setAttribute("data-vue", nom.toLowerCase());
    document.body.classList.toggle("tele-actif", nom === "Telecommande");   // plein écran sans en-tête ni pied
    if (typeof orienter === "function" && prefs) orienter();
    window.scrollTo(0, 0);
  }
  function msg(id, texte, erreur) {
    var e = $(id); e.textContent = texte || "";
    e.className = "msg" + (erreur ? " erreur" : (texte ? " ok" : ""));
  }
  // Traduit les erreurs de la base en phrases simples.
  function phrase(err) {
    var t = (err && (err.message || err)) + "";
    if (/non_autorise|permission denied/.test(t)) return "Action refusée : compte non autorisé ou double authentification manquante.";
    if (/introuvable_ou_expire/.test(t)) return "Ce code a expiré. Demande un nouveau code sur l’ordinateur.";
    if (/trop_de_demandes/.test(t)) return "Trop de demandes. Attends une minute.";
    if (/Invalid login|invalid_credentials/i.test(t)) return "Adresse ou mot de passe incorrect.";
    if (/Failed to fetch|network/i.test(t)) return "Pas de connexion au service. Vérifie ton réseau.";
    return "Un problème est survenu, recommence.";
  }

  // ============================================================
  // 1) Connexion et double authentification
  // ============================================================
  $("formConnexion").addEventListener("submit", function (e) {
    e.preventDefault();
    msg("msgConnexion", "");
    $("bConnexion").disabled = true;
    sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("mdp").value }).then(function (r) {
      $("mdp").value = "";
      if (r.error) { msg("msgConnexion", phrase(r.error), true); return; }
      return apresConnexion();
    }).catch(function (er) { msg("msgConnexion", phrase(er), true); })
      .then(function () { $("bConnexion").disabled = false; });
  });

  // Décide : double authentification à saisir, à créer, ou déjà faite.
  function apresConnexion() {
    return sb.auth.mfa.getAuthenticatorAssuranceLevel().then(function (r) {
      if (r.error) throw r.error;
      var d = r.data;
      if (d.currentLevel === "aal2") return verifierProprietaire();
      return sb.auth.mfa.listFactors().then(function (lf) {
        if (lf.error) throw lf.error;
        var verifies = (lf.data && lf.data.totp) || [];
        if (verifies.length) { factorEnCours = verifies[0].id; afficherMfa(false); }
        else return creerFacteur();
      });
    });
  }
  function afficherMfa(creation) {
    $("blocMfaCreer").classList.toggle("cache", !creation); $("blocMfaConnu").classList.toggle("cache", creation);
    $("codeMfa").value = ""; msg("msgMfa", "");
    montrer("Mfa"); $("codeMfa").focus();
  }
  // Première utilisation : crée un facteur TOTP (les facteurs non terminés sont d’abord retirés).
  function creerFacteur() {
    return sb.auth.mfa.listFactors().then(function (lf) {
      var anciens = ((lf.data && lf.data.all) || []).filter(function (f) { return f.status !== "verified"; });
      return Promise.all(anciens.map(function (f) { return sb.auth.mfa.unenroll({ factorId: f.id }); }));
    }).then(function () {
      return sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Tableau Virtuel " + Date.now(), issuer: "Tableau Virtuel" });
    }).then(function (r) {
      if (r.error) throw r.error;
      factorEnCours = r.data.id;
      $("mfaQr").src = r.data.totp.qr_code;
      $("mfaSecret").textContent = r.data.totp.secret;
      // Lien « otpauth » : ouvre directement l’appli d’authentification du même téléphone (format vérifié).
      var uri = String(r.data.totp.uri || ""), lienApp = $("mfaOuvrir");
      if (/^otpauth:\/\/totp\//.test(uri)) { lienApp.href = uri; lienApp.classList.remove("cache"); } else { lienApp.removeAttribute("href"); lienApp.classList.add("cache"); }
      afficherMfa(true);
    });
  }
  $("formMfa").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = $("codeMfa").value.trim();
    if (!/^[0-9]{6}$/.test(code) || !factorEnCours) { msg("msgMfa", "Saisis les 6 chiffres.", true); return; }
    sb.auth.mfa.challengeAndVerify({ factorId: factorEnCours, code: code }).then(function (r) {
      if (r.error) { msg("msgMfa", "Code incorrect ou expiré.", true); return; }
      $("mfaQr").removeAttribute("src"); $("mfaSecret").textContent = ""; $("mfaOuvrir").removeAttribute("href");
      return verifierProprietaire();
    }).catch(function (er) { msg("msgMfa", phrase(er), true); });
  });
  $("bMfaCopier").addEventListener("click", function () {
    var cle = $("mfaSecret").textContent;
    try { navigator.clipboard.writeText(cle).then(function () { msg("msgMfa", "Clé copiée. Colle-la dans l’appli.", false); }, function () { msg("msgMfa", "Copie impossible : sélectionne la clé et copie-la à la main.", true); }); }
    catch (e) { msg("msgMfa", "Copie impossible : sélectionne la clé et copie-la à la main.", true); }
  });
  $("bMfaRetour").addEventListener("click", deconnecter);

  // Vérifie auprès de la base que ce compte est bien le propriétaire (avec aal2).
  function verifierProprietaire() {
    return sb.rpc("tv_moi").then(function (r) {
      if (r.error || !r.data || !r.data.proprietaire) {
        msg("msgGlobal", "Ce compte n’est pas le propriétaire de cet espace.", true);
        return deconnecter();
      }
      if (r.data.aal !== "aal2") { msg("msgGlobal", "La double authentification n’est pas validée. Reconnecte-toi.", true); return deconnecter(); }
      msg("msgGlobal", "");
      // Scelle le facteur de double authentification du propriétaire (sans effet s’il est déjà scellé).
      return sb.rpc("tv_sceller").then(function () { return entrerApplication(); }, function () { return entrerApplication(); });
    });
  }

  function deconnecter() {
    fermerSalon(); clearInterval(minuteurVerif);
    return sb.auth.signOut().catch(function () { /* rien */ }).then(function () { session = null; courant = null; montrer("Connexion"); });
  }
  $("bDeconnexion").addEventListener("click", deconnecter);

  // ============================================================
  // 2) Accueil, liste des PC, rattachement
  // ============================================================
  function entrerApplication() {
    // Un rattachement demandé par QR code passe avant tout.
    if (rattachementEnAttente) { var r = rattachementEnAttente; rattachementEnAttente = null; return commencerRattachement(r); }
    return idbGet("courante").then(function (s) {
      if (s && s.maxUntil > Date.now()) {
        return sb.rpc("tv_list").then(function (l) {
          var actif = !l.error && (l.data || []).some(function (x) { return x.id === s.id && x.status === "approved" && pcVivant(x); });
          if (actif) { session = s; return ouvrirTelecommande(); }
          // PC éteint, page fermée ou rechargée : ses clés sont perdues, la session est inutilisable.
          if (!l.error) sb.rpc("tv_pair_revoke", { p_id: s.id });
          if (!l.error) msg("msgGlobal", "L’ordinateur n’est plus connecté. Rattache-le de nouveau.", true);
          return idbDel("courante").then(afficherAccueil);
        });
      }
      return afficherAccueil();
    });
  }
  // Le PC met à jour « last_seen » toutes les 4 s : au-delà de 45 s, il est considéré comme déconnecté.
  function pcVivant(x) { return !!x.last_seen && (Date.now() - new Date(x.last_seen).getTime()) < 45000; }
  function afficherAccueil() {
    montrer("Accueil");
    var d = lire("duree"); if (d && ["120","240","480","720"].indexOf(d) >= 0) $("duree").value = d;
    return actualiserListe();
  }
  function actualiserListe() {
    return sb.rpc("tv_list").then(function (r) {
      var ul = $("listePc"); while (ul.firstChild) ul.removeChild(ul.firstChild);
      var l = (r.error ? [] : r.data) || [];
      $("aucunPc").classList.toggle("cache", l.length > 0);
      l.forEach(function (x) {
        var li = document.createElement("li"), b = document.createElement("button");
        var fin = x.max_until ? new Date(x.max_until).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
        b.textContent = (x.status === "approved" ? "Rattaché" : "En cours") + (fin ? " jusqu’à " + fin : "") + " — révoquer";
        b.className = "danger";
        b.addEventListener("click", function () { sb.rpc("tv_pair_revoke", { p_id: x.id }).then(actualiserListe); });
        li.appendChild(b); ul.appendChild(li);
      });
    });
  }
  $("bActualiser").addEventListener("click", actualiserListe);
  $("bToutRevoquer").addEventListener("click", function () {
    if (!confirm("Révoquer tous les ordinateurs rattachés ?")) return;
    sb.rpc("tv_revoke_all").then(function () { return idbDel("courante"); }).then(actualiserListe);
  });

  function commencerRattachement(lien) {
    montrer("Rattacher"); $("saisieCode").value = ""; msg("msgRattacher", "Échange des clés…");
    $("bIdentiques").disabled = true; essaisCode = 0;
    var c = { id: lien.id, pcPub: lien.pub };
    courant = c;
    return TVCrypto.genPaire().then(function (paire) {
      c.paire = paire; return TVCrypto.pubVersTexte(paire);
    }).then(function (pubTxt) {
      c.pubTxt = pubTxt;
      return sb.rpc("tv_pair_claim", { p_id: c.id, p_phone_pub: pubTxt });
    }).then(function (r) {
      if (r.error) throw r.error;
      // La clé du PC lue dans le QR code doit être identique à celle enregistrée en base.
      if (!r.data || r.data.pc_pub !== c.pcPub) {
        sb.rpc("tv_pair_revoke", { p_id: c.id });
        throw new Error("Clé du PC inattendue : rattachement annulé par sécurité.");
      }
      return TVCrypto.deriver(c.paire.privateKey, c.pcPub, c.pcPub, c.pubTxt);
    }).then(function (cles) {
      c.cles = cles;
      msg("msgRattacher", "Saisis le code affiché sur l’ordinateur.");
      $("bIdentiques").disabled = false; $("saisieCode").focus();
    }).catch(function (er) {
      courant = null;
      msg("msgGlobal", er && /Clé du PC/.test(er.message) ? er.message : phrase(er), true);
      return afficherAccueil();
    });
  }
  $("bIdentiques").addEventListener("click", function () {
    if (!courant || !courant.cles) return;
    // Le code saisi (lu sur le PC) doit être celui que ce téléphone a calculé ; 3 erreurs = annulation.
    if ($("saisieCode").value.trim() !== courant.cles.code) {
      essaisCode++;
      if (essaisCode >= 3) { sb.rpc("tv_pair_revoke", { p_id: courant.id }); courant = null; msg("msgGlobal", "Codes différents : rattachement annulé.", true); afficherAccueil(); return; }
      msg("msgRattacher", "Ce code ne correspond pas. Vérifie l’écran de l’ordinateur.", true); return;
    }
    var c = courant, minutes = parseInt($("duree").value, 10) || 240;
    $("bIdentiques").disabled = true;
    sb.rpc("tv_pair_approve", { p_id: c.id, p_minutes: minutes }).then(function (r) {
      if (r.error) throw r.error;
      session = { id: c.id, cles: c.cles, maxUntil: new Date(r.data.max_until).getTime() };
      courant = null;
      return idbPut("courante", session);
    }).then(ouvrirTelecommande).catch(function (er) { msg("msgRattacher", phrase(er), true); });
  });
  $("bDifferents").addEventListener("click", function () {
    if (courant) sb.rpc("tv_pair_revoke", { p_id: courant.id });
    courant = null; msg("msgGlobal", "Rattachement annulé."); afficherAccueil();
  });

  // ============================================================
  // 3) Télécommande (paysage : aperçu + laser d’un côté, menus de l’autre)
  // ============================================================
  var GAIN_RELATIF = 2.2;                      // vitesse du pointeur en mode « pavé » (relatif)
  var APERCU_RELANCE_MS = 5000;                // le PC n’envoie l’aperçu que si on le redemande
  var MAX_FAVORIS = 100, MAX_FICHIER = 25 * 1024 * 1024, PAUSE_BLOC_MS = 40;
  var MIME_PAR_EXT = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", html: "text/html", htm: "text/html", mp4: "video/mp4", webm: "video/webm" };
  var prefs = lirePrefs(), favoris = [], minuteurApercu = null, accepte = TVCrypto.garde();
  var lx = 0.5, ly = 0.5, ratioPc = 16 / 9, envoiEnCours = null;

  // ---------- Préférences (stockage protégé) ----------
  function nettoyerPrefs(o) {
    if (!o || typeof o !== "object") return null;
    return { cote: o.cote === "gauche" ? "gauche" : "droite", mode: o.mode === "direct" ? "direct" : "relatif", tap: o.tap === true, orient: o.orient === "portrait" ? "portrait" : "paysage", plein: o.plein !== false };
  }
  function lirePrefs() {
    var p = null; try { p = nettoyerPrefs(JSON.parse(lire("prefs2") || "null")); } catch (e) { /* valeurs par défaut */ }
    return p || { cote: "droite", mode: "relatif", tap: false, orient: "paysage", plein: true };
  }
  function appliquerPrefs() {
    $("tele").classList.toggle("inverse", prefs.cote === "gauche");
    $("optCote").value = prefs.cote; $("optMode").value = prefs.mode; $("optTap").checked = prefs.tap; $("optOrient").value = prefs.orient; $("optPlein").checked = prefs.plein;
    ecrire("prefs2", JSON.stringify(prefs)); orienter();
  }

  // ---------- Ouverture / fermeture ----------
  function ouvrirTelecommande() {
    montrer("Telecommande"); etat = null; accepte = TVCrypto.garde();
    appliquerPrefs(); majEtat(); chargerFavoris(); ajuster();
    fermerSalon(); garderEveille(true);
    salon = sb.channel(session.cles.salon, { config: { broadcast: { self: false } } });
    salon.on("broadcast", { event: "m" }, function (e) { recevoir(e.payload); });
    salon.subscribe(function (s) { if (s === "SUBSCRIBED") { envoyer({ c: "etat" }); demanderApercu(); } });
    clearInterval(minuteurVerif); minuteurVerif = setInterval(verifierSession, DELAI_VERIF_MS);
    // Pas d’image au bout de 8 s : on explique pourquoi (fenêtre du PC cachée, aperçu complet non activé).
    setTimeout(function () {
      if (session && session.id === sid && !$("apercuTexte").classList.contains("cache"))
        $("apercuTexte").textContent = "Pas encore d’aperçu. Sur l’ordinateur, garde la page de projection visible (ni réduite, ni derrière une autre fenêtre) et appuie sur « Aperçu téléphone » en haut.";
    }, 8000);
    // Si le PC ne répond à rien en 12 s, ses clés ne correspondent plus : on repart proprement.
    var sid = session.id;
    setTimeout(function () {
      if (session && session.id === sid && !etat) { sb.rpc("tv_pair_revoke", { p_id: sid }); terminerLocalement("L’ordinateur ne répond pas. Rattache-le de nouveau."); }
    }, 12000);
    clearInterval(minuteurApercu); minuteurApercu = setInterval(demanderApercu, APERCU_RELANCE_MS);
  }
  // Garde l’écran du téléphone allumé pendant le pilotage (si le navigateur le permet).
  var veille = null;
  function garderEveille(oui) {
    try {
      if (!oui) { if (veille) { veille.release(); veille = null; } return; }
      if (navigator.wakeLock && !veille) navigator.wakeLock.request("screen").then(function (w) { veille = w; w.addEventListener("release", function () { veille = null; }); }).catch(function () { /* refusé : rien */ });
    } catch (e) { /* non géré : rien */ }
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && session) garderEveille(true); });
  function fermerSalon() {
    garderEveille(false);
    clearInterval(minuteurApercu); minuteurApercu = null;
    if (salon) { try { sb.removeChannel(salon); } catch (e) { /* rien */ } salon = null; }
  }
  // Si la session n’est plus « approuvée » en base (révoquée, expirée), on quitte.
  function verifierSession() {
    if (!session) return;
    sb.rpc("tv_list").then(function (r) {
      if (r.error) return;
      var ok = (r.data || []).some(function (x) { return x.id === session.id && x.status === "approved"; });
      var vivant = (r.data || []).some(function (x) { return x.id === session.id && pcVivant(x); });
      if (!ok) terminerLocalement("Session terminée.");
      else if (!vivant) { sb.rpc("tv_pair_revoke", { p_id: session.id }); terminerLocalement("L’ordinateur s’est déconnecté. Rattache-le de nouveau."); }
    });
  }
  function terminerLocalement(texte) {
    fermerSalon(); clearInterval(minuteurVerif); session = null; envoiEnCours = null;
    idbDel("courante").then(function () { msg("msgGlobal", texte || ""); return afficherAccueil(); });
  }

  // ---------- Échanges chiffrés ----------
  function envoyer(m) {
    if (!salon || !session) return Promise.resolve();
    return TVCrypto.chiffrer(session.cles.cleTelVersPc, "tel->pc", m).then(function (d) {
      if (salon) salon.send({ type: "broadcast", event: "m", payload: { d: d } });
    });
  }
  function demanderApercu() { if (!document.hidden) envoyer({ c: "apercu", on: true }); }
  function recevoir(payload) {
    if (!session || !payload || typeof payload.d !== "string") return;
    TVCrypto.dechiffrer(session.cles.clePcVersTel, "pc->tel", payload.d).then(function (o) {
      if (!accepte(o.n)) return;                     // rejeu ou message trop ancien : ignoré
      if (o.m && o.m.c === "image") {
        var im = TVProto.validerImage(o.m);
        if (im) { $("apercu").src = im.d; }
        return;
      }
      var e = TVProto.validerEtat(o.m);
      if (e) { etat = e; majEtat(); }
    }).catch(function () { /* message illisible : ignoré */ });
  }

  // ---------- Affichage de l’état envoyé par le PC (textContent seulement) ----------
  var ICONE_GENRE = { image: "🖼️", pdf: "📄", video: "🎬", html: "🌐", url: "🔗", ecran: "🖥️" };
  function vider(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function creerBouton(texte, titre, fn, classe) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = texte;
    if (titre) { b.title = titre; b.setAttribute("aria-label", titre); }
    if (classe) b.className = classe;
    b.addEventListener("click", fn); return b;
  }
  function majEtat() {
    var info = $("infoEtat"), ul = $("listeOnglets");
    vider(ul);
    if (!etat) {
      info.textContent = "En attente de l’ordinateur…"; $("aucunOnglet").classList.remove("cache");
      $("barreTexte").classList.add("cache"); return;
    }
    var txt = etat.pages ? "Page " + etat.page + " sur " + etat.pages : (etat.cur >= 0 ? "Contenu " + (etat.cur + 1) + " sur " + etat.items.length : "Aucun contenu ouvert");
    var cour = etat.cur >= 0 ? etat.items[etat.cur] : null;
    if (cour && cour.k === "url" && cour.n === "YouTube") txt += " · lecture/pause et ±10 s disponibles (onglet Navigation)";
    else if (cour && !etat.cl && (cour.k === "url" || cour.k === "ecran" || cour.k === "pdf" || cour.k === "image")) {
      txt += cour.k === "url" ? " · clic impossible sur ce site (laser seulement)" : " · laser seulement";
    }
    info.textContent = txt;
    $("aucunOnglet").classList.toggle("cache", etat.items.length > 0);
    var pdf = etat.pages > 1;
    $("blocPageTel").classList.toggle("cache", !pdf);
    if (pdf) { $("totalPages").textContent = "(1 à " + etat.pages + ", actuelle : " + etat.page + ")"; $("champPageTel").max = String(etat.pages); }
    etat.items.forEach(function (it, i) {
      var li = document.createElement("li");
      var nom = creerBouton((ICONE_GENRE[it.k] || "•") + " " + (it.o === "tel" ? "📱 " : "🖥️ ") + it.n, "Afficher : " + it.n, function () { envoyer({ c: "ouvrir", i: i }); }, "nom");
      nom.setAttribute("aria-current", i === etat.cur ? "true" : "false");
      li.appendChild(nom);
      li.appendChild(creerBouton("✕", "Fermer : " + it.n, function () { envoyer({ c: "fermer", i: i }); }));
      ul.appendChild(li);
    });
    // Barre de saisie : seulement si un champ de texte est actif sur l’écran du PC.
    var bt = $("barreTexte"), champ = $("champTexte");
    bt.classList.toggle("cache", !etat.champ);
    if (etat.champ && document.activeElement !== champ && champ.value !== etat.val) champ.value = etat.val;
  }

  // ---------- Onglets du menu ----------
  function choisirOnglet(nom) {
    ["nav", "onglets", "fav", "opt"].forEach(function (n) {
      $("p-" + n).classList.toggle("cache", n !== nom);
      var b = document.querySelector('[data-onglet="' + n + '"]'); b.setAttribute("aria-selected", n === nom ? "true" : "false");
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-onglet]"), function (b) {
    b.addEventListener("click", function () { choisirOnglet(b.getAttribute("data-onglet")); });
  });

  // ---------- Boutons de commande ----------
  function lie(id, fn) { $(id).addEventListener("click", fn); }
  lie("bPrec", function () { envoyer({ c: "precedent" }); });
  lie("bSuiv", function () { envoyer({ c: "suivant" }); });
  lie("bContPrec", function () { envoyer({ c: "contenuPrecedent" }); });
  lie("bContSuiv", function () { envoyer({ c: "contenuSuivant" }); });
  lie("bZoomPlus", function () { envoyer({ c: "zoom", v: Math.min(5, ((etat && etat.zoom) || 1) * 1.25) }); });
  lie("bZoomMoins", function () { envoyer({ c: "zoom", v: Math.max(0.25, ((etat && etat.zoom) || 1) / 1.25) }); });
  lie("bHaut", function () { envoyer({ c: "defiler", dy: -300 }); });
  lie("bBas", function () { envoyer({ c: "defiler", dy: 300 }); });
  lie("bLecture", function () { envoyer({ c: "lecture", on: !(etat && etat.lecture) }); });
  lie("bNoir", function () { envoyer({ c: "noir", on: !(etat && etat.noir) }); });
  lie("bSautMoins", function () { envoyer({ c: "saut", v: -10 }); });
  lie("bSautPlus", function () { envoyer({ c: "saut", v: 10 }); });
  lie("bMsg", function () { var t = $("champMsg").value.trim(); if (t) { envoyer({ c: "message", v: t.slice(0, 500) }); $("champMsg").value = ""; } });
  lie("bToutFermer", function () { envoyer({ c: "toutFermer" }); });
  function allerPageTel() {
    var v = parseInt($("champPageTel").value, 10), max = (etat && etat.pages) || 0;
    if (!max || !(v >= 1)) { msg("msgGlobal", "Écris un numéro de page (1 à " + max + ").", true); return; }
    envoyer({ c: "page", v: Math.min(v, max) }); msg("msgGlobal", ""); $("champPageTel").blur();
  }
  lie("bAllerPageTel", allerPageTel);
  $("champPageTel").addEventListener("keydown", function (e) { if (e.key === "Enter") allerPageTel(); });
  lie("bClicG", function () { envoyer({ c: "clic", x: lx, y: ly, b: "g" }); });
  lie("bClicD", function () { envoyer({ c: "clic", x: lx, y: ly, b: "d" }); });
  lie("bMasquer", function () { $("croix").classList.add("cache"); envoyer({ c: "laser", x: 0, y: 0, on: false }); });
  lie("bEntree", function () { envoyer({ c: "touche", k: "Entree" }); });
  $("champTexte").addEventListener("input", function () { envoyer({ c: "texte", v: $("champTexte").value.slice(0, 500) }); });
  $("champTexte").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); envoyer({ c: "touche", k: "Entree" }); } });
  lie("bRetourAccueil", function () { afficherAccueil(); });
  lie("bFin", function () {
    if (!session) return;
    var id = session.id;
    sb.rpc("tv_pair_revoke", { p_id: id }).then(function () { terminerLocalement("Session terminée."); });
  });

  // ---------- Adresse d’un site : « https:// » est déjà écrit ----------
  function adresseSaisie(v) {
    v = String(v).trim();
    if (/^http:\/\//i.test(v)) return null;                       // http refusé : seul https est accepté
    v = v.replace(/^(https:\/\/)+/i, "");
    if (!v) return null;
    try { var u = new URL("https://" + v); return u.protocol === "https:" && u.hostname.indexOf(".") > 0 ? u.href : null; } catch (e) { return null; }
  }
  // « https:// » reste toujours écrit dans le champ : impossible de l’effacer, un lien collé est nettoyé.
  var PREFIXE_HTTPS = "https://";
  function fixerPrefixe(champ) {
    function corriger() {
      var v = champ.value;
      if (v.indexOf(PREFIXE_HTTPS) === 0 && v.substr(PREFIXE_HTTPS.length, PREFIXE_HTTPS.length).toLowerCase() !== PREFIXE_HTTPS) return;
      // On retire tout début « http(s):// » (même partiel ou répété), puis on remet le préfixe unique.
      var reste = v.replace(/^\s+/, "").replace(/^(https?:\/\/)+/i, "").replace(/^h?t?t?p?s?:?\/{0,2}/i, "");
      champ.value = PREFIXE_HTTPS + reste;
      var fin = champ.value.length; try { champ.setSelectionRange(fin, fin); } catch (e) { /* rien */ }
    }
    function curseur() { if (champ.selectionStart < PREFIXE_HTTPS.length && champ.selectionStart === champ.selectionEnd) { try { champ.setSelectionRange(PREFIXE_HTTPS.length, PREFIXE_HTTPS.length); } catch (e) { /* rien */ } } }
    champ.addEventListener("input", corriger);
    champ.addEventListener("focus", function () { corriger(); setTimeout(curseur, 0); });
    champ.addEventListener("click", curseur);
    champ.addEventListener("keyup", curseur);
    corriger();
  }
  fixerPrefixe($("champUrl")); fixerPrefixe($("favUrl"));
  lie("bUrl", function () {
    var u = adresseSaisie($("champUrl").value);
    if (!u) { msg("msgGlobal", "Adresse invalide : écris un site comme https://exemple.fr", true); return; }
    envoyer({ c: "url", v: u }); $("champUrl").value = "https://"; msg("msgGlobal", "");
  });
  $("champUrl").addEventListener("keydown", function (e) { if (e.key === "Enter") $("bUrl").click(); });
  $("champUrl").addEventListener("focus", function () { if (!$("champUrl").value) $("champUrl").value = "https://"; });

  // ---------- Orientation : paysage par défaut ----------
  // Si le téléphone est tenu en portrait et que « Paysage » est choisi, l’affichage est pivoté d’un quart de tour
  // (le navigateur ne permet pas toujours de forcer l’orientation) ; tourne le téléphone pour l’avoir à plat.
  var pivotActif = false;
  function orienter() {
    var t = $("tele"), actif = document.body.classList.contains("tele-actif");
    var portrait = window.innerHeight > window.innerWidth;
    pivotActif = actif && prefs.orient === "paysage" && portrait;
    t.classList.toggle("pivote", pivotActif);
    t.classList.toggle("h", actif && (pivotActif || (!portrait && window.innerHeight <= 640)));
    if (pivotActif) { t.style.width = window.innerHeight + "px"; t.style.height = window.innerWidth + "px"; t.style.setProperty("--lw", window.innerWidth + "px"); }
    else { t.style.width = ""; t.style.height = ""; }
  }

  // ---------- Zone d’aperçu et pointeur laser ----------
  var pave = $("pave"), croix = $("croix");
  var depart = null, dernierEnvoiLaser = 0;
  function ajuster() {                                              // la zone épouse le format de l’écran du PC
    orienter();
    var c = $("zoneCentre"), cw = c.clientWidth, ch = c.clientHeight; if (!cw || !ch) return;
    var w = cw / ch > ratioPc ? ch * ratioPc : cw, h = w / ratioPc;
    pave.style.width = Math.floor(w) + "px"; pave.style.height = Math.floor(h) + "px";
  }
  $("apercu").addEventListener("load", function () {
    var im = $("apercu"); $("apercu").classList.remove("cache"); $("apercuTexte").classList.add("cache");
    if (im.naturalWidth && im.naturalHeight) { var r = im.naturalWidth / im.naturalHeight; if (Math.abs(r - ratioPc) > 0.01) { ratioPc = r; ajuster(); } }
  });
  window.addEventListener("resize", ajuster);
  window.addEventListener("orientationchange", function () { setTimeout(ajuster, 250); });
  // Plein écran : se relance au premier appui (le navigateur exige un geste) et dès qu’on en sort.
  // Sur iPhone, Safari ne permet pas le plein écran d’une page : installer l’appli sur l’écran d’accueil.
  function pleinEcranTel() {
    try {
      var el = document.documentElement;
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      var p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: "hide" }) : (el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null);
      if (p && p.then) p.then(function () {
        if (prefs.orient === "paysage" && screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(function () { /* non permis */ });
      }).catch(function () { /* refusé */ });
    } catch (e) { /* non géré : rien */ }
  }
  $("tele").addEventListener("pointerdown", function () { if (session && prefs.plein) pleinEcranTel(); }, true);
  $("optPlein").addEventListener("change", function () { prefs.plein = $("optPlein").checked; appliquerPrefs(); if (prefs.plein) pleinEcranTel(); else try { if (document.exitFullscreen && document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* rien */ } });
  $("optOrient").addEventListener("change", function () { prefs.orient = $("optOrient").value === "portrait" ? "portrait" : "paysage"; appliquerPrefs(); ajuster(); });
  if (window.ResizeObserver) new ResizeObserver(ajuster).observe($("zoneCentre"));

  function bornes(v) { return Math.min(1, Math.max(0, v)); }
  function placerCroix() { croix.style.left = (lx * 100) + "%"; croix.style.top = (ly * 100) + "%"; croix.classList.remove("cache"); }
  function envoyerLaser() { envoyer({ c: "laser", x: lx, y: ly, on: true }); }
  // Position du doigt dans la zone, de 0 à 1, dans le repère de l’aperçu (même quand l’affichage est pivoté).
  function posDansZone(ev) {
    var r = pave.getBoundingClientRect();
    if (pivotActif) return { x: bornes((ev.clientY - r.top) / r.height), y: bornes((r.right - ev.clientX) / r.width) };
    return { x: bornes((ev.clientX - r.left) / r.width), y: bornes((ev.clientY - r.top) / r.height) };
  }
  pave.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  pave.addEventListener("pointerdown", function (ev) {
    ev.preventDefault(); try { pave.setPointerCapture(ev.pointerId); } catch (e) { /* rien */ }
    var p0 = posDansZone(ev);
    depart = { t: Date.now(), cx: ev.clientX, cy: ev.clientY, px: p0.x, py: p0.y, bouge: false };
    if (prefs.mode === "direct") { lx = p0.x; ly = p0.y; }
    placerCroix(); envoyerLaser();
  });
  pave.addEventListener("pointermove", function (ev) {
    if (!depart) return;
    if (Math.abs(ev.clientX - depart.cx) + Math.abs(ev.clientY - depart.cy) > 12) depart.bouge = true;
    var p = posDansZone(ev);
    if (prefs.mode === "direct") { lx = p.x; ly = p.y; }
    else {                                                          // souris : déplacement relatif, sans avoir à viser
      lx = bornes(lx + (p.x - depart.px) * GAIN_RELATIF); ly = bornes(ly + (p.y - depart.py) * GAIN_RELATIF);
      depart.px = p.x; depart.py = p.y;
    }
    placerCroix();
    var now = Date.now(); if (now - dernierEnvoiLaser < DELAI_LASER_MS) return; dernierEnvoiLaser = now;
    envoyerLaser();
  });
  function finLaser(ev) {
    if (!depart) return;
    var d = depart; depart = null;
    envoyerLaser();                                                 // position finale exacte ; le laser reste affiché sur le PC
    if (ev.type === "pointerup" && prefs.tap && !d.bouge && Date.now() - d.t < 300) envoyer({ c: "clic", x: lx, y: ly, b: "g" });
  }
  pave.addEventListener("pointerup", finLaser);
  pave.addEventListener("pointercancel", finLaser);

  // ---------- Favoris : liens et fichiers gardés sur ce téléphone (IndexedDB) ----------
  function aleatoire() { var a = new Uint8Array(12); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function chargerFavoris() {
    return idbGet("favoris").then(function (l) {
      favoris = Array.isArray(l) ? l.filter(function (f) { return f && typeof f.nom === "string" && (f.t === "lien" || f.t === "fichier"); }).slice(0, MAX_FAVORIS) : [];
      // Premier lancement : les favoris de départ (casier, manuels, TradMaths, etc.) sont ajoutés une seule fois.
      var S = window.TV_SUGGESTIONS;
      if (!lire("fav_init") && !favoris.length && S) {
        S.parDefaut.forEach(function (u) { var n = nomSuggestion(u) || new URL(u).hostname; favoris.push({ id: aleatoire(), t: "lien", nom: n, url: u }); });
        ecrire("fav_init", "1"); sauverFavoris();
      }
      dessinerFavoris();
    });
  }
  function sauverFavoris() { return idbPut("favoris", favoris); }
  // Suggestions (données dans js/suggestions.js) : « ★ » ajoute aux favoris, « Ouvrir » affiche sur le PC.
  function nomSuggestion(url) {
    var S = window.TV_SUGGESTIONS, nom = null;
    if (S) S.groupes.forEach(function (g) { g.sites.forEach(function (s) { if (s.url === url) nom = s.nom; }); });
    return nom;
  }
  function dessinerSuggestions() {
    var S = window.TV_SUGGESTIONS, zone = $("suggestions"); vider(zone); if (!S) return;
    var deja = {}; favoris.forEach(function (f) { if (f.t === "lien") deja[f.url] = true; });
    S.groupes.forEach(function (g) {
      var h = document.createElement("h3"); h.textContent = g.titre; zone.appendChild(h);
      var ul = document.createElement("ul"); ul.className = "liste-contenus";
      g.sites.forEach(function (s) {
        var li = document.createElement("li");
        li.appendChild(creerBouton("Ouvrir · " + s.nom, "Afficher sur le PC : " + s.nom, function () { envoyer({ c: "url", v: s.url }); }, "nom"));
        var ajoute = !!deja[s.url];
        var b = creerBouton(ajoute ? "✓" : "★", ajoute ? "Déjà dans les favoris : " + s.nom : "Ajouter aux favoris : " + s.nom, function () {
          if (deja[s.url] || favoris.length >= MAX_FAVORIS) return;
          favoris.push({ id: aleatoire(), t: "lien", nom: s.nom, url: s.url }); sauverFavoris().then(dessinerFavoris);
        });
        b.disabled = ajoute; li.appendChild(b); ul.appendChild(li);
      });
      zone.appendChild(ul);
    });
  }
  function dessinerFavoris() {
    dessinerSuggestions();
    var ul = $("listeFavoris"); vider(ul);
    $("aucunFavori").classList.toggle("cache", favoris.length > 0);
    favoris.forEach(function (f) {
      var li = document.createElement("li");
      li.appendChild(creerBouton((f.t === "lien" ? "🔗 " : "📎 ") + f.nom, "Envoyer au PC : " + f.nom, function () { envoyerFavori(f); }, "nom"));
      li.appendChild(creerBouton("✕", "Retirer des favoris : " + f.nom, function () {
        favoris = favoris.filter(function (x) { return x.id !== f.id; }); sauverFavoris().then(dessinerFavoris);
      }));
      ul.appendChild(li);
    });
  }
  lie("bAjoutLien", function () {
    var u = adresseSaisie($("favUrl").value);
    if (!u) { msg("msgGlobal", "Adresse invalide : écris un site comme https://exemple.fr", true); return; }
    if (favoris.length >= MAX_FAVORIS) { msg("msgGlobal", "Trop de favoris (100 au plus).", true); return; }
    var nom = $("favNom").value.trim().slice(0, 60) || new URL(u).hostname;
    favoris.push({ id: aleatoire(), t: "lien", nom: nom, url: u });
    $("favNom").value = ""; $("favUrl").value = "https://"; msg("msgGlobal", "");
    sauverFavoris().then(dessinerFavoris);
  });
  $("favUrl").addEventListener("focus", function () { if (!$("favUrl").value) $("favUrl").value = "https://"; });
  lie("bAjoutFichier", function () { $("favFichier").click(); });
  $("favFichier").addEventListener("change", function (e) {
    var f = e.target.files[0]; e.target.value = ""; if (!f) return;
    var ext = (f.name.split(".").pop() || "").toLowerCase(), type = MIME_PAR_EXT[ext];
    if (!type || f.size > MAX_FICHIER || f.size === 0) { msg("msgGlobal", "Fichier refusé : image, PDF, HTML ou vidéo, 25 Mo au plus.", true); return; }
    if (favoris.length >= MAX_FAVORIS) { msg("msgGlobal", "Trop de favoris (100 au plus).", true); return; }
    favoris.push({ id: aleatoire(), t: "fichier", nom: f.name.slice(0, 120), type: type, taille: f.size, blob: f });
    msg("msgGlobal", ""); sauverFavoris().then(dessinerFavoris);
  });
  function pause(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  function envoyerFavori(f) {
    if (f.t === "lien") { envoyer({ c: "url", v: f.url }); return; }
    if (envoiEnCours) { msg("msgGlobal", "Un envoi est déjà en cours.", true); return; }
    var id = aleatoire(), annule = false;
    envoiEnCours = { id: id, annuler: function () { annule = true; } };
    $("envoi").classList.remove("cache"); $("envoiTexte").textContent = "Préparation de " + f.nom + "…";
    f.blob.arrayBuffer().then(function (buf) {
      var blocs = TVTransfert.decouper(new Uint8Array(buf)), n = blocs.length, i = 0;
      return envoyer({ c: "fichierDebut", id: id, nom: f.nom, type: f.type, taille: buf.byteLength, n: n }).then(function suite() {
        if (annule || !session) { envoyer({ c: "fichierAnnuler", id: id }); return false; }
        if (i >= n) return envoyer({ c: "fichierFin", id: id }).then(function () { return true; });
        return envoyer({ c: "fichierBloc", id: id, i: i, d: blocs[i] }).then(function () {
          i++; $("envoiTexte").textContent = "Envoi de " + f.nom + " : " + Math.round(i / n * 100) + " %";
          return pause(PAUSE_BLOC_MS);
        }).then(suite);
      });
    }).then(function (ok) { msg("msgGlobal", ok ? "Fichier envoyé au PC." : "Envoi annulé."); })
      .catch(function () { msg("msgGlobal", "L’envoi a échoué. Recommence.", true); })
      .then(function () { envoiEnCours = null; $("envoi").classList.add("cache"); });
  }
  lie("bAnnulerEnvoi", function () { if (envoiEnCours) envoiEnCours.annuler(); });

  // ---------- Options ----------
  $("optCote").addEventListener("change", function () { prefs.cote = $("optCote").value === "gauche" ? "gauche" : "droite"; appliquerPrefs(); ajuster(); });
  $("optMode").addEventListener("change", function () { prefs.mode = $("optMode").value === "relatif" ? "relatif" : "direct"; appliquerPrefs(); });
  $("optTap").addEventListener("change", function () { prefs.tap = $("optTap").checked; appliquerPrefs(); });
  lie("bPleinEcran", function () {
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      var el = document.documentElement, p = el.requestFullscreen ? el.requestFullscreen() : null;
      if (!p) { msg("msgGlobal", "Plein écran indisponible ici (sur iPhone : « Partager → Sur l’écran d’accueil »).", true); return; }
      p.then(function () { try { screen.orientation.lock("landscape").catch(function () { /* refusé */ }); } catch (e) { /* non géré */ } })
        .catch(function () { msg("msgGlobal", "Plein écran refusé par le navigateur.", true); });
    } catch (e) { msg("msgGlobal", "Plein écran indisponible ici.", true); }
  });
  // Utilisé par js/maj.js : pas de rechargement automatique pendant une session.
  window.TV_OCCUPE = function () { return !!session; };

  // ============================================================
  // 4) Réglages : durée, export, import, effacement
  // ============================================================
  $("duree").addEventListener("change", function () { ecrire("duree", $("duree").value); });
  // Export : réglages, préférences de la télécommande et liens favoris (les fichiers favoris restent sur le téléphone).
  $("bExporter").addEventListener("click", function () {
    var liens = favoris.filter(function (f) { return f.t === "lien"; }).map(function (f) { return { nom: f.nom, url: f.url }; });
    var o = { application: "tableau-virtuel", version: 2, duree: parseInt($("duree").value, 10) || 240, prefs: prefs, liens: liens };
    var blob = new Blob([JSON.stringify(o)], { type: "application/json" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tableau-virtuel-reglages.json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  $("bImporter").addEventListener("click", function () { $("fichierImport").click(); });
  // Import : tout est vérifié avant d’être appliqué (version 1 : durée seule ; version 2 : durée, préférences, liens).
  $("fichierImport").addEventListener("change", function (e) {
    var f = e.target.files[0]; e.target.value = "";
    if (!f || f.size > 40000) { msg("msgGlobal", "Fichier refusé (trop gros).", true); return; }
    f.text().then(function (t) {
      var o = JSON.parse(t), cles = Object.keys(o).sort().join(",");
      if (!o || o.application !== "tableau-virtuel" || [120, 240, 480, 720].indexOf(o.duree) < 0) throw new Error("invalide");
      var nouveauxLiens = [], p = null;
      if (o.version === 1 && cles === "application,duree,version") { /* ancien format : durée seule */ }
      else if (o.version === 2 && cles === "application,duree,liens,prefs,version" && Array.isArray(o.liens) && o.liens.length <= MAX_FAVORIS) {
        p = nettoyerPrefs(o.prefs); if (!p) throw new Error("invalide");
        o.liens.forEach(function (l) {
          var u = l && typeof l.nom === "string" && typeof l.url === "string" ? adresseSaisie(l.url) : null;
          if (!u) throw new Error("invalide");
          nouveauxLiens.push({ id: aleatoire(), t: "lien", nom: l.nom.slice(0, 60) || new URL(u).hostname, url: u });
        });
      } else throw new Error("invalide");
      $("duree").value = String(o.duree); ecrire("duree", String(o.duree));
      if (p) {
        prefs = p; appliquerPrefs();
        var fichiers = favoris.filter(function (x) { return x.t === "fichier"; });
        favoris = nouveauxLiens.concat(fichiers).slice(0, MAX_FAVORIS); sauverFavoris().then(dessinerFavoris);
      }
      msg("msgGlobal", "Réglages importés.");
    }).catch(function () { msg("msgGlobal", "Fichier invalide : rien n’a été modifié.", true); });
  });
  $("bEffacer").addEventListener("click", function () {
    if (!confirm("Effacer toutes les données de cet appareil et se déconnecter ?")) return;
    idbDel("courante"); idbDel("favoris"); favoris = [];
    ["duree", "install", "auth", "prefs", "prefs2", "fav_init"].forEach(retirer);
    try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf(PREFIXE) === 0) localStorage.removeItem(k); }); } catch (e) { /* rien */ }
    deconnecter().then(function () { msg("msgConnexion", "Données effacées."); });
  });

  // ============================================================
  // 5) Démarrage
  // ============================================================
  // Lecture du lien du QR code : #p=<identifiant>.<clé publique du PC> (jamais de secret).
  (function lireLien() {
    var h = location.hash.match(/^#p=([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/);
    if (h && RE_UUID.test(h[1]) && RE_PUB.test(h[2])) rattachementEnAttente = { id: h[1], pub: h[2] };
    if (location.hash) { try { history.replaceState(null, "", location.pathname); } catch (e) { /* rien */ } }
  })();

  // ============================================================
  // 4 bis) Lecteur de QR code intégré (caméra de l’appareil, rien n’est enregistré ni envoyé)
  // ============================================================
  // Principe : BarcodeDetector si le navigateur l’offre (Android/Chrome), sinon jsQR (iPhone, Firefox…).
  var scan = { flux: null, actif: false, detecteur: null, canvas: null };

  // Extrait { id, pub } d’un texte (lien complet, « #p=… » ou « id.clé »). Seul ce format est accepté.
  function lienDepuisTexte(t) {
    t = String(t || "").trim();
    if (t.length > 600) return null;
    var m = t.match(/#p=([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/) || t.match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/);
    if (m && RE_UUID.test(m[1]) && RE_PUB.test(m[2])) return { id: m[1], pub: m[2] };
    return null;
  }
  // Coupe la caméra et la boucle de lecture.
  function arreterScan() {
    scan.actif = false;
    if (scan.flux) { scan.flux.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* rien */ } }); scan.flux = null; }
    var v = $("videoScan"); if (v) { try { v.pause(); } catch (e) { /* rien */ } v.srcObject = null; }
  }
  function quitterScan() { arreterScan(); return afficherAccueil(); }
  function scanReussi(lien) {
    arreterScan(); return commencerRattachement(lien);
  }
  function ouvrirScan() {
    montrer("Scanner"); msg("msgScan", "Ouverture de la caméra…"); $("saisieLien").value = "";
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      msg("msgScan", "La caméra n’est pas disponible ici. Colle le lien ci-dessous.", true); return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then(function (flux) {
      if ($("vueScanner").classList.contains("cache")) { flux.getTracks().forEach(function (t) { t.stop(); }); return; }
      scan.flux = flux; scan.actif = true;
      var v = $("videoScan"); v.srcObject = flux; v.setAttribute("playsinline", ""); v.muted = true;
      return v.play().then(function () {
        msg("msgScan", "Place le QR code de l’ordinateur dans le cadre.");
        boucleScan();
      });
    }).catch(function (er) {
      arreterScan();
      var refus = er && (er.name === "NotAllowedError" || er.name === "SecurityError");
      var code = er && er.name ? " (" + er.name + ")" : "";
      msg("msgScan", (refus ? "Caméra refusée. Autorise-la dans les réglages du navigateur, ou colle le lien ci-dessous."
        : "Caméra introuvable. Colle le lien ci-dessous.") + code + " Tu peux aussi prendre une photo du QR code.", true);
    });
  }
  // Lit une image de la caméra environ 6 fois par seconde.
  function boucleScan() {
    if (!scan.actif) return;
    var v = $("videoScan");
    if (v.readyState >= 2 && v.videoWidth > 0) {
      lireImageScan(v).then(function (texte) {
        if (!scan.actif) return;
        var lien = texte && lienDepuisTexte(texte);
        if (lien) { scanReussi(lien); return; }
        if (texte) msg("msgScan", "Ce QR code n’est pas celui du Tableau Virtuel.", true);
        setTimeout(boucleScan, 160);
      }).catch(function () { setTimeout(boucleScan, 300); });
    } else setTimeout(boucleScan, 160);
  }
  function lireImageScan(v) {
    if (window.BarcodeDetector) {
      try { if (!scan.detecteur) scan.detecteur = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { scan.detecteur = null; }
      if (scan.detecteur) return scan.detecteur.detect(v).then(function (r) { return r && r.length ? r[0].rawValue : ""; });
    }
    // Repli : jsQR sur une image réduite (largeur 480 px au plus).
    if (!window.jsQR) return Promise.reject(new Error("pas de lecteur"));
    if (!scan.canvas) scan.canvas = document.createElement("canvas");
    var k = Math.min(1, 480 / v.videoWidth), w = Math.round(v.videoWidth * k), h = Math.round(v.videoHeight * k);
    scan.canvas.width = w; scan.canvas.height = h;
    var cx = scan.canvas.getContext("2d", { willReadFrequently: true });
    cx.drawImage(v, 0, 0, w, h);
    var r = window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
    return Promise.resolve(r ? r.data : "");
  }
  $("bScanner").addEventListener("click", ouvrirScan);
  $("bScanAnnuler").addEventListener("click", quitterScan);
  // Repli universel : photo prise avec l’appareil photo du téléphone, lue sur place (non enregistrée).
  $("bScanPhoto").addEventListener("click", function () { $("fichierScan").value = ""; $("fichierScan").click(); });
  $("fichierScan").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    msg("msgScan", "Lecture de la photo…");
    var url = URL.createObjectURL(f), img = new Image();
    img.onload = function () {
      var texte = "";
      // Plusieurs tailles : un QR petit ou une photo très grande se lisent mieux réduits.
      [1200, 800, 500].some(function (max) {
        var k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(1, Math.round(img.naturalWidth * k)), h = Math.max(1, Math.round(img.naturalHeight * k));
        var cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        var cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
        var r = window.jsQR && window.jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
        if (r && r.data) { texte = r.data; return true; }
        return false;
      });
      URL.revokeObjectURL(url);
      var lien = lienDepuisTexte(texte);
      if (lien) scanReussi(lien); else msg("msgScan", "Aucun QR code lisible. Rapproche-toi de l’écran et réessaie.", true);
    };
    img.onerror = function () { URL.revokeObjectURL(url); msg("msgScan", "Photo illisible. Réessaie.", true); };
    img.src = url;
  });
  $("bScanLien").addEventListener("click", function () {
    var lien = lienDepuisTexte($("saisieLien").value);
    if (!lien) { msg("msgScan", "Ce lien n’est pas valide. Copie-le en entier depuis l’ordinateur.", true); return; }
    scanReussi(lien);
  });
  // La caméra se coupe dès que l’appli passe en arrière-plan.
  document.addEventListener("visibilitychange", function () { if (document.hidden && scan.actif) quitterScan(); });

  window.addEventListener("error", function () { msg("msgGlobal", "Un problème est survenu, recommence.", true); });

  sb.auth.getSession().then(function (r) {
    if (r.data && r.data.session) return apresConnexion();
    montrer("Connexion");
  }).catch(function () { montrer("Connexion"); });
})();
