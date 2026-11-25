-- ============================================================
-- Tableau Virtuel — zone Supabase privée (schéma tableau_virtuel)
-- Auteur : Tom Rougeaud · réalisé avec l’aide de l’IA : Claude Sonnet 5.5
-- Licence : CC BY-NC 4.0
--
-- Principe : les tables sont dans un schéma NON exposé par l’API,
-- sans aucune politique RLS (accès direct interdit). Tout passe par
-- des fonctions « tv_* » (SECURITY DEFINER) qui vérifient :
--   - pour le téléphone : compte propriétaire + double authentification (aal2) ;
--   - pour le PC (sans compte) : un secret aléatoire propre à chaque demande,
--     plus des limites de débit.
-- Ce script ne modifie AUCUNE table ni politique existante (config, resources, etc.).
-- ============================================================

create schema if not exists tableau_virtuel;
revoke all on schema tableau_virtuel from public, anon, authenticated;

-- ---------- Propriétaire unique ----------
create table if not exists tableau_virtuel.owner (
  id         uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists owner_unique on tableau_virtuel.owner ((true)); -- une seule ligne
alter table tableau_virtuel.owner enable row level security;
revoke all on tableau_virtuel.owner from public, anon, authenticated;

-- Le propriétaire est l’unique compte existant ; sinon on s’arrête (pas de choix au hasard).
do $$
begin
  if (select count(*) from auth.users) <> 1 then
    raise exception 'Il faut exactement un compte : désigner le propriétaire à la main.';
  end if;
  insert into tableau_virtuel.owner(id) select id from auth.users on conflict do nothing;
end $$;

-- ---------- Rattachements PC <-> téléphone ----------
create table if not exists tableau_virtuel.pairings (
  id          uuid primary key default gen_random_uuid(),
  secret_hash text not null,                 -- empreinte du secret du PC (le secret n’est jamais stocké)
  pc_pub      text not null,                 -- clé publique ECDH du PC
  phone_pub   text,                          -- clé publique ECDH du téléphone
  status      text not null default 'pending'
              check (status in ('pending','claimed','approved','revoked','expired')),
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  approved_at timestamptz,
  expires_at  timestamptz not null,          -- limite pour finir le rattachement
  max_until   timestamptz,                   -- fin maximale de la session approuvée
  last_seen   timestamptz
);
alter table tableau_virtuel.pairings enable row level security;
revoke all on tableau_virtuel.pairings from public, anon, authenticated;

-- ---------- Compteurs de limitation de débit ----------
create table if not exists tableau_virtuel.rate (
  bucket       text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (bucket, window_start)
);
alter table tableau_virtuel.rate enable row level security;
revoke all on tableau_virtuel.rate from public, anon, authenticated;

-- ---------- Fonctions internes ----------
-- Vrai seulement pour le propriétaire connecté avec double authentification.
create or replace function tableau_virtuel.est_proprietaire() returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from tableau_virtuel.owner o where o.id = auth.uid())
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

-- Empreinte (salée) de l’adresse IP de l’appelant.
create or replace function tableau_virtuel.ip_hash() returns text
language sql stable set search_path = '' as $$
  select encode(sha256(convert_to(
    coalesce(nullif(trim(split_part(coalesce(
      (nullif(current_setting('request.headers', true), ''))::json ->> 'x-forwarded-for', ''), ',', 1)), ''), 'inconnue')
    || ':tv1', 'utf8')), 'hex');
$$;

-- Compte un appel ; refuse si le plafond de la fenêtre est dépassé.
create or replace function tableau_virtuel.limite(p_bucket text, p_fenetre int, p_max int) returns void
language plpgsql set search_path = '' as $$
declare
  v_debut timestamptz := to_timestamp(floor(extract(epoch from now()) / p_fenetre) * p_fenetre);
  v_n int;
begin
  insert into tableau_virtuel.rate as r (bucket, window_start, hits)
  values (p_bucket, v_debut, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning r.hits into v_n;
  if v_n > p_max then
    raise exception 'trop_de_demandes' using errcode = 'P0001';
  end if;
end $$;

revoke all on function tableau_virtuel.est_proprietaire() from public, anon, authenticated;
revoke all on function tableau_virtuel.ip_hash()          from public, anon, authenticated;
revoke all on function tableau_virtuel.limite(text,int,int) from public, anon, authenticated;

-- ---------- Fonctions du PC (sans compte) ----------
-- Le PC crée une demande de rattachement.
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

-- Le PC demande l’état de sa demande (sert aussi de pulsation).
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
  perform tableau_virtuel.limite('id:' || p_id::text, 60, 90);
  select * into v_row from tableau_virtuel.pairings
   where id = p_id
     and secret_hash = encode(sha256(convert_to(p_secret, 'utf8')), 'hex');
  if not found then
    return json_build_object('status', 'unknown');   -- même réponse si l’identifiant ou le secret est faux
  end if;
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
    'max_until', case when v_row.status = 'approved' then v_row.max_until end
  );
