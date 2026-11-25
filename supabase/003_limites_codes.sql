-- ============================================================
-- Tableau Virtuel — 003 : limites plus souples pour les nouveaux codes
-- Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
-- Changements : code de rattachement valable 5 minutes (au lieu de 3) ;
--               30 demandes par 10 minutes et par réseau (au lieu de 10),
--               car un réseau d’établissement est partagé. Limite globale inchangée (30 par minute).
-- ============================================================
create or replace function public.tv_pair_start(p_pc_pub text, p_secret_hash text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := tableau_virtuel.ip_hash();
  v_id uuid;
  v_exp timestamptz := now() + interval '5 minutes';
begin
  if p_pc_pub is null or p_pc_pub !~ '^[A-Za-z0-9_-]{80,120}$'
     or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'donnees_invalides';
  end if;
  perform tableau_virtuel.limite('ip:' || v_ip || ':start', 600, 30);
  perform tableau_virtuel.limite('global:start', 60, 30);
  -- Nettoyage : vieilles demandes et vieux compteurs.
  delete from tableau_virtuel.pairings where created_at < now() - interval '1 day';
  delete from tableau_virtuel.rate where window_start < now() - interval '2 hours';
  if (select count(*) from tableau_virtuel.pairings
        where status in ('pending','claimed') and expires_at > now()) >= 20 then
    raise exception 'trop_de_demandes' using errcode = 'P0001';
  end if;
  insert into tableau_virtuel.pairings (secret_hash, pc_pub, expires_at)
  values (p_secret_hash, p_pc_pub, v_exp) returning id into v_id;
  return json_build_object('id', v_id, 'expires_at', v_exp);
end $$;
