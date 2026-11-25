# Tableau Virtuel

Présenter des contenus sur un ordinateur (au vidéoprojecteur) en le pilotant depuis son téléphone, même sur un autre réseau.
Espace **privé**, à propriétaire unique : le QR code et le code de contrôle ne suffisent jamais à prendre le contrôle.

Conçu par Tom Rougeaud · réalisé avec l’aide de l’IA (Claude Sonnet 5.5) · Licence CC BY-NC 4.0.

## Pages
- `projection.html` : à ouvrir sur l’ordinateur (aucun compte). Affiche le QR code, puis les contenus.
- `index.html` : sur le téléphone (installable). Connexion, double authentification, télécommande.
- `a-propos.html`, `confidentialite.html`.

## Fonctionnement en bref
1. Le PC crée une demande de rattachement (secret propre au PC, QR code public).
2. Le téléphone du propriétaire (connecté + double authentification, vérifié par la base) scanne et s’attache.
3. Les deux affichent le même code de contrôle à 4 chiffres ; le propriétaire approuve sur le téléphone.
4. Les commandes passent chiffrées de bout en bout (ECDH P-256, AES-256-GCM) par Supabase Realtime.
5. Le PC vérifie toutes les 4 s que la session est toujours approuvée (révocation, expiration, durée maximale 12 h).

Version 1.1 : télécommande en paysage (aperçu de l’écran + laser en croix rouge, clic gauche/droit, saisie de texte), onglets ouverts (PC et téléphone, fermeture), favoris (liens et fichiers) sur le téléphone, ouverture de sites (YouTube converti en lecteur intégré, sites refusant le cadre : fenêtre ou partage d’onglet), mise à jour automatique (24 h), à la demande ou forcée.
Pour publier : changer le numéro de version dans `sw.js`, `js/maj.js` et `a-propos.html`.

Détails et choix de sécurité : `CAHIER_DES_CHARGES.md`. Base de données : `supabase/001_tableau_virtuel.sql`.

## Mise en place
1. Exécuter `supabase/001_tableau_virtuel.sql` (schéma séparé `tableau_virtuel`, ne modifie aucune table existante).
2. Supabase : fermer les inscriptions, activer TOTP, vérifier que Realtime autorise l’accès public aux canaux Broadcast.
3. Renseigner `js/config.js` (adresse du projet et clé **publique** uniquement).
4. Publier avec GitHub Pages.

À chaque mise à jour : changer `VERSION` dans `sw.js`.

## Bibliothèques copiées dans `js/lib/`
supabase-js (MIT), pdf.js 3.11 (Apache 2.0), qrcode-generator (MIT), jsQR 1.4.0 (Apache 2.0, lecture du QR code). Aucun CDN, aucun traceur.
