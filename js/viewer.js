/* ============================================================
 * Tableau Virtuel — relais du cadre isolé (viewer.html)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Reçoit du PC : { type:"html", html:"..." } puis { type:"relais", m:{...} }.
 * Place la page locale dans un second iframe isolé et lui transmet
 * seulement les commandes « defiler » et « message ».
 * ============================================================ */
(function () {
  "use strict";
  var dedans = document.getElementById("dedans");
  dedans.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:#fff";

  // Petit script ajouté à la page locale : défilement et saisie de texte demandés par le téléphone.
  var AIDE = "<scr" + "ipt>addEventListener('message',function(e){var m=e.data||{};" +
    "if(m.t==='defiler'&&typeof m.dy==='number'){scrollBy(0,m.dy);}" +
    "if(m.t==='message'&&typeof m.v==='string'){var a=document.activeElement;" +
    "if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA')){a.value=m.v;a.dispatchEvent(new Event('input',{bubbles:true}));}}});</scr" + "ipt>";

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;          // seul le parent (la page de projection) est écouté
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "html" && typeof d.html === "string" && d.html.length < 8000000) {
      dedans.srcdoc = d.html + AIDE;
    } else if (d.type === "relais" && d.m && dedans.contentWindow) {
      dedans.contentWindow.postMessage(d.m, "*");
    }
  });
})();
