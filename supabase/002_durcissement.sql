-- ============================================================
-- Tableau Virtuel — durcissement (après audit indépendant)
-- Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
-- Licence : CC BY-NC 4.0
--
--  1. Scellement du facteur TOTP du propriétaire : seul CE facteur donne accès,
--     et il doit rester le seul facteur vérifié (un facteur ajouté plus tard est refusé).
--  2. La session Supabase du téléphone doit exister encore (déconnexion = fin immédiate).
--  3. Limites anti-abus : adresse réelle (cf-connecting-ip), plafond par adresse,
--     compteur d’identifiant seulement après vérification du secret.
--  4. La liste des PC n’affiche plus les demandes non encore prises par le propriétaire.
-- Pour changer de téléphone/appli d’authentification (réinitialiser le scellement) :
--   update tableau_virtuel.owner set facteur_id = null;
-- ============================================================

alter table tableau_virtuel.owner    add column if not exists facteur_id uuid;
alter table tableau_virtuel.pairings add column if not exists ip text;
create index if not exists rate_fenetre on tableau_virtuel.rate (window_start);

-- Adresse réelle de l’appelant (en-tête de la passerelle), sinon dernier élément de x-forwarded-for.
create or replace function tableau_virtuel.ip_hash() returns text
language sql stable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(
           nullif(trim(t.h ->> 'cf-connecting-ip'), ''),
           nullif(trim((string_to_array(coalesce(t.h ->> 'x-forwarded-for', ''), ','))
                       [array_length(string_to_array(coalesce(t.h ->> 'x-forwarded-for', ''), ','), 1)]), ''),
           'inconnue') || ':tv1', 'utf8')), 'hex')
  from (select (nullif(current_setting('request.headers', true), ''))::json as h) t;
$$;

-- Propriétaire = bon compte + facteur scellé encore vérifié et seul + aal2 + session existante.
create or replace function tableau_virtuel.est_proprietaire() returns boolean
language sql stable set search_path = '' as $$
  select exists (
           select 1 from tableau_virtuel.owner o
            where o.id = auth.uid() and o.facteur_id is not null
              and exists (select 1 from auth.mfa_factors f
                           where f.id = o.facteur_id and f.user_id = o.id and f.status = 'verified')
              and (select count(*) from auth.mfa_factors f
                    where f.user_id = o.id and f.status = 'verified') = 1)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and exists (select 1 from auth.sessions s
                  where s.id = nullif(auth.jwt() ->> 'session_id', '')::uuid and s.user_id = auth.uid());
$$;
revoke all on function tableau_virtuel.est_proprietaire() from public, anon, authenticated;
revoke all on function tableau_virtuel.ip_hash() from public, anon, authenticated;

-- Scellement : à appeler une fois, juste après avoir validé son TOTP (aal2, un seul facteur vérifié).
create or replace function public.tv_sceller() returns json
language plpgsql security definer set search_path = '' as $$
declare v_f uuid[];
begin
  if not exists (select 1 from tableau_virtuel.owner where id = auth.uid())
     or coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'non_autorise' using errcode = '42501';
  end if;
  if exists (select 1 from tableau_virtuel.owner where id = auth.uid() and facteur_id is not null) then
    return json_build_object('scelle', true);
  end if;
  select array_agg(f.id) into v_f from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified';
  if coalesce(array_length(v_f, 1), 0) <> 1 then raise exception 'facteur_invalide'; end if;
  update tableau_virtuel.owner set facteur_id = v_f[1] where id = auth.uid() and facteur_id is null;
  return json_build_object('scelle', true);
end $$;

-- État du compte appelant (aucune erreur si ce n’est pas le propriétaire).
create or replace function public.tv_moi() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'proprietaire', exists (select 1 from tableau_virtuel.owner o where o.id = auth.uid()),
    'scelle', exists (select 1 from tableau_virtuel.owner o where o.id = auth.uid() and o.facteur_id is not null),
    'aal', coalesce(auth.jwt() ->> 'aal', ''),
    'actif', tableau_virtuel.est_proprietaire());
$$;

