/* ============================================================
 * Tableau Virtuel — configuration publique
 * Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
 * Licence : CC BY-NC 4.0
 *
 * Ces deux valeurs sont PUBLIQUES par conception (comme dans les autres applis) :
 * la sécurité repose sur le compte propriétaire + la double authentification
 * + les règles de la base, pas sur le secret de cette clé.
 * Aucune clé secrète (service_role) ne doit jamais être mise ici.
 * ============================================================ */
var TV_CONFIG = {
  SUPABASE_URL: "https://idctzlupjkczmstdlyfn.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_AHqem_kIg_licGfKd8Y9Og__MNduLs3",
  VERSION: "1.0.0"
};
