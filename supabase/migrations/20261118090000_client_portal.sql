-- ---------------------------------------------------------------------------
-- Portail client (V1)
--
-- Le client d'un cabinet dépose ses factures et relevés dans son espace.
-- Les fichiers arrivent dans dossier_documents, exactement comme un import du
-- cabinet : ils apparaissent dans « factures prêtes à extraire » et c'est le
-- comptable qui lance l'extraction (aucun crédit IA consommé au dépôt).
--
-- Accès sans mot de passe : un lien personnel (jeton aléatoire, seul son
-- empreinte SHA-256 est stockée) échangé contre une session par l'Edge
-- Function client-portal. Le compte portail n'est membre d'aucun cabinet :
-- toutes les règles existantes lui refusent l'accès ; les règles ci-dessous
-- n'ouvrent que son propre client, ses périodes, ses demandes et ses dépôts.
-- ---------------------------------------------------------------------------

-- Accès portail : un par client
create table if not exists public.client_portal_access (
  client_id bigint primary key references public.cabinet_clients (id) on delete cascade,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  user_id uuid not null unique references auth.users (id) on delete cascade,
  token_hash text,
  contact_name text,
  contact_phone text,
  contact_email text,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  link_created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists client_portal_access_cabinet_idx on public.client_portal_access (cabinet_id);
create unique index if not exists client_portal_access_token_idx on public.client_portal_access (token_hash) where token_hash is not null;

-- Pièces demandées au client, par période
create table if not exists public.document_requests (
  id bigint generated always as identity primary key,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  dossier_id bigint not null references public.client_dossiers (id) on delete cascade,
  doc_type text not null default 'invoice' check (doc_type in ('invoice', 'bank', 'other')),
  label text not null check (length(trim(label)) > 0),
  note text,
  status text not null default 'open' check (status in ('open', 'received', 'closed')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  received_at timestamptz,
  closed_at timestamptz
);
create index if not exists document_requests_client_idx on public.document_requests (client_id, status);
create index if not exists document_requests_dossier_idx on public.document_requests (dossier_id);

-- Dépôts faits par le client (suivi : reçu / à renvoyer)
create table if not exists public.portal_uploads (
  id bigint generated always as identity primary key,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  dossier_id bigint not null references public.client_dossiers (id) on delete cascade,
  document_id bigint references public.dossier_documents (id) on delete set null,
  request_id bigint references public.document_requests (id) on delete set null,
  doc_type text not null check (doc_type in ('invoice', 'bank', 'other')),
  original_filename text not null,
  storage_path text not null,
  mime_type text,
  size_bytes bigint,
  status text not null default 'received' check (status in ('received', 'rejected')),
  reject_reason text,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  reviewed_at timestamptz
);
create index if not exists portal_uploads_client_idx on public.portal_uploads (client_id, created_at desc);
create index if not exists portal_uploads_dossier_idx on public.portal_uploads (dossier_id);
create index if not exists portal_uploads_unseen_idx on public.portal_uploads (cabinet_id) where seen_at is null;

-- ---------------------------------------------------------------------------
-- Aides
-- ---------------------------------------------------------------------------

create or replace function private.portal_client_id()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select a.client_id
  from public.client_portal_access a
  join public.cabinet_clients c on c.id = a.client_id
  join public.cabinets cab on cab.id = c.cabinet_id
  where a.user_id = (select auth.uid()) and a.is_active and cab.is_active
  limit 1;
$$;
revoke all on function private.portal_client_id() from public, anon;
grant execute on function private.portal_client_id() to authenticated;

create or replace function private.portal_can_upload_to(p_dossier_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.client_dossiers d
    where d.id = p_dossier_id and d.client_id = (select private.portal_client_id())
  );
$$;
revoke all on function private.portal_can_upload_to(bigint) from public, anon;
grant execute on function private.portal_can_upload_to(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS : lecture de son propre espace pour le client
-- ---------------------------------------------------------------------------

alter table public.client_portal_access enable row level security;
alter table public.document_requests enable row level security;
alter table public.portal_uploads enable row level security;

-- Accès : le client voit sa ligne ; le cabinet voit celles de ses clients. Écritures : Edge Function.
drop policy if exists portal_access_select on public.client_portal_access;
create policy portal_access_select on public.client_portal_access for select to authenticated
  using (user_id = (select auth.uid()) or client_id in (select private.user_client_ids()));

-- Demandes de pièces : le cabinet les gère, le client les lit.
drop policy if exists document_requests_cabinet on public.document_requests;
create policy document_requests_cabinet on public.document_requests for all to authenticated
  using (client_id in (select private.user_client_ids()))
  with check (
    client_id in (select private.user_client_ids())
    and cabinet_id = (select c.cabinet_id from public.cabinet_clients c where c.id = document_requests.client_id)
    and dossier_id in (select d.id from public.client_dossiers d where d.client_id = document_requests.client_id)
  );
drop policy if exists document_requests_portal_select on public.document_requests;
create policy document_requests_portal_select on public.document_requests for select to authenticated
  using (client_id = (select private.portal_client_id()));

-- Dépôts : le client lit les siens ; le cabinet lit ceux de ses clients et les marque vus.
-- Création et refus passent par des fonctions sécurisées.
drop policy if exists portal_uploads_portal_select on public.portal_uploads;
create policy portal_uploads_portal_select on public.portal_uploads for select to authenticated
  using (client_id = (select private.portal_client_id()));
drop policy if exists portal_uploads_cabinet_select on public.portal_uploads;
create policy portal_uploads_cabinet_select on public.portal_uploads for select to authenticated
  using (client_id in (select private.user_client_ids()));

-- Le client voit sa fiche, son cabinet et ses périodes (rien d'autre).
drop policy if exists cabinet_clients_portal_select on public.cabinet_clients;
create policy cabinet_clients_portal_select on public.cabinet_clients for select to authenticated
  using (id = (select private.portal_client_id()));

drop policy if exists cabinets_portal_select on public.cabinets;
create policy cabinets_portal_select on public.cabinets for select to authenticated
  using (id = (select c.cabinet_id from public.cabinet_clients c where c.id = (select private.portal_client_id())));

drop policy if exists client_dossiers_portal_select on public.client_dossiers;
create policy client_dossiers_portal_select on public.client_dossiers for select to authenticated
  using (client_id = (select private.portal_client_id()));

-- Stockage : le client dépose dans les dossiers de son client, sans pouvoir lire ni supprimer.
drop policy if exists portal_storage_insert on storage.objects;
create policy portal_storage_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'dossier-documents'
    and (select private.portal_can_upload_to(private.storage_path_dossier_id(objects.name)))
  );

-- ---------------------------------------------------------------------------
-- Fonctions côté client (portail)
-- ---------------------------------------------------------------------------

-- Ouvre (ou retrouve) la période d'un mois récent pour déposer des pièces.
create or replace function public.portal_ensure_period(p_year integer, p_month integer)
returns public.client_dossiers
language plpgsql
security definer
set search_path = ''
as $$
declare
  cli bigint := private.portal_client_id();
  d public.client_dossiers;
  months_back integer;
begin
  if cli is null then raise exception 'Accès au portail non autorisé'; end if;
  if p_month not between 1 and 12 then raise exception 'Mois invalide'; end if;
  months_back := (extract(year from current_date)::integer * 12 + extract(month from current_date)::integer)
               - (p_year * 12 + p_month);
  select * into d from public.client_dossiers where client_id = cli and period_year = p_year and period_month = p_month;
  if d.id is not null then return d; end if;
  if months_back < 0 or months_back > 3 then
    raise exception 'Cette période n''est pas ouverte : contactez votre cabinet';
  end if;
  insert into public.client_dossiers (client_id, period_year, period_month)
  values (cli, p_year, p_month)
  on conflict (client_id, period_year, period_month) do nothing;
  select * into d from public.client_dossiers where client_id = cli and period_year = p_year and period_month = p_month;
  return d;
end;
$$;

-- Enregistre un fichier déposé (déjà envoyé dans le stockage).
create or replace function public.portal_register_upload(
  p_dossier_id bigint,
  p_doc_type text,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint,
  p_request_id bigint default null
)
returns public.portal_uploads
language plpgsql
security definer
set search_path = ''
as $$
declare
  cli bigint := private.portal_client_id();
  cab bigint;
  doc_id bigint;
  req public.document_requests;
  up public.portal_uploads;
begin
  if cli is null then raise exception 'Accès au portail non autorisé'; end if;
  if not private.portal_can_upload_to(p_dossier_id) then raise exception 'Période introuvable'; end if;
  if p_doc_type not in ('invoice', 'bank', 'other') then raise exception 'Type de pièce invalide'; end if;
  if p_storage_path is null or split_part(p_storage_path, '/', 1) <> 'dossier'
     or private.storage_path_dossier_id(p_storage_path) <> p_dossier_id then
    raise exception 'Chemin de fichier invalide';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'dossier-documents' and o.name = p_storage_path) then
    raise exception 'Fichier introuvable : renvoyez-le';
  end if;
  select cabinet_id into cab from public.cabinet_clients where id = cli;

  if p_request_id is not null then
    select * into req from public.document_requests where id = p_request_id and client_id = cli;
    if req.id is null then raise exception 'Demande introuvable'; end if;
  end if;

  -- Factures et relevés rejoignent les documents du dossier (extraction lancée par le comptable).
  -- « Autre » reste dans le suivi du portail, hors extraction.
  if p_doc_type in ('invoice', 'bank') then
    insert into public.dossier_documents (dossier_id, doc_type, original_filename, storage_path, mime_type, size_bytes, source_id, uploaded_by)
    values (p_dossier_id, p_doc_type, left(coalesce(nullif(trim(p_original_filename), ''), 'document'), 255), p_storage_path,
            coalesce(p_mime_type, 'application/octet-stream'), greatest(coalesce(p_size_bytes, 0), 0),
            'src-' || (extract(epoch from clock_timestamp()) * 1000)::bigint || '-' || substr(md5(random()::text), 1, 6),
            auth.uid())
    returning id into doc_id;
  end if;

  insert into public.portal_uploads (cabinet_id, client_id, dossier_id, document_id, request_id, doc_type, original_filename, storage_path, mime_type, size_bytes, uploaded_by)
  values (cab, cli, p_dossier_id, doc_id, req.id, p_doc_type, left(coalesce(nullif(trim(p_original_filename), ''), 'document'), 255),
          p_storage_path, p_mime_type, p_size_bytes, auth.uid())
  returning * into up;

  if req.id is not null and req.status = 'open' then
    update public.document_requests set status = 'received', received_at = now() where id = req.id;
  end if;

  insert into public.dossier_activity (dossier_id, event_type, summary, meta)
  values (p_dossier_id, 'portal_upload', 'Pièce déposée par le client : ' || up.original_filename,
          jsonb_build_object('portal_upload_id', up.id, 'doc_type', p_doc_type));
  return up;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fonctions côté cabinet
-- ---------------------------------------------------------------------------

-- Refuse un dépôt (illisible, mauvais document…) : le client le voit « à renvoyer ».
create or replace function public.portal_reject_upload(p_upload_id bigint, p_reason text)
returns public.portal_uploads
language plpgsql
security definer
set search_path = ''
as $$
declare up public.portal_uploads;
begin
  select * into up from public.portal_uploads where id = p_upload_id for update;
  if up.id is null or up.client_id not in (select private.user_client_ids()) then raise exception 'Dépôt introuvable'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Indiquez au client pourquoi renvoyer ce document'; end if;
  if up.status = 'rejected' then raise exception 'Ce document est déjà marqué à renvoyer'; end if;
  -- Le fichier sort des documents du dossier (il ne sera pas extrait) ; le cabinet supprime l'objet stocké.
  if up.document_id is not null then
    delete from public.dossier_documents where id = up.document_id;
  end if;
  update public.portal_uploads
  set status = 'rejected', reject_reason = trim(p_reason), reviewed_at = now(), seen_at = coalesce(seen_at, now()), document_id = null
  where id = up.id returning * into up;
  if up.request_id is not null then
    update public.document_requests set status = 'open', received_at = null
    where id = up.request_id and status = 'received'
      and not exists (select 1 from public.portal_uploads u where u.request_id = up.request_id and u.status = 'received');
  end if;
  return up;
end;
$$;

-- Marque comme vus les dépôts d'un client (badge « nouveaux documents »).
create or replace function public.portal_mark_seen(p_client_id bigint)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare n integer;
begin
  if p_client_id not in (select private.user_client_ids()) then raise exception 'Client introuvable'; end if;
  update public.portal_uploads set seen_at = now() where client_id = p_client_id and seen_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.portal_ensure_period(integer, integer) from public, anon;
revoke all on function public.portal_register_upload(bigint, text, text, text, text, bigint, bigint) from public, anon;
revoke all on function public.portal_reject_upload(bigint, text) from public, anon;
revoke all on function public.portal_mark_seen(bigint) from public, anon;
grant execute on function public.portal_ensure_period(integer, integer) to authenticated;
grant execute on function public.portal_register_upload(bigint, text, text, text, text, bigint, bigint) to authenticated;
grant execute on function public.portal_reject_upload(bigint, text) to authenticated;
grant execute on function public.portal_mark_seen(bigint) to authenticated;

-- Jamais l'empreinte du lien côté navigateur.
revoke all on table public.client_portal_access from authenticated, anon;
grant select (client_id, cabinet_id, user_id, contact_name, contact_phone, contact_email, is_active,
  created_by, created_at, link_created_at, last_used_at) on table public.client_portal_access to authenticated;
grant select, insert, update, delete on table public.document_requests to authenticated;
grant select on table public.portal_uploads to authenticated;
grant all on table public.client_portal_access, public.document_requests, public.portal_uploads to service_role;