-- Demande de rattachement du PC : plafond par adresse (5) en plus du plafond global (20).
create or replace function public.tv_pair_start(p_pc_pub text, p_secret_hash text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := tableau_virtuel.ip_hash();
  v_id uuid;
  v_exp timestamptz := now() + interval '3 minutes';
begin
  if p_pc_pub is null or p_pc_pub !~ '^[A-Za-z0-9_-]{80,120}$'
     or p_secret_hash is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'donnees_invalides';
  end if;
  perform tableau_virtuel.limite('ip:' || v_ip || ':start', 600, 10);
  perform tableau_virtuel.limite('global:start', 60, 30);
  delete from tableau_virtuel.pairings where created_at < now() - interval '1 day';
  delete from tableau_virtuel.rate where window_start < now() - interval '2 hours';
  if (select count(*) from tableau_virtuel.pairings
        where ip = v_ip and status in ('pending','claimed') and expires_at > now()) >= 5
     or (select count(*) from tableau_virtuel.pairings
           where status in ('pending','claimed') and expires_at > now()) >= 20 then
    raise exception 'trop_de_demandes' using errcode = 'P0001';
  end if;
  insert into tableau_virtuel.pairings (secret_hash, pc_pub, expires_at, ip)
  values (p_secret_hash, p_pc_pub, v_exp, v_ip) returning id into v_id;
  return json_build_object('id', v_id, 'expires_at', v_exp);
end $$;

-- Pulsation du PC : le compteur par identifiant ne s’applique qu’après vérification du secret
-- (quelqu’un qui a seulement vu le QR code ne peut plus perturber le PC).
create or replace function public.tv_pc_poll(p_id uuid, p_secret text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  v_ip text := tableau_virtuel.ip_hash();
  v_row tableau_virtuel.pairings%rowtype;
begin
  perform tableau_virtuel.limite('ip:' || v_ip || ':poll', 60, 240);
  if p_id is null or p_secret is null or length(p_secret) not between 20 and 200 then
    return json_build_object('status', 'unknown');
  end if;
  select * into v_row from tableau_virtuel.pairings
   where id = p_id and secret_hash = encode(sha256(convert_to(p_secret, 'utf8')), 'hex');
  if not found then
    return json_build_object('status', 'unknown');
  end if;
  perform tableau_virtuel.limite('id:' || p_id::text, 60, 90);
  if (v_row.status in ('pending','claimed') and v_row.expires_at < now())
     or (v_row.status = 'approved' and v_row.max_until < now()) then
    update tableau_virtuel.pairings set status = 'expired' where id = v_row.id;
    v_row.status := 'expired';
  end if;
  if v_row.status = 'approved' then
    update tableau_virtuel.pairings set last_seen = now() where id = v_row.id;
  end if;
  return json_build_object(
    'status', v_row.status,
    'phone_pub', case when v_row.status in ('claimed','approved') then v_row.phone_pub end,
    'max_until', case when v_row.status = 'approved' then v_row.max_until end);
end $$;

-- Liste : seulement les rattachements pris par le propriétaire (claimed) ou approuvés.
create or replace function public.tv_list() returns json
language plpgsql stable security definer set search_path = '' as $$
begin
  if not tableau_virtuel.est_proprietaire() then raise exception 'non_autorise' using errcode = '42501'; end if;
  return coalesce((
    select json_agg(json_build_object('id', p.id, 'status', p.status, 'created_at', p.created_at,
             'approved_at', p.approved_at, 'last_seen', p.last_seen, 'max_until', p.max_until)
           order by p.created_at desc)
      from tableau_virtuel.pairings p
     where (p.status = 'approved' and p.max_until > now())
        or (p.status = 'claimed' and p.expires_at > now())
  ), '[]'::json);
end $$;

revoke all on function public.tv_sceller() from public, anon, authenticated;
revoke all on function public.tv_moi() from public, anon, authenticated;
revoke all on function public.tv_pair_start(text,text) from public, anon, authenticated;
revoke all on function public.tv_pc_poll(uuid,text) from public, anon, authenticated;
revoke all on function public.tv_list() from public, anon, authenticated;
grant execute on function public.tv_sceller() to authenticated;
grant execute on function public.tv_moi() to authenticated;
grant execute on function public.tv_pair_start(text,text) to anon, authenticated;
grant execute on function public.tv_pc_poll(uuid,text) to anon, authenticated;
grant execute on function public.tv_list() to authenticated;
