/* ============================================================
 * Tableau Virtuel — sites proposés en favoris (données, séparées du moteur)
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * « complet » : le site est sur le même domaine que cette appli → clic, saisie et défilement à distance.
 * Sans « complet » : laser seulement. Groupes établis par des essais réels (25/11/2026) : les sites du dernier
 * groupe ont affiché une page blanche dans le cadre → fenêtre séparée ou partage d’onglet.
 * Pour ajouter un site : une ligne { nom, url } dans le bon groupe.
 * ============================================================ */
window.TV_SUGGESTIONS = {
  version: 1,
  // Ajoutés automatiquement au premier lancement (liste vide seulement).
  parDefaut: [
    "https://tom-rougeaud.github.io/casier/", "https://tom-rougeaud.github.io/3eme/",
    "https://tom-rougeaud.github.io/mcv/2de/", "https://tom-rougeaud.github.io/tradmaths/",
    "https://tom-rougeaud.github.io/fls/", "https://tom-rougeaud.github.io/ball/",
    "https://www.youtube.com/"
  ],
  groupes: [
    { titre: "Mes applis (pilotage complet)", complet: true, sites: [
      { nom: "Casier pédagogique", url: "https://tom-rougeaud.github.io/casier/" },
      { nom: "Manuel de maths 3ème Prépa-Métiers", url: "https://tom-rougeaud.github.io/3eme/" },
      { nom: "Manuel de maths 2nde MRCU", url: "https://tom-rougeaud.github.io/mcv/2de/" },
      { nom: "Manuel de maths 1ère MCV", url: "https://tom-rougeaud.github.io/mcv/1ere/" },
      { nom: "Manuel de maths Terminale MCV", url: "https://tom-rougeaud.github.io/mcv/terminale/" },
      { nom: "Manuel de maths CAP", url: "https://tom-rougeaud.github.io/cap/" },
      { nom: "TradMaths", url: "https://tom-rougeaud.github.io/tradmaths/" },
      { nom: "Maths Allophones niveau 1", url: "https://tom-rougeaud.github.io/fls/" },
      { nom: "Maths Allophones niveau 2", url: "https://tom-rougeaud.github.io/fls2/" },
      { nom: "Maths Allophones niveau 3", url: "https://tom-rougeaud.github.io/fls3/" },
      { nom: "Flash Maths", url: "https://tom-rougeaud.github.io/flashmaths/" },
      { nom: "Automatismes", url: "https://tom-rougeaud.github.io/automatismes/" },
      { nom: "Chrono séance", url: "https://tom-rougeaud.github.io/chrono/" },
      { nom: "Ma séance de maths", url: "https://tom-rougeaud.github.io/maseance/" },
      { nom: "Maths MLDS", url: "https://tom-rougeaud.github.io/mlds/" },
      { nom: "Lecture+", url: "https://tom-rougeaud.github.io/lecture/" },
      { nom: "Abel’s Run", url: "https://tom-rougeaud.github.io/ball/" },
      { nom: "Maths Snake", url: "https://tom-rougeaud.github.io/maths-snake/" },
      { nom: "Lore Master", url: "https://tom-rougeaud.github.io/loremaster/" }
    ] },
    { titre: "S’affichent dans la page (laser seulement)", complet: false, sites: [
      { nom: "Wikipédia", url: "https://fr.wikipedia.org/" },
      { nom: "GeoGebra", url: "https://www.geogebra.org/classic" },
      { nom: "Desmos (calculatrice scientifique)", url: "https://www.desmos.com/scientific" },
      { nom: "Pix", url: "https://pix.fr/" }
    ] },
    { titre: "Refusent l’affichage : fenêtre ou partage d’onglet", complet: false, sites: [
      { nom: "YouTube (adresse d’une vidéo : lecteur pilotable)", url: "https://www.youtube.com/" },
      { nom: "Google", url: "https://www.google.com/" },
      { nom: "Lumni", url: "https://www.lumni.fr/" },
      { nom: "Vikidia (pour les jeunes)", url: "https://fr.vikidia.org/" },
      { nom: "Éduscol", url: "https://eduscol.education.fr/" },
      { nom: "Scratch", url: "https://scratch.mit.edu/" },
      { nom: "Gallica (BnF)", url: "https://gallica.bnf.fr/" }
    ] }
  ]
};
