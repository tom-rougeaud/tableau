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
  var salon = null, etat = null, dernierN = 0, minuteurVerif = null, dernierLaser = 0, factorEnCours = null, essaisCode = 0;

  // ---------- Affichage ----------
  var VUES = ["Connexion", "Mfa", "Accueil", "Rattacher", "Telecommande"];
  function montrer(nom) {
    VUES.forEach(function (v) { $("vue" + v).classList.toggle("cache", v !== nom); });
    document.body.setAttribute("data-vue", nom.toLowerCase());
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
    $("blocMfaCreer").classList.toggle("cache", !creation);
    $("codeMfa").value = ""; msg("msgMfa", "");
    montrer("Mfa"); $("codeMfa").focus();
  }
  // Première utilisation : crée un facteur TOTP (les facteurs non terminés sont d’abord retirés).
  function creerFacteur() {
    return sb.auth.mfa.listFactors().then(function (lf) {
      var anciens = ((lf.data && lf.data.all) || []).filter(function (f) { return f.status !== "verified"; });
      return Promise.all(anciens.map(function (f) { return sb.auth.mfa.unenroll({ factorId: f.id }); }));
    }).then(function () {
      return sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "Tableau Virtuel " + Date.now() });
    }).then(function (r) {
      if (r.error) throw r.error;
      factorEnCours = r.data.id;
      $("mfaQr").src = r.data.totp.qr_code;
      $("mfaSecret").textContent = r.data.totp.secret;
      afficherMfa(true);
    });
  }
  $("formMfa").addEventListener("submit", function (e) {
    e.preventDefault();
    var code = $("codeMfa").value.trim();
    if (!/^[0-9]{6}$/.test(code) || !factorEnCours) { msg("msgMfa", "Saisis les 6 chiffres.", true); return; }
    sb.auth.mfa.challengeAndVerify({ factorId: factorEnCours, code: code }).then(function (r) {
      if (r.error) { msg("msgMfa", "Code incorrect ou expiré.", true); return; }
      $("mfaQr").removeAttribute("src"); $("mfaSecret").textContent = "";
      return verifierProprietaire();
    }).catch(function (er) { msg("msgMfa", phrase(er), true); });
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
          var actif = !l.error && (l.data || []).some(function (x) { return x.id === s.id && x.status === "approved"; });
          if (actif) { session = s; return ouvrirTelecommande(); }
          return idbDel("courante").then(afficherAccueil);
        });
      }
      return afficherAccueil();
    });
  }
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
  // 3) Télécommande
  // ============================================================
  function ouvrirTelecommande() {
    montrer("Telecommande"); etat = null; dernierN = 0; majEtat();
    fermerSalon();
    salon = sb.channel(session.cles.salon, { config: { broadcast: { self: false } } });
    salon.on("broadcast", { event: "m" }, function (e) { recevoir(e.payload); });
    salon.subscribe(function (s) { if (s === "SUBSCRIBED") envoyer({ c: "etat" }); });
    clearInterval(minuteurVerif);
    minuteurVerif = setInterval(verifierSession, DELAI_VERIF_MS);
  }
  function fermerSalon() { if (salon) { try { sb.removeChannel(salon); } catch (e) { /* rien */ } salon = null; } }

  // Si la session n’est plus « approuvée » en base (révoquée, expirée), on quitte.
  function verifierSession() {
    if (!session) return;
    sb.rpc("tv_list").then(function (r) {
      if (r.error) return;
      var ok = (r.data || []).some(function (x) { return x.id === session.id && x.status === "approved"; });
      if (!ok) terminerLocalement("Session terminée.");
    });
  }
  function terminerLocalement(texte) {
    fermerSalon(); clearInterval(minuteurVerif); session = null;
    idbDel("courante").then(function () { msg("msgGlobal", texte || ""); return afficherAccueil(); });
  }

  function envoyer(m) {
    if (!salon || !session) return;
    TVCrypto.chiffrer(session.cles.cleTelVersPc, "tel->pc", m).then(function (d) {
      salon.send({ type: "broadcast", event: "m", payload: { d: d } });
    });
  }
  function recevoir(payload) {
    if (!session || !payload || typeof payload.d !== "string") return;
    TVCrypto.dechiffrer(session.cles.clePcVersTel, "pc->tel", payload.d).then(function (o) {
      if (o.n <= dernierN) return;
      dernierN = o.n;
      var e = TVProto.validerEtat(o.m);
      if (e) { etat = e; majEtat(); }
    }).catch(function () { /* message illisible : ignoré */ });
  }

  // Met à jour l’affichage à partir de l’état envoyé par le PC (textContent seulement).
  function majEtat() {
    var info = $("infoEtat"), ul = $("listeContenus");
    while (ul.firstChild) ul.removeChild(ul.firstChild);
    if (!etat) { info.textContent = "En attente de l’ordinateur…"; $("aucunContenu").classList.remove("cache"); return; }
    info.textContent = etat.pages ? "Page " + etat.page + " sur " + etat.pages : (etat.cur >= 0 ? "Contenu " + (etat.cur + 1) + " sur " + etat.items.length : "Aucun contenu ouvert");
    $("aucunContenu").classList.toggle("cache", etat.items.length > 0);
    etat.items.forEach(function (it, i) {
      var li = document.createElement("li"), b = document.createElement("button");
      b.textContent = it.n; b.setAttribute("aria-current", i === etat.cur ? "true" : "false");
      b.addEventListener("click", function () { envoyer({ c: "ouvrir", i: i }); });
      li.appendChild(b); ul.appendChild(li);
    });
  }

  function lie(id, fn) { $(id).addEventListener("click", fn); }
  lie("bPrec", function () { envoyer({ c: "precedent" }); });
  lie("bSuiv", function () { envoyer({ c: "suivant" }); });
  lie("bZoomPlus", function () { var z = Math.min(5, ((etat && etat.zoom) || 1) * 1.25); envoyer({ c: "zoom", v: z }); });
  lie("bZoomMoins", function () { var z = Math.max(0.25, ((etat && etat.zoom) || 1) / 1.25); envoyer({ c: "zoom", v: z }); });
  lie("bHaut", function () { envoyer({ c: "defiler", dy: -300 }); });
  lie("bBas", function () { envoyer({ c: "defiler", dy: 300 }); });
  lie("bLecture", function () { envoyer({ c: "lecture", on: !(etat && etat.lecture) }); });
  lie("bNoir", function () { envoyer({ c: "noir", on: !(etat && etat.noir) }); });
  lie("bSautMoins", function () { envoyer({ c: "saut", v: -10 }); });
  lie("bSautPlus", function () { envoyer({ c: "saut", v: 10 }); });
  lie("bMsg", function () { var t = $("champMsg").value.trim(); if (t) { envoyer({ c: "message", v: t.slice(0, 500) }); $("champMsg").value = ""; } });
  lie("bUrl", function () {
    var v = $("champUrl").value.trim();
    try { var u = new URL(v); if (u.protocol !== "https:") throw new Error("http"); envoyer({ c: "url", v: u.href }); $("champUrl").value = ""; msg("msgGlobal", ""); }
    catch (er) { msg("msgGlobal", "Saisis une adresse qui commence par https://", true); }
  });
  lie("bRetourAccueil", function () { afficherAccueil(); });
  lie("bFin", function () {
    if (!session) return;
    var id = session.id;
    sb.rpc("tv_pair_revoke", { p_id: id }).then(function () { terminerLocalement("Session terminée."); });
  });

  // Pointeur laser : position relative dans la zone, 20 envois par seconde au plus.
  var pave = $("pave");
  function posLaser(ev) {
    var r = pave.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)) };
  }
  pave.addEventListener("pointerdown", function (ev) {
    ev.preventDefault(); try { pave.setPointerCapture(ev.pointerId); } catch (e) { /* rien */ }
    pave.classList.add("actif"); var p = posLaser(ev); envoyer({ c: "laser", x: p.x, y: p.y, on: true });
  });
  pave.addEventListener("pointermove", function (ev) {
    if (!pave.classList.contains("actif")) return;
    var now = Date.now(); if (now - dernierLaser < DELAI_LASER_MS) return; dernierLaser = now;
    var p = posLaser(ev); envoyer({ c: "laser", x: p.x, y: p.y, on: true });
  });
  function finLaser() { if (pave.classList.contains("actif")) { pave.classList.remove("actif"); envoyer({ c: "laser", x: 0, y: 0, on: false }); } }
  pave.addEventListener("pointerup", finLaser);
  pave.addEventListener("pointercancel", finLaser);

  // ============================================================
  // 4) Réglages : durée, export, import, effacement
  // ============================================================
  $("duree").addEventListener("change", function () { ecrire("duree", $("duree").value); });
  $("bExporter").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify({ application: "tableau-virtuel", version: 1, duree: parseInt($("duree").value, 10) || 480 })], { type: "application/json" });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tableau-virtuel-reglages.json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  $("bImporter").addEventListener("click", function () { $("fichierImport").click(); });
  $("fichierImport").addEventListener("change", function (e) {
    var f = e.target.files[0]; e.target.value = "";
    if (!f || f.size > 2000) { msg("msgGlobal", "Fichier refusé (trop gros).", true); return; }
    f.text().then(function (t) {
      var o = JSON.parse(t);
      var cles = Object.keys(o).sort().join(",");
      if (cles !== "application,duree,version" || o.application !== "tableau-virtuel" || o.version !== 1 ||
          [120, 240, 480, 720].indexOf(o.duree) < 0) throw new Error("invalide");
      $("duree").value = String(o.duree); ecrire("duree", String(o.duree)); msg("msgGlobal", "Réglages importés.");
    }).catch(function () { msg("msgGlobal", "Fichier invalide : rien n’a été modifié.", true); });
  });
  $("bEffacer").addEventListener("click", function () {
    if (!confirm("Effacer toutes les données de cet appareil et se déconnecter ?")) return;
    idbDel("courante");
    ["duree", "install", "auth"].forEach(retirer);
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

  window.addEventListener("error", function () { msg("msgGlobal", "Un problème est survenu, recommence.", true); });

  sb.auth.getSession().then(function (r) {
    if (r.data && r.data.session) return apresConnexion();
    montrer("Connexion");
  }).catch(function () { montrer("Connexion"); });
})();
