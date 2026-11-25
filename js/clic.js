/* ============================================================
 * Tableau Virtuel — clic, saisie et touche « à distance » dans une page
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Ces fonctions agissent dans UNE fenêtre w dont le script est accessible :
 * une page HTML locale (cadre isolé) ou une page du même site.
 * Un site tiers l’interdit : aucun navigateur ne laisse un site cliquer dans un autre.
 * Chaque fonction est autonome (sans variable extérieure) : viewer.js peut donc
 * en copier le texte dans la page affichée.
 * ============================================================ */
(function (g) {
  "use strict";

  // Clic (b = "g" gauche, "d" droit) à la position relative x, y (0 à 1) de la fenêtre w.
  // Renvoie { champ: vrai si un champ de texte est actif, val: son contenu }.
  function cliquerDans(w, x, y, b) {
    var d = w.document, px = Math.round(x * w.innerWidth), py = Math.round(y * w.innerHeight);
    var el = d.elementFromPoint(px, py);
    if (!el) return { champ: false, val: "" };
    var droit = b === "d";
    var opts = { bubbles: true, cancelable: true, view: w, clientX: px, clientY: py, button: droit ? 2 : 0, buttons: droit ? 2 : 1 };
    var champ = el.closest ? el.closest("input,textarea,[contenteditable]") : null;
    var type = champ && champ.tagName === "INPUT" ? String(champ.type || "text").toLowerCase() : "";
    var saisissable = !!champ && (champ.tagName === "TEXTAREA" || champ.isContentEditable ||
      ["text", "search", "url", "email", "tel", "password", "number", ""].indexOf(type) >= 0);
    if (!droit && champ && champ.focus) champ.focus();
    var types = droit ? ["mousedown", "mouseup", "contextmenu"] : ["mousedown", "mouseup", "click"];
    for (var i = 0; i < types.length; i++) el.dispatchEvent(new w.MouseEvent(types[i], opts));
    return { champ: saisissable, val: saisissable ? String(champ.value !== undefined ? champ.value : champ.textContent).slice(0, 500) : "" };
  }

  // Remplace le contenu du champ actif par v (et prévient la page, comme une vraie frappe).
  function ecrireDans(w, v) {
    var el = w.document.activeElement;
    if (!el) return false;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      var proto = el.tagName === "INPUT" ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
      el.dispatchEvent(new w.Event("input", { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) { el.textContent = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); return true; }
    return false;
  }

  // Touche Entrée dans le champ actif (valide le formulaire s’il y en a un).
  function toucherDans(w, k) {
    var el = w.document.activeElement;
    if (!el || k !== "Entree") return;
    if (el.form && el.form.requestSubmit) { el.form.requestSubmit(); return; }
    var ts = ["keydown", "keypress", "keyup"];
    for (var i = 0; i < ts.length; i++) {
      el.dispatchEvent(new w.KeyboardEvent(ts[i], { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    }
  }

  g.TVClic = { cliquerDans: cliquerDans, ecrireDans: ecrireDans, toucherDans: toucherDans };
})(self);
