/* ============================================================
 * Tableau Virtuel — logique de la page de projection (PC)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Rôle : afficher les contenus et obéir au téléphone rattaché.
 * Le PC n’a PAS de compte. Il ne fait confiance qu’à un téléphone :
 *   1) approuvé par le propriétaire (double authentification, côté base) ;
 *   2) dont les messages se déchiffrent avec la clé de session ;
 *   3) tant que la base répond « approuvé » (pulsation toutes les 4 s).
 * Les contenus restent sur ce PC (aucun envoi), les messages sont chiffrés.
 * ============================================================ */
(function () {
  "use strict";

  // Anti-cadrage : si la page est placée dans le cadre d’un autre site, on la masque.
  try { if (window.top !== window.self) { document.documentElement.hidden = true; return; } }
  catch (e) { document.documentElement.hidden = true; return; }

  // ---------- Constantes ----------
  var DELAI_ATTENTE_MS = 1500;         // vérification pendant le rattachement
  var DELAI_PULSATION_MS = 4000;       // vérification une fois rattaché
  var ECHECS_MAX = 22;                 // ~90 s sans réponse de la base : verrouillage
  var MAX_CONTENUS = 200;
  var TAILLE_MAX_FICHIER = 300 * 1024 * 1024;
  var TAILLE_MAX_HTML = 5 * 1024 * 1024;
  var SALVE_MAX = 60, SALVE_PAR_SEC = 40; // limitation des messages reçus

  // ---------- Éléments de la page ----------
  function $(id) { return document.getElementById(id); }
  var scene = $("scene"), vide = $("vide"), laser = $("laser"), noir = $("noir"), bandeau = $("bandeau");
  var barre = $("barre"), statut = $("statut"), attente = $("attente");

  // ---------- État ----------
  var contenus = [];                   // { n:nom, k:genre, blob:Blob, url:string }
  var cur = -1, page = 1, pages = 0, zoom = 1, enLecture = false, ecranNoir = false;
  var pdfDoc = null, tachePdf = null, jetonRendu = 0;
  var pairage = null;                  // { id, secret, paire, pubTxt, minuteur, derive, cles }
  var salon = null, sb = null;
  var dernierN = 0, jetons = SALVE_MAX, dernierRecharge = Date.now();
  var echecs = 0, minuteurLaser = null, minuteurBandeau = null, minuteurBarre = null, minuteurEtat = null;

  // ---------- Client Supabase (sans session : le PC n’a pas de compte) ----------
  function client() {
    if (!sb) {
      sb = supabase.createClient(TV_CONFIG.SUPABASE_URL, TV_CONFIG.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
    }
    return sb;
  }

  // ---------- Messages à l’écran ----------
  function msgAttente(t, erreur) {
    var e = $("msgAttente");
    e.textContent = t || "";
    e.className = "msg" + (erreur ? " erreur" : "");
  }
  function majStatut(t) { statut.textContent = t; }

  // ============================================================
  // 1) Gestion des contenus
  // ============================================================
  function genreDe(f) {
    var nom = f.name.toLowerCase(), t = f.type || "";
    if (/\.pdf$/.test(nom) || t === "application/pdf") return "pdf";
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(nom) || /^image\//.test(t)) return "image";
    if (/\.(mp4|webm|ogg)$/.test(nom) || /^video\//.test(t)) return "video";
    if (/\.html?$/.test(nom) || t === "text/html") return "html";
    return null;
  }
  function ajouterFichiers(liste) {
    var refus = 0;
    Array.prototype.forEach.call(liste, function (f) {
      var g = genreDe(f);
      if (!g || f.size > TAILLE_MAX_FICHIER || (g === "html" && f.size > TAILLE_MAX_HTML) || contenus.length >= MAX_CONTENUS) { refus++; return; }
      contenus.push({ n: f.name.slice(0, 120), k: g, blob: f, url: g === "html" ? "" : URL.createObjectURL(f) });
    });
    if (refus) flash(refus + " fichier(s) refusé(s) (genre, taille ou nombre).");
    if (cur < 0 && contenus.length) ouvrir(0); else envoyerEtatPlusTard();
    majVide();
  }
  function majVide() { vide.style.display = contenus.length ? "none" : "flex"; }

  function flash(t) {
    bandeau.textContent = t; bandeau.style.display = "block";
    clearTimeout(minuteurBandeau);
    minuteurBandeau = setTimeout(function () { bandeau.style.display = "none"; }, 8000);
  }

  function viderScene() {
    jetonRendu++;
    if (tachePdf) { try { tachePdf.cancel(); } catch (e) { /* rien */ } tachePdf = null; }
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (e) { /* rien */ } pdfDoc = null; }
    while (scene.firstChild) scene.removeChild(scene.firstChild);
    pages = 0; page = 1; enLecture = false;
  }

  function ouvrir(i) {
    if (i < 0 || i >= contenus.length) return;
    cur = i; zoom = 1;
    var c = contenus[i];
    viderScene();
    scene.scrollTop = 0;
    if (c.k === "image") {
      var im = document.createElement("img"); im.src = c.url; im.alt = c.n; scene.appendChild(im);
    } else if (c.k === "video") {
      var v = document.createElement("video"); v.src = c.url; v.playsInline = true;
      v.addEventListener("play", function () { enLecture = true; envoyerEtatPlusTard(); });
      v.addEventListener("pause", function () { enLecture = false; envoyerEtatPlusTard(); });
      scene.appendChild(v);
    } else if (c.k === "pdf") {
      ouvrirPdf(c);
    } else if (c.k === "html") {
      var fr = document.createElement("iframe");
      fr.setAttribute("sandbox", "allow-scripts"); fr.title = c.n; fr.src = "viewer.html";
      fr.addEventListener("load", function () {
        c.blob.text().then(function (h) { fr.contentWindow.postMessage({ type: "html", html: h }, "*"); });
      });
      scene.appendChild(fr);
    } else if (c.k === "url") {
      var fu = document.createElement("iframe");
      fu.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
      fu.setAttribute("referrerpolicy", "no-referrer"); fu.title = c.n; fu.src = c.url;
      scene.appendChild(fu);
    }
    envoyerEtatPlusTard();
  }

  // ---------- PDF (pdf.js local) ----------
  function ouvrirPdf(c) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "js/lib/pdf.worker.min.js";
    var cv = document.createElement("canvas"); scene.appendChild(cv);
    var mon = ++jetonRendu;
    c.blob.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false }).promise;
    }).then(function (doc) {
      if (mon !== jetonRendu) { doc.destroy(); return; }
      pdfDoc = doc; pages = doc.numPages; page = 1; dessinerPdf(); envoyerEtatPlusTard();
    }).catch(function () { flash("Ce PDF n’a pas pu être ouvert."); });
  }
  function dessinerPdf() {
    if (!pdfDoc) return;
    var cv = scene.querySelector("canvas"); if (!cv) return;
    var mon = ++jetonRendu;
    if (tachePdf) { try { tachePdf.cancel(); } catch (e) { /* rien */ } }
    pdfDoc.getPage(page).then(function (p) {
      if (mon !== jetonRendu) return;
      var v0 = p.getViewport({ scale: 1 });
      var s = Math.min(scene.clientWidth / v0.width, scene.clientHeight / v0.height) * zoom;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var vp = p.getViewport({ scale: s * dpr });
      cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
      cv.style.width = Math.floor(vp.width / dpr) + "px"; cv.style.height = Math.floor(vp.height / dpr) + "px";
      tachePdf = p.render({ canvasContext: cv.getContext("2d"), viewport: vp });
      return tachePdf.promise;
    }).catch(function () { /* rendu annulé : normal */ });
  }

  // ============================================================
  // 2) Exécution des commandes (déjà validées par TVProto)
  // ============================================================
  function contenuCourant() { return cur >= 0 ? contenus[cur] : null; }
  function relayerHtml(m) {
    var fr = scene.querySelector("iframe");
    if (fr && contenuCourant() && contenuCourant().k === "html") fr.contentWindow.postMessage({ type: "relais", m: m }, "*");
  }
  function executer(m) {
    var c = contenuCourant();
    switch (m.c) {
      case "suivant":
        if (c && c.k === "pdf" && page < pages) { page++; dessinerPdf(); }
        else if (!c || c.k !== "pdf") ouvrir(Math.min(cur + 1, contenus.length - 1));
        break;
      case "precedent":
        if (c && c.k === "pdf" && page > 1) { page--; dessinerPdf(); }
        else if (!c || c.k !== "pdf") ouvrir(Math.max(cur - 1, 0));
        break;
      case "contenuSuivant": ouvrir(Math.min(cur + 1, contenus.length - 1)); break;
      case "contenuPrecedent": ouvrir(Math.max(cur - 1, 0)); break;
      case "ouvrir": ouvrir(m.i); break;
      case "zoom":
        zoom = m.v;
        if (c && c.k === "pdf") dessinerPdf();
        else if (c && c.k === "image") { var im = scene.querySelector("img"); if (im) im.style.transform = "scale(" + zoom + ")"; }
        break;
      case "lecture": {
        var v = scene.querySelector("video");
        if (v) { if (m.on) v.play().catch(function () { /* lecture refusée par le navigateur */ }); else v.pause(); }
        break;
      }
      case "saut": { var vv = scene.querySelector("video"); if (vv) vv.currentTime = Math.max(0, vv.currentTime + m.v); break; }
      case "laser":
        if (m.on) {
          laser.style.left = (m.x * 100) + "vw"; laser.style.top = (m.y * 100) + "vh"; laser.style.display = "block";
          clearTimeout(minuteurLaser); minuteurLaser = setTimeout(function () { laser.style.display = "none"; }, 3000);
        } else laser.style.display = "none";
        break;
      case "noir": ecranNoir = m.on; noir.style.display = m.on ? "block" : "none"; break;
      case "defiler":
        if (c && c.k === "html") relayerHtml({ t: "defiler", dy: m.dy }); else scene.scrollTop += m.dy;
        break;
      case "message": flash(m.v); relayerHtml({ t: "message", v: m.v }); break;
      case "url":
        if (contenus.length < MAX_CONTENUS) {
          var u = new URL(m.v);
          contenus.push({ n: u.hostname.slice(0, 120), k: "url", blob: null, url: u.href });
          majVide(); ouvrir(contenus.length - 1);
        }
        break;
      case "etat": envoyerEtat(); return;
    }
    envoyerEtatPlusTard();
  }

  // ============================================================
  // 3) Canal chiffré avec le téléphone
  // ============================================================
  function recevoir(payload) {
    if (!pairage || !pairage.cles) return;
    // Limitation de débit (anti-saturation)
    var now = Date.now();
    jetons = Math.min(SALVE_MAX, jetons + (now - dernierRecharge) / 1000 * SALVE_PAR_SEC); dernierRecharge = now;
    if (jetons < 1) return; jetons -= 1;
    if (!payload || typeof payload.d !== "string") return;
    TVCrypto.dechiffrer(pairage.cles.cleTelVersPc, "tel->pc", payload.d).then(function (o) {
      if (o.n <= dernierN) return;                    // rejeu ou ancien message : ignoré
      dernierN = o.n;
      var m = TVProto.validerCommande(o.m);
      if (m) executer(m);
    }).catch(function () { /* message illisible : ignoré sans bruit */ });
  }
  function ouvrirSalon() {
    fermerSalon();
    salon = client().channel(pairage.cles.salon, { config: { broadcast: { self: false } } });
    salon.on("broadcast", { event: "m" }, function (e) { recevoir(e.payload); });
    salon.subscribe(function (s) { if (s === "SUBSCRIBED") envoyerEtat(); });
  }
  function fermerSalon() {
    if (salon) { try { client().removeChannel(salon); } catch (e) { /* rien */ } salon = null; }
  }
  function envoyerEtatPlusTard() { clearTimeout(minuteurEtat); minuteurEtat = setTimeout(envoyerEtat, 150); }
  function envoyerEtat() {
    if (!salon || !pairage || !pairage.cles) return;
    var etat = {
      c: "etat", cur: cur, page: page, pages: pages, zoom: zoom, lecture: enLecture, noir: ecranNoir,
      items: contenus.map(function (x) { return { n: x.n, k: x.k }; })
    };
    TVCrypto.chiffrer(pairage.cles.clePcVersTel, "pc->tel", etat).then(function (d) {
      salon.send({ type: "broadcast", event: "m", payload: { d: d } });
    });
  }

  // ============================================================
  // 4) Rattachement et pulsation
  // ============================================================
  function afficherAttente(oui) {
    attente.style.display = oui ? "flex" : "none";
    $("bFermerAttente").classList.toggle("cache", !(oui && contenus.length));
  }

  // Arrête tout et efface les clés (fin de session, révocation, expiration).
  function verrouiller(raison) {
    if (pairage && pairage.minuteur) clearTimeout(pairage.minuteur);
    fermerSalon();
    pairage = null; dernierN = 0; echecs = 0;
    laser.style.display = "none"; noir.style.display = "none"; ecranNoir = false;
    contenus.forEach(function (c) { if (c.url && c.k !== "url") URL.revokeObjectURL(c.url); });
    contenus = []; cur = -1; viderScene(); majVide();
    majStatut("Téléphone non rattaché");
    $("qr").classList.add("cache"); $("blocCode").classList.add("cache");
    afficherAttente(true);
    msgAttente(raison || "", !!raison);
  }

  function demarrerRattachement() {
    if (pairage && pairage.minuteur) clearTimeout(pairage.minuteur);
    fermerSalon(); pairage = null;
    $("qr").classList.add("cache"); $("blocCode").classList.add("cache");
    msgAttente("Préparation du code…");
    afficherAttente(true);
    var secret = TVCrypto.genSecret(), p = { secret: secret, derive: false, cles: null, approuve: false };
    pairage = p;
    TVCrypto.genPaire().then(function (paire) {
      p.paire = paire;
      return Promise.all([TVCrypto.pubVersTexte(paire), TVCrypto.empreinte(secret)]);
    }).then(function (r) {
      p.pubTxt = r[0];
      return client().rpc("tv_pair_start", { p_pc_pub: r[0], p_secret_hash: r[1] });
    }).then(function (res) {
      if (pairage !== p) return;
      if (res.error || !res.data || !res.data.id) {
        msgAttente(/trop_de_demandes/.test(res.error && res.error.message || "") ? "Trop de demandes. Attends une minute, puis réessaie." : "Le service est injoignable. Vérifie la connexion.", true);
        return;
      }
      p.id = res.data.id;
      // Le lien contient l’identifiant et la clé PUBLIQUE du PC (jamais le secret du PC).
      var lien = new URL("index.html", location.href).href + "#p=" + p.id + "." + p.pubTxt;
      var qr = qrcode(0, "M"); qr.addData(lien); qr.make();
      $("qr").src = qr.createDataURL(6, 2); $("qr").classList.remove("cache");
      msgAttente("En attente du téléphone… (le code expire dans 3 minutes)");
      boucle(p);
    }).catch(function () { msgAttente("Erreur de préparation. Recharge la page.", true); });
  }

  // Interroge la base à intervalle régulier : état du rattachement, puis pulsation.
  function boucle(p) {
    if (pairage !== p) return;
    client().rpc("tv_pc_poll", { p_id: p.id, p_secret: p.secret }).then(function (res) {
      if (pairage !== p) return;
      if (res.error || !res.data) {
        echecs++;
        if (p.approuve && echecs > ECHECS_MAX) { verrouiller("Connexion perdue : session fermée par sécurité."); return; }
        if (!p.approuve && echecs > 40) { msgAttente("Le service ne répond pas.", true); return; }
        p.minuteur = setTimeout(function () { boucle(p); }, DELAI_PULSATION_MS); return;
      }
      echecs = 0;
      var st = res.data.status;
      if (res.data.max_until) p.finMax = new Date(res.data.max_until).getTime();
      // Contrôle local de la durée maximale (sans attendre la base).
      if (p.approuve && p.finMax && Date.now() > p.finMax) { verrouiller("Session expirée."); return; }
      if ((st === "claimed" || st === "approved") && !p.derive && res.data.phone_pub) {
        p.derive = true;
        TVCrypto.deriver(p.paire.privateKey, res.data.phone_pub, p.pubTxt, res.data.phone_pub).then(function (cles) {
          p.cles = cles;
          $("codeControle").textContent = cles.code;
          $("blocCode").classList.remove("cache");
          msgAttente("Saisis ce code sur le téléphone.");
        }).catch(function () { verrouiller("Échange de clés impossible."); });
      } else if (st === "approved" && p.cles && !p.approuve) {
        p.approuve = true;
        afficherAttente(false); majStatut("Téléphone rattaché"); ouvrirSalon();
      } else if (st === "revoked") { verrouiller("Session révoquée depuis le téléphone."); return; }
      else if (st === "expired" || st === "unknown") {
        if (p.approuve) { verrouiller("Session expirée."); return; }
        msgAttente("Code expiré. Appuie sur « Nouveau code ».", true);
        $("qr").classList.add("cache"); $("blocCode").classList.add("cache"); return;
      }
      p.minuteur = setTimeout(function () { boucle(p); }, p.approuve ? DELAI_PULSATION_MS : DELAI_ATTENTE_MS);
    }).catch(function () {
      // Erreur imprévue : elle compte comme un échec (fermeture par sécurité si elle se répète).
      echecs++;
      if (p.approuve && echecs > ECHECS_MAX) { verrouiller("Connexion perdue : session fermée par sécurité."); return; }
      p.minuteur = setTimeout(function () { boucle(p); }, DELAI_PULSATION_MS);
    });
  }

  // ============================================================
  // 5) Barre d’outils et événements
  // ============================================================
  function reveillerBarre() {
    barre.classList.remove("discret");
    clearTimeout(minuteurBarre);
    minuteurBarre = setTimeout(function () { barre.classList.add("discret"); }, 4000);
  }
  document.addEventListener("mousemove", reveillerBarre);
  document.addEventListener("keydown", reveillerBarre);

  $("bAjouter").addEventListener("click", function () { $("fichiers").click(); });
  $("fichiers").addEventListener("change", function (e) { ajouterFichiers(e.target.files); e.target.value = ""; });
  $("bPleinEcran").addEventListener("click", function () {
    var el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen().catch(function () { /* refusé */ });
  });
  $("bRattacher").addEventListener("click", function () {
    if (pairage && pairage.approuve) { afficherAttente(true); return; }
    demarrerRattachement();
  });
  $("bRegenerer").addEventListener("click", demarrerRattachement);
  $("bFermerAttente").addEventListener("click", function () { afficherAttente(false); });

  // Glisser-déposer de fichiers
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) ajouterFichiers(e.dataTransfer.files);
  });
  window.addEventListener("resize", function () { if (contenuCourant() && contenuCourant().k === "pdf") dessinerPdf(); });
  // Erreur imprévue : message clair, sans détail technique.
  window.addEventListener("error", function () { flash("Un problème est survenu, recommence."); });

  // ---------- Démarrage ----------
  majVide(); reveillerBarre(); demarrerRattachement();
})();
