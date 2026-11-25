/* ============================================================
 * Tableau Virtuel — installation (PWA), mise à jour
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * - propose l’installation : Android/Chrome/Edge (invite native), iPhone (étapes) ;
 * - ne propose jamais l’installation pendant que la télécommande est affichée.
 * ============================================================ */
(function () {
  "use strict";
  var CLE = "tv1_install";
  var DELAI_AVANT_AFFICHAGE_MS = 8000;
  var RAPPEL_JOURS = 5;
  function $(id) { return document.getElementById(id); }

  // Stockage protégé
  var mem = null;
  function lire() { try { return localStorage.getItem(CLE) || mem; } catch (e) { return mem; } }
  function ecrire(v) { mem = v; try { localStorage.setItem(CLE, v); } catch (e) { /* mémoire seule */ } }

  var invite = null;      // événement beforeinstallprompt gardé en mémoire
  var dlg = $("dlgInstall");
  var dejaInstallee = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  var estIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Le service worker et la mise à jour forcée sont gérés par js/maj.js.

  // ---------- Fenêtre d’installation ----------
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); invite = e; });
  window.addEventListener("appinstalled", function () {
    invite = null; ecrire("installee");
    if (dlg.open) dlg.close();
    $("bInstaller").classList.add("cache");
  });

  function ouvrir() {
    $("installIos").classList.toggle("cache", !estIos);
    $("installAutre").classList.toggle("cache", estIos || !!invite);
    $("bInstallerOui").classList.toggle("cache", estIos);
    if (!dlg.open && dlg.showModal) dlg.showModal();
  }
  function peutProposer() {
    if (dejaInstallee || document.body.getAttribute("data-vue") === "telecommande") return false;
    var v = lire();
    if (v === "jamais" || v === "installee") return false;
    if (v && v.indexOf("plustard:") === 0 && Date.now() < parseInt(v.slice(9), 10)) return false;
    return true;
  }

  $("bInstallerOui").addEventListener("click", function () {
    if (!invite) { $("installAutre").classList.remove("cache"); return; }
    invite.prompt();
    invite.userChoice.then(function (c) { ecrire(c.outcome === "accepted" ? "installee" : "plustard:" + (Date.now() + RAPPEL_JOURS * 86400000)); invite = null; dlg.close(); })
      .catch(function () { dlg.close(); });
  });
  $("bInstallerPlusTard").addEventListener("click", function () { ecrire("plustard:" + (Date.now() + RAPPEL_JOURS * 86400000)); dlg.close(); });
  $("bInstallerJamais").addEventListener("click", function () { ecrire("jamais"); dlg.close(); });
  $("bInstaller").addEventListener("click", ouvrir);   // bouton permanent (réglages)
  if (dejaInstallee) $("bInstaller").classList.add("cache");

  // Proposition automatique : après une première interaction et quelques secondes.
  var interagi = false, minuteur = null;
  function apresInteraction() {
    if (interagi) return; interagi = true;
    minuteur = setTimeout(function () { if (peutProposer()) ouvrir(); }, DELAI_AVANT_AFFICHAGE_MS);
  }
  document.addEventListener("pointerdown", apresInteraction, { once: true });
  document.addEventListener("keydown", apresInteraction, { once: true });
})();
