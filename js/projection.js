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
  var SALVE_MAX = 80, SALVE_PAR_SEC = 50;   // limitation des messages reçus
  var DELAI_APERCU_MS = 600;           // une image d’aperçu toutes les 0,6 s
  var DUREE_APERCU_MS = 15000;         // l’aperçu s’arrête si le téléphone ne le redemande pas
  var DUREE_LASER_MS = 15000;          // le pointeur reste visible 15 s après le dernier mouvement
  // Sites qui refusent presque toujours d’être affichés dans un cadre.
  // (liste établie par des essais réels : ces sites ont affiché une page blanche dans le cadre)
  var SITES_REFUSANT = /(^|\.)(google\.[a-z.]+|facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|netflix\.com|amazon\.[a-z.]+|youtube\.com|lumni\.fr|vikidia\.org|eduscol\.education\.fr|scratch\.mit\.edu|gallica\.bnf\.fr)$/;

  // ---------- Éléments de la page ----------
  function $(id) { return document.getElementById(id); }
  var scene = $("scene"), vide = $("vide"), laser = $("laser"), noir = $("noir"), bandeau = $("bandeau");
  var barre = $("barre"), statut = $("statut"), attente = $("attente"), panneau = $("panneau"), apercuVideo = $("apercuVideo");

  // ---------- État ----------
  var contenus = [];                   // { n, k, o, blob, url, stream, direct }
  var cur = -1, page = 1, pages = 0, zoom = 1, enLecture = false, ecranNoir = false;
  var champActif = false, champVal = "";
  var pdfDoc = null, tachePdf = null, jetonRendu = 0;
  var pairage = null;                  // { id, secret, paire, pubTxt, minuteur, derive, cles }
  var salon = null, sb = null, accepte = TVCrypto.garde();
  var jetons = SALVE_MAX, dernierRecharge = Date.now();
  var echecs = 0, minuteurLaser = null, minuteurBandeau = null, minuteurBarre = null, minuteurEtat = null;
  var apercuJusqua = 0, minuteurApercu = null, captureApercu = null, transfert = null;

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
  function flash(t) {
    bandeau.textContent = t; bandeau.style.display = "block";
    clearTimeout(minuteurBandeau);
    minuteurBandeau = setTimeout(function () { bandeau.style.display = "none"; }, 8000);
  }

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
  function genreDeMime(t) {
    if (t === "application/pdf") return "pdf";
    if (/^image\//.test(t)) return "image";
    if (/^video\//.test(t)) return "video";
    return "html";
  }
  function creerFichier(nom, genre, blob, origine) {
    contenus.push({ n: nom.slice(0, 120), k: genre, o: origine, blob: blob, url: genre === "html" ? "" : URL.createObjectURL(blob) });
  }
  function ajouterFichiers(liste) {
    var refus = 0, avant = contenus.length;
    Array.prototype.forEach.call(liste, function (f) {
      var g = genreDe(f);
      if (!g || f.size > TAILLE_MAX_FICHIER || (g === "html" && f.size > TAILLE_MAX_HTML) || contenus.length >= MAX_CONTENUS) { refus++; return; }
      creerFichier(f.name, g, f, "pc");
    });
    if (refus) flash(refus + " fichier(s) refusé(s) (genre, taille ou nombre).");
    if (contenus.length > avant) ouvrir(avant); else majTout();
  }

  // YouTube n’autorise l’affichage que par son adresse « intégrée » (sans cookies).
  function adresseYoutube(u) {
    var h = u.hostname.replace(/^www\.|^m\./, ""), id = null, liste = u.searchParams.get("list");
    if (h === "youtu.be") id = u.pathname.slice(1);
    else if (h === "youtube.com" || h === "youtube-nocookie.com") {
      var m = u.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
      id = m ? m[1] : u.searchParams.get("v");
      if (!id && /^\/playlist/.test(u.pathname) && liste && /^[A-Za-z0-9_-]{10,60}$/.test(liste))
        return "https://www.youtube-nocookie.com/embed/videoseries?list=" + liste;
    } else return null;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return "refus";
    return "https://www.youtube-nocookie.com/embed/" + id + "?rel=0";
  }
  // Ajoute un site (https seulement). Renvoie vrai si ajouté.
  function ajouterAdresse(brut, origine) {
    var u;
    try { u = new URL(String(brut).trim()); } catch (e) { flash("Adresse invalide."); return false; }
    if (u.protocol !== "https:" || u.username || u.password || u.hostname.indexOf(".") < 0 || contenus.length >= MAX_CONTENUS) {
      flash("Seules les adresses https:// sont acceptées."); return false;
    }
    var nom = u.hostname, lien = u.href, yt = adresseYoutube(u);
    if (yt === "refus") { flash("YouTube : colle l’adresse d’une vidéo, ou utilise « Afficher un onglet du navigateur »."); return false; }
    var estYt = false;
    if (yt) { lien = yt + "&enablejsapi=1&origin=" + encodeURIComponent(location.origin); nom = "YouTube"; estYt = true; }
    else if (SITES_REFUSANT.test(u.hostname)) flash("Ce site refuse souvent l’affichage dans un cadre. S’il reste vide, utilise « Afficher un onglet du navigateur ».");
    contenus.push({ n: nom.slice(0, 120), k: "url", o: origine, blob: null, url: lien, yt: estYt, ytT: 0 });
    ouvrir(contenus.length - 1);
    return true;
  }
  // Affiche un onglet, une fenêtre ou un écran choisi dans le navigateur (n’importe quel site, même YouTube).
  function ajouterEcran() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { flash("Ce navigateur ne permet pas de partager un onglet."); return; }
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(function (flux) {
      var piste = flux.getVideoTracks()[0], nom = (piste && piste.label && piste.label.length < 60 && !/^web-contents/.test(piste.label)) ? piste.label : "Onglet partagé";
      var c = { n: nom, k: "ecran", o: "pc", blob: null, url: "", stream: flux };
      contenus.push(c);
      if (piste) piste.addEventListener("ended", function () { var i = contenus.indexOf(c); if (i >= 0) fermer(i); });
      ouvrir(contenus.length - 1);
    }).catch(function () { /* choix annulé */ });
  }

  function arreterContenu(c) {
    if (c.url && c.k !== "url") URL.revokeObjectURL(c.url);
    if (c.stream) c.stream.getTracks().forEach(function (t) { t.stop(); });
  }
  function fermer(i) {
    if (i < 0 || i >= contenus.length) return;
    arreterContenu(contenus[i]);
    contenus.splice(i, 1);
    if (!contenus.length) { cur = -1; viderScene(); majTout(); }
    else if (i === cur) ouvrir(Math.min(i, contenus.length - 1));
    else { if (i < cur) cur--; majTout(); }
  }
  function toutFermer() {
    contenus.forEach(arreterContenu); contenus = []; cur = -1; viderScene(); majTout();
  }

  function viderScene() {
    jetonRendu++;
    if (tachePdf) { try { tachePdf.cancel(); } catch (e) { /* rien */ } tachePdf = null; }
    if (pdfDoc) { try { pdfDoc.destroy(); } catch (e) { /* rien */ } pdfDoc = null; }
    while (scene.firstChild) scene.removeChild(scene.firstChild);
    pages = 0; page = 1; enLecture = false; champActif = false; champVal = "";
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
    } else if (c.k === "ecran") {
      var ve = document.createElement("video"); ve.autoplay = true; ve.playsInline = true; ve.srcObject = c.stream; scene.appendChild(ve);
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
      // « allow-same-origin » est indispensable aux sites qui utilisent leur stockage (ex. : casier).
      // Il est sans danger pour cette page : le site affiché vient d’une autre origine (sauf tes propres
      // pages du même site, que tu maîtrises). Sans lui, ces sites affichent une erreur.
      // Sites connus pour refuser tout affichage dans un cadre (Google, YouTube hors vidéo, etc.) :
      // aucune astuce ne contourne ce refus. On affiche donc deux choix qui marchent à coup sûr.
      var hote = ""; try { hote = new URL(c.url).hostname; } catch (e) { /* adresse déjà validée */ }
      if (SITES_REFUSANT.test(hote) && !c.force) { scene.appendChild(carteRefus(c, i)); majTout(); return; }
      var fu = document.createElement("iframe");
      fu.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation");
      fu.setAttribute("allow", "autoplay; fullscreen; encrypted-media; picture-in-picture");
      // L’adresse de cette page (sans chemin) doit être transmise : YouTube refuse sinon la vidéo (erreur 153).
      fu.setAttribute("referrerpolicy", "strict-origin-when-cross-origin"); fu.title = c.n; fu.src = c.url;
      fu.addEventListener("load", function () {
        c.direct = fenetreAccessible(fu) !== null;
        if (c.yt) ytEcoute();                                   // lecteur YouTube : on s’abonne à son état
        envoyerEtatPlusTard();
      });
      scene.appendChild(fu);
    }
    majTout();
  }
  // Carte affichée à la place d’un site qui refuse le cadre : fenêtre séparée, ou partage d’onglet.
  function carteRefus(c, i) {
    var d = document.createElement("div"); d.className = "carte-refus";
    var t = document.createElement("h2"); t.textContent = c.n + " refuse d’être affiché ici";
    var p = document.createElement("p"); p.textContent = "Ce site interdit en général l’affichage dans une autre page (protection du site). Trois solutions :";
    d.appendChild(t); d.appendChild(p);
    d.appendChild(bouton("Ouvrir dans une fenêtre du navigateur", "Ouvrir " + c.n + " dans une fenêtre", function () { window.open(c.url, "_blank", "noopener,noreferrer"); }));
    d.appendChild(bouton("Afficher un onglet du navigateur (partage)", "Partager un onglet", function () { ajouterEcran(); }));
    d.appendChild(bouton("Essayer de l’afficher quand même", "Essayer l’affichage dans la page", function () { c.force = true; ouvrir(i); }));
    var q = document.createElement("p"); q.className = "petit";
    q.textContent = "Avec le partage d’onglet, ouvre le site dans un onglet, choisis-le dans la liste : il s’affiche ici, sans cadre.";
    d.appendChild(q); return d;
  }
  // Fenêtre d’un cadre dont on peut lire le contenu (même site seulement), sinon null.
  function fenetreAccessible(fr) {
    try { return fr && fr.contentWindow && fr.contentWindow.document ? fr.contentWindow : null; }
    catch (e) { return null; }
  }
  function cadreCourant() { return scene.querySelector("iframe"); }

  // ---------- PDF (pdf.js local) ----------
  function ouvrirPdf(c) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "js/lib/pdf.worker.min.js";
    var cv = document.createElement("canvas"); scene.appendChild(cv);
    var mon = ++jetonRendu;
    c.blob.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, enableXfa: false }).promise;
    }).then(function (doc) {
      if (mon !== jetonRendu) { doc.destroy(); return; }
      pdfDoc = doc; pages = doc.numPages; page = 1; dessinerPdf(); majBlocPage(); envoyerEtatPlusTard();
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

  // ---------- Panneau des contenus ----------
  function bouton(texte, titre, fn, extra) {
    var b = document.createElement("button"); b.type = "button"; b.textContent = texte; b.title = titre; b.setAttribute("aria-label", titre);
    if (extra) b.className = extra;
    b.addEventListener("click", fn); return b;
  }
  function majPanneau() {
    var ul = $("listeContenus"); while (ul.firstChild) ul.removeChild(ul.firstChild);
    $("aucunContenu").classList.toggle("cache", contenus.length > 0);
    $("bContenus").textContent = "Contenus (" + contenus.length + ")";
    contenus.forEach(function (c, i) {
      var li = document.createElement("li");
      var nom = bouton((c.o === "tel" ? "📱 " : "🖥️ ") + c.n, "Afficher : " + c.n, function () { ouvrir(i); }, "nom");
      nom.setAttribute("aria-current", i === cur ? "true" : "false");
      li.appendChild(nom);
      if (c.k === "url") li.appendChild(bouton("↗", "Ouvrir dans une fenêtre du navigateur : " + c.n, function () { window.open(c.url, "_blank", "noopener,noreferrer"); }));
      li.appendChild(bouton("✕", "Fermer : " + c.n, function () { fermer(i); }));
      ul.appendChild(li);
    });
  }
  // Champ « Aller à la page » du panneau (visible seulement pour un PDF de plusieurs pages).
  function majBlocPage() {
    var c = contenuCourant(), oui = !!(c && c.k === "pdf" && pages > 1);
    $("blocPage").classList.toggle("cache", !oui);
    if (oui) { $("champPage").max = String(pages); $("infoPage").textContent = "Page " + page + " sur " + pages; }
  }
  function majTout() { majBlocPage(); majPanneau(); vide.style.display = contenus.length ? "none" : "flex"; envoyerEtatPlusTard(); }

  // ============================================================
  // 2) Exécution des commandes (déjà validées par TVProto)
  // ============================================================
  function contenuCourant() { return cur >= 0 ? contenus[cur] : null; }
  function relayerHtml(m) {
    var fr = cadreCourant();
    if (fr && contenuCourant() && contenuCourant().k === "html") fr.contentWindow.postMessage({ type: "relais", m: m }, "*");
  }
  // Fenêtre où l’on peut cliquer/écrire en direct (page du même site), sinon null.
  function fenetreDirecte() {
    var c = contenuCourant(); return c && c.k === "url" ? fenetreAccessible(cadreCourant()) : null;
  }
  function clicPossible() {
    var c = contenuCourant(); if (!c) return false;
    return c.k === "html" || (c.k === "url" && c.direct === true);
  }
  function positionLaser(x, y) {
    laser.style.left = (x * 100) + "vw"; laser.style.top = (y * 100) + "vh"; laser.style.display = "block";
    clearTimeout(minuteurLaser); minuteurLaser = setTimeout(function () { laser.style.display = "none"; }, DUREE_LASER_MS);
  }
  function executer(m) {
    var c = contenuCourant(), w;
    switch (m.c) {
      case "suivant":
        if (c && c.k === "pdf" && page < pages) { page++; dessinerPdf(); majBlocPage(); }
        else if (!c || c.k !== "pdf") ouvrir(Math.min(cur + 1, contenus.length - 1));
        break;
      case "precedent":
        if (c && c.k === "pdf" && page > 1) { page--; dessinerPdf(); majBlocPage(); }
        else if (!c || c.k !== "pdf") ouvrir(Math.max(cur - 1, 0));
        break;
      case "contenuSuivant": ouvrir(Math.min(cur + 1, contenus.length - 1)); break;
      case "contenuPrecedent": ouvrir(Math.max(cur - 1, 0)); break;
      case "ouvrir": ouvrir(m.i); break;
      case "fermer": fermer(m.i); break;
      case "toutFermer": toutFermer(); break;
      case "zoom":
        zoom = m.v;
        if (c && c.k === "pdf") dessinerPdf();
        else if (c && (c.k === "image" || c.k === "ecran")) { var el = scene.querySelector("img,video"); if (el) el.style.transform = "scale(" + zoom + ")"; }
        break;
      case "lecture": {
        if (c && c.yt) { ytCmd(m.on ? "playVideo" : "pauseVideo"); break; }
        var v = scene.querySelector("video");
        if (v) { if (m.on) v.play().catch(function () { /* lecture refusée par le navigateur */ }); else v.pause(); }
        break;
      }
      case "page":
        if (c && c.k === "pdf" && pages) { page = Math.min(m.v, pages); dessinerPdf(); majBlocPage(); }
        break;
      case "saut": {
        if (c && c.yt) { ytCmd("seekTo", [Math.max(0, (c.ytT || 0) + m.v), true]); break; } var vv = scene.querySelector("video"); if (vv && c.k === "video") vv.currentTime = Math.max(0, vv.currentTime + m.v); break; }
      case "laser":
        if (m.on) positionLaser(m.x, m.y); else laser.style.display = "none";
        break;
      case "clic":
        positionLaser(m.x, m.y);
        laser.classList.remove("clic"); void laser.offsetWidth; laser.classList.add("clic");
        if (c && c.k === "html") relayerHtml({ t: "clic", x: m.x, y: m.y, b: m.b });
        else if ((w = fenetreDirecte())) {
          try { var r = TVClic.cliquerDans(w, m.x, m.y, m.b); champActif = r.champ; champVal = r.val; } catch (e) { /* page inaccessible */ }
        }
        break;
      case "texte":
        champVal = m.v;
        if (c && c.k === "html") relayerHtml({ t: "texte", v: m.v });
        else if ((w = fenetreDirecte())) { try { TVClic.ecrireDans(w, m.v); } catch (e) { /* rien */ } }
        break;
      case "touche":
        if (c && c.k === "html") relayerHtml({ t: "touche", k: m.k });
        else if ((w = fenetreDirecte())) { try { TVClic.toucherDans(w, m.k); } catch (e) { /* rien */ } }
        break;
      case "noir": ecranNoir = m.on; noir.style.display = m.on ? "block" : "none"; break;
      case "apercu": apercuJusqua = m.on ? Date.now() + DUREE_APERCU_MS : 0; break;
      case "defiler":
        if (c && c.k === "html") relayerHtml({ t: "defiler", dy: m.dy });
        else if ((w = fenetreDirecte())) { try { w.scrollBy(0, m.dy); } catch (e) { /* rien */ } }
        else if (c && (c.k === "pdf" || c.k === "image")) scene.scrollTop += m.dy;
        break;
      case "message": flash(m.v); break;
      case "url": ajouterAdresse(m.v, "tel"); return;
      case "fichierDebut": debutFichier(m); return;
      case "fichierBloc": blocFichier(m); return;
      case "fichierFin": finFichier(m); return;
      case "fichierAnnuler": transfert = null; return;
      case "etat": envoyerEtat(); return;
    }
    envoyerEtatPlusTard();
  }
  // ---------- Lecteur YouTube intégré : lecture / pause / ±10 s par l’API officielle (sans clic) ----------
  var ORIGINE_YT = "https://www.youtube-nocookie.com";
  function ytEnvoi(obj) { var fr = cadreCourant(); if (fr) { try { fr.contentWindow.postMessage(JSON.stringify(obj), ORIGINE_YT); } catch (e) { /* lecteur absent */ } } }
  function ytCmd(f, args) { ytEnvoi({ event: "command", func: f, args: args || [] }); }
  function ytEcoute() { ytEnvoi({ event: "listening", id: 1, channel: "widget" }); }
  function ytMessage(e) {
    var c = contenuCourant(), fr = cadreCourant();
    if (!c || !c.yt || !fr || e.source !== fr.contentWindow || e.origin !== ORIGINE_YT || typeof e.data !== "string") return false;
    var d; try { d = JSON.parse(e.data); } catch (er) { return true; }
    if (d && d.event === "onReady") ytEcoute();
    var info = d && (d.info || null);
    if (info && typeof info.currentTime === "number") c.ytT = info.currentTime;
    if (info && typeof info.playerState === "number") { var en = info.playerState === 1; if (en !== enLecture) { enLecture = en; envoyerEtatPlusTard(); } }
    return true;
  }
  // Réponse d’une page HTML locale : un champ de texte est-il actif ?
  window.addEventListener("message", function (e) {
    if (ytMessage(e)) return;
    var fr = cadreCourant();
    if (!fr || e.source !== fr.contentWindow || !e.data || e.data.t !== "champ") return;
    champActif = e.data.champ === true; champVal = String(e.data.val || "").slice(0, 500);
    envoyerEtatPlusTard();
  });

  // ---------- Réception d’un fichier envoyé par le téléphone ----------
  function debutFichier(m) {
    if (contenus.length >= MAX_CONTENUS) { transfert = null; return; }
    transfert = { id: m.id, meta: { nom: m.nom, type: m.type, taille: m.taille, n: m.n }, ass: new TVTransfert.Assembleur({ type: m.type, taille: m.taille, n: m.n }) };
  }
  function blocFichier(m) {
    if (!transfert || transfert.id !== m.id) return;
    if (!transfert.ass.ajouter(m.i, m.d)) transfert = null;           // bloc invalide : on abandonne
  }
  function finFichier(m) {
    if (!transfert || transfert.id !== m.id) return;
    var t = transfert; transfert = null;
    if (!t.ass.complet()) { flash("Fichier reçu incomplet : il a été ignoré."); return; }
    var genre = genreDeMime(t.meta.type), nom = t.meta.nom.replace(/[\\\/:*?"<>|]/g, "_");
    creerFichier(nom, genre, t.ass.blob(), "tel");
    ouvrir(contenus.length - 1);
    flash("Fichier reçu du téléphone : " + nom);
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
      if (!accepte(o.n)) return;                      // rejeu ou message trop ancien : ignoré
      var m = TVProto.validerCommande(o.m);
      if (m) executer(m);
    }).catch(function () { /* message illisible : ignoré sans bruit */ });
  }
  function ouvrirSalon() {
    fermerSalon();
    salon = client().channel(pairage.cles.salon, { config: { broadcast: { self: false } } });
    salon.on("broadcast", { event: "m" }, function (e) { recevoir(e.payload); });
    salon.subscribe(function (s) { if (s === "SUBSCRIBED") envoyerEtat(); });
    clearInterval(minuteurApercu);
    minuteurApercu = setInterval(envoyerApercu, DELAI_APERCU_MS);
  }
  function fermerSalon() {
    clearInterval(minuteurApercu); minuteurApercu = null;
    if (salon) { try { client().removeChannel(salon); } catch (e) { /* rien */ } salon = null; }
  }
  function chiffrerEtEnvoyer(objet) {
    if (!salon || !pairage || !pairage.cles) return;
    TVCrypto.chiffrer(pairage.cles.clePcVersTel, "pc->tel", objet).then(function (d) {
      if (salon) salon.send({ type: "broadcast", event: "m", payload: { d: d } });
    });
  }
  function envoyerEtatPlusTard() { clearTimeout(minuteurEtat); minuteurEtat = setTimeout(envoyerEtat, 150); }
  function envoyerEtat() {
    chiffrerEtEnvoyer({
      c: "etat", cur: cur, page: page, pages: pages, zoom: zoom, lecture: enLecture, noir: ecranNoir,
      champ: champActif, val: champVal, cl: clicPossible(), ap: !!captureApercu,
      items: contenus.map(function (x) { return { n: x.n, k: x.k, o: x.o }; })
    });
  }

  // ---------- Aperçu de l’écran envoyé au téléphone ----------
  var vignette = document.createElement("canvas");
  function dessinerContain(ctx, src, sw, sh, W, H) {
    var s = Math.min(W / sw, H / sh), w = sw * s, h = sh * s;
    ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
  }
  function envoyerApercu() {
    if (!salon || !pairage || !pairage.cles || Date.now() > apercuJusqua || document.hidden) return;
    var W = 640, H = Math.max(120, Math.round(W * window.innerHeight / window.innerWidth));
    vignette.width = W; vignette.height = H;
    var ctx = vignette.getContext("2d"), c = contenuCourant();
    ctx.fillStyle = "#1f2937"; ctx.fillRect(0, 0, W, H);
    try {
      if (captureApercu && apercuVideo.videoWidth) {                       // aperçu complet (onglet partagé)
        ctx.drawImage(apercuVideo, 0, 0, W, H);
      } else if (c && c.k === "pdf" && scene.querySelector("canvas")) {
        var cv = scene.querySelector("canvas"); dessinerContain(ctx, cv, cv.width, cv.height, W, H);
      } else if (c && c.k === "image" && scene.querySelector("img")) {
        var im = scene.querySelector("img"); dessinerContain(ctx, im, im.naturalWidth || 1, im.naturalHeight || 1, W, H);
      } else if (c && (c.k === "video" || c.k === "ecran") && scene.querySelector("video") && scene.querySelector("video").videoWidth) {
        var vd = scene.querySelector("video"); dessinerContain(ctx, vd, vd.videoWidth, vd.videoHeight, W, H);
      } else {
        ctx.fillStyle = "#cbd5e1"; ctx.font = "20px system-ui, sans-serif"; ctx.textAlign = "center";
        ctx.fillText(c ? c.n : "Aucun contenu", W / 2, H / 2 - 10);
        if (c) { ctx.font = "15px system-ui, sans-serif"; ctx.fillText("Aperçu complet : bouton « Aperçu de l’écran » sur le PC", W / 2, H / 2 + 18); }
      }
    } catch (e) { /* image non lisible : on envoie le fond */ }
    chiffrerEtEnvoyer({ c: "image", d: vignette.toDataURL("image/jpeg", 0.5) });
  }
  // Partage de l’onglet courant (une validation dans le navigateur) pour un aperçu fidèle de tout l’écran.
  function basculerApercuComplet() {
    if (captureApercu) { arreterCapture(); majBoutonApercu(); envoyerEtatPlusTard(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) { flash("Ce navigateur ne permet pas l’aperçu complet."); return; }
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false, preferCurrentTab: true, selfBrowserSurface: "include" }).then(function (flux) {
      captureApercu = flux; apercuVideo.srcObject = flux; apercuVideo.play().catch(function () { /* rien */ });
      flux.getVideoTracks()[0].addEventListener("ended", function () { arreterCapture(); majBoutonApercu(); envoyerEtatPlusTard(); });
      majBoutonApercu(); envoyerEtatPlusTard();
    }).catch(function () { /* choix annulé */ });
  }
  function arreterCapture() {
    if (captureApercu) captureApercu.getTracks().forEach(function (t) { t.stop(); });
    captureApercu = null; apercuVideo.srcObject = null;
  }
  function majBoutonApercu() { $("bApercu").textContent = captureApercu ? "Arrêter l’aperçu complet" : "Aperçu complet de l’écran sur le téléphone"; }

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
    fermerSalon(); arreterCapture(); majBoutonApercu();
    pairage = null; accepte = TVCrypto.garde(); echecs = 0; transfert = null; apercuJusqua = 0;
    laser.style.display = "none"; noir.style.display = "none"; ecranNoir = false;
    toutFermer(); panneau.classList.add("cache");
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
    minuteurBarre = setTimeout(function () { if (panneau.classList.contains("cache")) barre.classList.add("discret"); }, 4000);
  }
  document.addEventListener("mousemove", reveillerBarre);
  document.addEventListener("keydown", reveillerBarre);

  $("bAjouter").addEventListener("click", function () { $("fichiers").click(); });
  $("fichiers").addEventListener("change", function (e) { ajouterFichiers(e.target.files); e.target.value = ""; });
  $("bContenus").addEventListener("click", function () {
    var ouvert = panneau.classList.toggle("cache") === false;
    $("bContenus").setAttribute("aria-expanded", ouvert ? "true" : "false");
  });
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
  $("bAjouterAdresse").addEventListener("click", function () { if (ajouterAdresse($("champAdresse").value, "pc")) $("champAdresse").value = "https://"; });
  $("champAdresse").addEventListener("keydown", function (e) { if (e.key === "Enter") $("bAjouterAdresse").click(); });
  $("bEcran").addEventListener("click", ajouterEcran);
  $("bApercu").addEventListener("click", basculerApercuComplet);
  $("bToutFermer").addEventListener("click", toutFermer);
  function allerPage() {
    var v = parseInt($("champPage").value, 10), c = contenuCourant();
    if (c && c.k === "pdf" && pages && v >= 1) { page = Math.min(v, pages); dessinerPdf(); majBlocPage(); envoyerEtatPlusTard(); }
  }
  $("bAllerPage").addEventListener("click", allerPage);
  $("champPage").addEventListener("keydown", function (e) { if (e.key === "Enter") allerPage(); });

  // Glisser-déposer : fichiers, ou adresse (lien, ou icône à gauche de la barre d’adresse du navigateur)
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) {
    e.preventDefault();
    var dt = e.dataTransfer; if (!dt) return;
    if (dt.files && dt.files.length) { ajouterFichiers(dt.files); return; }
    var t = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").split(/\r?\n/).filter(function (l) { return l && l.charAt(0) !== "#"; })[0];
    if (t) ajouterAdresse(t, "pc");
  });
  window.addEventListener("resize", function () { if (contenuCourant() && contenuCourant().k === "pdf") dessinerPdf(); });
  // Erreur imprévue : message clair, sans détail technique.
  window.addEventListener("error", function () { flash("Un problème est survenu, recommence."); });

  // Utilisé par js/maj.js : la mise à jour attend la fin d’une session ou de contenus ouverts.
  window.TV_OCCUPE = function () { return !!(pairage && pairage.approuve) || contenus.length > 0; };

  // ---------- Démarrage ----------
  majTout(); reveillerBarre(); demarrerRattachement();
})();
