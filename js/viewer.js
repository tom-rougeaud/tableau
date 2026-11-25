/* ============================================================
 * Tableau Virtuel — relais du cadre isolé (viewer.html)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Reçoit du PC : { type:"html", html:"..." } puis { type:"relais", m:{...} }.
 * Place la page locale dans un second iframe isolé et lui transmet
 * seulement : defiler, clic, texte, touche. La page répond « champ » (un champ
 * de texte est actif ou non), relayé au PC.
 * ============================================================ */
(function () {
  "use strict";
  var dedans = document.getElementById("dedans");
  dedans.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff";

  // Script ajouté à la page locale : il copie les 3 fonctions de clic.js puis écoute le PC.
  var AIDE = "<scr" + "ipt>(function(){" +
    [TVClic.cliquerDans, TVClic.ecrireDans, TVClic.toucherDans].map(function (f) { return f.toString(); }).join(";") +
    ";addEventListener('message',function(e){var m=e.data||{};try{" +
    "if(m.t==='defiler'&&typeof m.dy==='number'){scrollBy(0,m.dy);}" +
    "if(m.t==='clic'){var r=cliquerDans(window,m.x,m.y,m.b);parent.postMessage({t:'champ',champ:r.champ,val:r.val},'*');}" +
    "if(m.t==='texte'&&typeof m.v==='string'){ecrireDans(window,m.v);}" +
    "if(m.t==='touche'){toucherDans(window,m.k);}" +
    "}catch(x){}});})();</scr" + "ipt>";

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    // Réponse de la page affichée -> PC
    if (e.source === dedans.contentWindow) {
      if (d.t === "champ") window.parent.postMessage({ t: "champ", champ: d.champ === true, val: String(d.val || "").slice(0, 500) }, "*");
      return;
    }
    if (e.source !== window.parent) return;          // seul le PC (page de projection) est écouté
    if (d.type === "html" && typeof d.html === "string" && d.html.length < 8000000) {
      dedans.srcdoc = d.html + AIDE;
    } else if (d.type === "relais" && d.m && dedans.contentWindow) {
      dedans.contentWindow.postMessage(d.m, "*");
    }
  });
})();
