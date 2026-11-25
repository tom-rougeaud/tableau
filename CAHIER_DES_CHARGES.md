# Tableau Virtuel — cahier des charges consolidé (v1)

Auteur : Tom Rougeaud · Audit, arbitrages et rédaction : Claude Sonnet 5.5
Licence : CC BY-NC 4.0

## 1. But
Un PC du lycée (navigateur seulement) affiche des contenus au vidéoprojecteur.
Le smartphone de Tom sert de télécommande, même sur un autre réseau.
L’appli est un **espace privé à propriétaire unique**. Ce n’est pas une télécommande publique.

## 2. Règle de sécurité centrale
Le QR code et le code court **ne donnent jamais le contrôle**.
Ils servent seulement à **rattacher un appareil déjà authentifié et autorisé** (le téléphone du propriétaire).

Conditions pour piloter, toutes obligatoires :
1. Le téléphone est connecté au compte propriétaire (Supabase Auth).
2. Le téléphone a passé la double authentification TOTP (niveau `aal2`).
3. Le compte est bien le propriétaire enregistré dans `tableau_virtuel.owner`.
4. Tom saisit sur le téléphone le code de contrôle (4 chiffres) affiché sur le PC ; il doit être identique à celui calculé par le téléphone.
5. La session n’est ni révoquée ni expirée.

## 3. Audit : failles du cahier d’origine et corrections
| Risque | Correction retenue |
|---|---|
| Code PIN ou QR suffisant pour piloter | Interdit. Rattachement réservé au propriétaire `aal2` (RPC côté base). |
| Quelqu’un voit le QR projeté et le scanne | Il n’est pas propriétaire : refus. Le QR expire en 3 minutes et ne sert qu’une fois. |
| Écoute ou usurpation sur le canal temps réel | Chiffrement de bout en bout (ECDH P-256, HKDF, AES-256-GCM). Salon temps réel au nom secret dérivé de la clé partagée. Compteur anti-rejeu. |
| Attaque de l’intercepteur au rattachement | Code de contrôle (SAS) lu sur le PC et saisi sur le téléphone (3 erreurs = annulation). |
| PC oublié ouvert | Durée maximale (8 h par défaut, 12 h au plus), pulsation du PC, « Tout révoquer » depuis le téléphone. |
| Messages piégés vers le PC | Liste blanche stricte des commandes, validation des types et des bornes, limitation de débit. |
| Abus des fonctions anonymes (le PC n’a pas de compte) | Limitation de débit par adresse et globale, plafond de demandes en attente, purge automatique. |
| Autre compte créé dans le projet = droits d’administration du casier | Aucun compte satellite. Aucune politique existante modifiée. **Inscriptions à fermer (action de Tom).** |
| Double authentification non activée | Les RPC refusent tout appel sans `aal2` : sans TOTP, pas de pilotage. |
| Clés ou données personnelles dans le dépôt | Seule la clé publique (publishable) est dans `config.js`, comme `seance` et `casier`. Aucune adresse, aucun identifiant. |
| CDN, polices distantes, traceurs | Aucun. Bibliothèques copiées dans le dépôt. CSP stricte. |

## 4. Arbitrages
- **Niveau de contrôle A** : contenus dans l’appli uniquement (pas de contrôle du système du PC).
- **Relais** : Supabase Realtime Broadcast + RPC. Pas de fonction Edge, pas de serveur à Tom.
- **Connexion** : comme ses autres applis Supabase, avec TOTP en plus.
- **Hébergement** : GitHub Pages, dépôt `tableau`.
- **Polices** : Coolvetica uniquement dans le logo (tracés SVG). Texte de l’interface en polices système.
- **Repli sans WebSocket** (réseau scolaire qui bloque) : prévu au palier 4, via messages chiffrés en base.

## 5. Fonctions (palier 1 à 3)
**PC (`projection.html`, sans compte)**
- Affiche un QR et un code de contrôle. Attend le rattachement.
- Affiche : image, PDF (pdf.js local), vidéo, page HTML locale en iframe isolé, lien web, pointeur laser virtuel, texte tapé depuis le téléphone.
- Écran noir si révoqué ou expiré.

**Téléphone (`index.html`, installable)**
- Connexion + enrôlement TOTP.
- Scanner/saisir le rattachement, comparer le code de contrôle, confirmer.
- Télécommande : page suivante/précédente, zoom, lecture/pause, pointeur laser, saisie de texte, écran noir.
- Liste des PC rattachés, révocation d’un PC ou de tous.