end $$;

-- ---------- Fonctions du téléphone (propriétaire + aal2) ----------
-- Le téléphone indique s’il est bien propriétaire (aucune erreur si non).
create or replace function public.tv_moi() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'proprietaire', exists (select 1 from tableau_virtuel.owner o where o.id = auth.uid()),
    'aal', coalesce(auth.jwt() ->> 'aal', ''));
$$;

-- Le téléphone s’attache à la demande lue dans le QR code.
create or replace function public.tv_pair_claim(p_id uuid, p_phone_pub text) returns json
language plpgsql security definer set search_path = '' as $$
declare v_pc text;
begin
  if not tableau_virtuel.est_proprietaire() then raise exception 'non_autorise' using errcode = '42501'; end if;
  perform tableau_virtuel.limite('owner:claim', 60, 20);
  if p_phone_pub is null or p_phone_pub !~ '^[A-Za-z0-9_-]{80,120}$' then raise exception 'donnees_invalides'; end if;
  update tableau_virtuel.pairings
     set phone_pub = p_phone_pub, status = 'claimed', claimed_at = now(),
         expires_at = now() + interval '3 minutes'
   where id = p_id and status = 'pending' and expires_at > now()
   returning pc_pub into v_pc;
  if v_pc is null then raise exception 'introuvable_ou_expire'; end if;
  return json_build_object('pc_pub', v_pc);
end $$;

-- Tom a comparé le code de contrôle : il approuve (durée limitée, 12 h au plus).
create or replace function public.tv_pair_approve(p_id uuid, p_minutes int default 480) returns json
language plpgsql security definer set search_path = '' as $$
declare v_fin timestamptz;
begin
  if not tableau_virtuel.est_proprietaire() then raise exception 'non_autorise' using errcode = '42501'; end if;
  perform tableau_virtuel.limite('owner:approve', 60, 20);
  v_fin := now() + make_interval(mins => greatest(15, least(coalesce(p_minutes, 480), 720)));
  update tableau_virtuel.pairings
     set status = 'approved', approved_at = now(), max_until = v_fin, last_seen = now()
   where id = p_id and status = 'claimed' and expires_at > now();
  if not found then raise exception 'introuvable_ou_expire'; end if;
  return json_build_object('max_until', v_fin);
end $$;

-- Révoquer un PC.
create or replace function public.tv_pair_revoke(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not tableau_virtuel.est_proprietaire() then raise exception 'non_autorise' using errcode = '42501'; end if;
  update tableau_virtuel.pairings set status = 'revoked'
   where id = p_id and status in ('pending','claimed','approved');
end $$;

-- Tout révoquer.
create or replace function public.tv_revoke_all() returns int
language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if not tableau_virtuel.est_proprietaire() then raise exception 'non_autorise' using errcode = '42501'; end if;
  update tableau_virtuel.pairings set status = 'revoked'
   where status in ('pending','claimed','approved');
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Liste des PC rattachés ou en cours de rattachement.
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
        or (p.status in ('pending','claimed') and p.expires_at > now())
  ), '[]'::json);
end $$;

-- ---------- Droits d’exécution ----------
revoke all on function public.tv_pair_start(text,text)      from public, anon, authenticated;
revoke all on function public.tv_pc_poll(uuid,text)         from public, anon, authenticated;
revoke all on function public.tv_moi()                      from public, anon, authenticated;
revoke all on function public.tv_pair_claim(uuid,text)      from public, anon, authenticated;
revoke all on function public.tv_pair_approve(uuid,int)     from public, anon, authenticated;
revoke all on function public.tv_pair_revoke(uuid)          from public, anon, authenticated;
revoke all on function public.tv_revoke_all()               from public, anon, authenticated;
revoke all on function public.tv_list()                     from public, anon, authenticated;

grant execute on function public.tv_pair_start(text,text)   to anon, authenticated;
grant execute on function public.tv_pc_poll(uuid,text)      to anon, authenticated;
grant execute on function public.tv_moi()                   to authenticated;
grant execute on function public.tv_pair_claim(uuid,text)   to authenticated;
grant execute on function public.tv_pair_approve(uuid,int)  to authenticated;
grant execute on function public.tv_pair_revoke(uuid)       to authenticated;
grant execute on function public.tv_revoke_all()            to authenticated;
grant execute on function public.tv_list()                  to authenticated;