**Transverse** : pages « À propos » et « Confidentialité », export/import/effacer des réglages, installation PWA (pop-up + iPhone), accessibilité, aucune autocomplétion (sauf connexion).

## 6. Limites connues
- Le temps réel n’a pas pu être testé depuis l’environnement de construction : à vérifier sur appareils réels.
- Les sites web qui interdisent l’affichage en iframe s’ouvrent dans une nouvelle fenêtre, sans pointeur.
- Safari iPhone : installation manuelle (Partager → Sur l’écran d’accueil).

## 7. Actions de Tom dans Supabase
1. Fermer les inscriptions (Authentication → Sign In / Providers → désactiver « Allow new users to sign up »).
2. Activer TOTP (Authentication → Multi-Factor → TOTP).
3. Vérifier Realtime : « Allow public access » activé (Realtime → Settings).
4. Activer GitHub Pages sur le dépôt `tableau`.

## 8. Audit indépendant : suites
Aucun point bloquant. Corrigé côté appli : fermeture locale du PC à l’échéance, erreurs comptées, dérivation des clés même si la fenêtre « claimed » est manquée, anti-cadrage, durée par défaut 4 h, code saisi plutôt que comparé.
Corrigé côté base (`supabase/002_durcissement.sql`) : scellement du facteur TOTP, session obligatoire, adresse réelle de l’appelant, plafond par adresse, compteur par identifiant après vérification du secret.
Limites assumées :
- Origine GitHub Pages partagée avec tes autres applis (jeton de connexion lisible par une faille XSS dans l’une d’elles) : un domaine dédié règlerait le point.
- Pas de fenêtre de fraîcheur des messages (horloges PC/téléphone parfois décalées).
- pdf.js 3.11 : l’option `isEvalSupported: false` (activée) est le contournement officiel de CVE-2024-4367 ; passer à pdf.js 4.x plus tard.
- La commande « ouvrir un site » accepte toute adresse https (seul le propriétaire peut l’envoyer).

## 9. Version 1.1 (25/11/2026)
- Protocole : commandes `clic`, `texte`, `touche`, `fermer`, `toutFermer`, `apercu`, `url`, transfert de fichiers par blocs ; état enrichi (origine PC/téléphone, champ de saisie actif, clic possible).
- Laser : croix rouge ; clic gauche/droit (boutons ou appui bref), saisie de texte dans les champs.
- Limites assumées : pas de clic, saisie ni défilement dans un site extérieur (règle du navigateur) ; pas de liste des onglets réels ; sites refusant le cadre → fenêtre ou partage d’onglet.
- `allow-same-origin` sur les sites ouverts en cadre (corrige l’erreur LockManager du casier) ; les pages HTML locales gardent un cadre sans cette permission.
- Mises à jour : service worker réseau d’abord, activation immédiate ; recherche toutes les 24 h, à la demande, ou forcée (cache vidé).
- Non testé : vrais appareils, Realtime réel, partage d’écran (getDisplayMedia), iPhone, clavier du téléphone, gros fichiers.

## 10. Version 1.2 (25/11/2026)
- Télécommande en paysage par défaut (affichage pivoté si le téléphone est tenu en portrait ; bouton « Portrait » dans Options) ; laser en mode « souris » par défaut (déplacement relatif, gain 2,2).
- Aller à la page : champ sur le PC et sur le téléphone, commande `page` (PDF de plusieurs pages).
- YouTube intégré pilotable (lecture, pause, ±10 s) par l’API officielle du lecteur.
- Favoris de départ ajoutés une fois (casier, manuels, TradMaths, Allophones 1, Abel’s Run, YouTube) + suggestions interactives (données dans `js/suggestions.js`).
- Limite de fond : un site extérieur ne peut être ni cliqué, ni saisi, ni défilé à distance depuis une page web (règle du navigateur). Seuls les sites du même domaine (apps de Tom) et les pages HTML locales sont pilotables à 100 %. Pistes si besoin : proxy de réécriture (serveur à héberger, risque de sécurité) ou bureau à distance.

## 11. Version 1.3 (25/11/2026)
- Lecteur de QR code intégré au téléphone (bouton « Scanner le QR code ») : BarcodeDetector si disponible, sinon jsQR ; caméra coupée à la réussite, à l’annulation et en arrière-plan ; repli : coller le lien affiché sous le QR code sur le PC. Seul le format `#p=<uuid>.<clé publique>` est accepté.
- Session fantôme corrigée : à la réouverture, le téléphone ne rouvre la télécommande que si le PC a donné signe de vie (battement `last_seen` < 45 s) et répond sous 12 s ; sinon la session est révoquée et un nouveau rattachement est proposé.
