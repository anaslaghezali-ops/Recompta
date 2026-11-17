-- ---------------------------------------------------------------------------
-- Attribution des clients aux collaborateurs
--
-- Responsable (owner) et administrateurs (admin) : tous les clients du cabinet.
-- Collaborateurs (comptable) : uniquement les clients qui leur sont attribués.
--
-- Toutes les règles d'accès (dossiers, documents, fichiers Storage, imports,
-- activité, fournisseurs, RPC) passent par private.user_client_ids() et
-- private.user_can_access_dossier() : on restreint ces deux fonctions et les
-- politiques de cabinet_clients / client_dossiers qui ne les utilisaient pas.
-- ---------------------------------------------------------------------------

create table if not exists public.client_assignments (
  client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  primary key (client_id, user_id)
);

create index if not exists client_assignments_user_idx on public.client_assignments (user_id);
create index if not exists client_assignments_cabinet_idx on public.client_assignments (cabinet_id);

comment on table public.client_assignments is
  'Clients attribués à un collaborateur (rôle comptable). Écriture via l''Edge Function cabinet-team.';

alter table public.client_assignments enable row level security;
alter table public.client_assignments force row level security;

-- Lecture : les membres du cabinet ; écriture : service_role uniquement (Edge Function).
drop policy if exists client_assignments_select on public.client_assignments;
create policy client_assignments_select on public.client_assignments
  for select to authenticated
  using (
    (select private.is_super_admin())
    or cabinet_id in (select private.user_cabinet_ids())
  );

grant select on table public.client_assignments to authenticated;
grant select, insert, update, delete on table public.client_assignments to service_role;

-- ---------------------------------------------------------------------------
-- Fonctions d'accès
-- ---------------------------------------------------------------------------

-- Cabinets où l'utilisateur est responsable ou administrateur (accès à tous les clients).
create or replace function private.user_manager_cabinet_ids()
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select cabinet_id
  from public.cabinet_members
  where user_id = auth.uid()
    and is_active = true
    and role in ('owner', 'admin');
$$;

-- Clients accessibles : tous ceux des cabinets gérés + ceux attribués (membre actif).
create or replace function private.user_client_ids()
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.cabinet_clients c
  where c.cabinet_id in (select private.user_manager_cabinet_ids())
  union
  select a.client_id
  from public.client_assignments a
  join public.cabinet_members m
    on m.cabinet_id = a.cabinet_id
   and m.user_id = a.user_id
   and m.is_active = true
  where a.user_id = auth.uid();
$$;

create or replace function private.user_can_access_dossier(p_dossier_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select private.is_super_admin())
    or exists (
      select 1
      from public.client_dossiers d
      where d.id = p_dossier_id
        and d.client_id in (select private.user_client_ids())
    );
$$;

revoke all on function private.user_manager_cabinet_ids() from public;
grant execute on function private.user_manager_cabinet_ids() to authenticated, service_role;
grant execute on function private.user_client_ids() to authenticated, service_role;
grant execute on function private.user_can_access_dossier(bigint) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- cabinet_clients : visibles selon l'attribution ; création / suppression
-- réservées au responsable et aux administrateurs.
-- ---------------------------------------------------------------------------

drop policy if exists cabinet_clients_select on public.cabinet_clients;
create policy cabinet_clients_select on public.cabinet_clients
  for select to authenticated
  using (
    (select private.is_super_admin())
    or id in (select private.user_client_ids())
  );

drop policy if exists cabinet_clients_insert on public.cabinet_clients;
create policy cabinet_clients_insert on public.cabinet_clients
  for insert to authenticated
  with check (cabinet_id in (select private.user_manager_cabinet_ids()));

drop policy if exists cabinet_clients_update on public.cabinet_clients;
create policy cabinet_clients_update on public.cabinet_clients
  for update to authenticated
  using (id in (select private.user_client_ids()))
  with check (id in (select private.user_client_ids()));

drop policy if exists cabinet_clients_delete on public.cabinet_clients;
create policy cabinet_clients_delete on public.cabinet_clients
  for delete to authenticated
  using (cabinet_id in (select private.user_manager_cabinet_ids()));

-- ---------------------------------------------------------------------------
-- client_dossiers : mêmes règles que le client.
-- ---------------------------------------------------------------------------

drop policy if exists client_dossiers_select on public.client_dossiers;
create policy client_dossiers_select on public.client_dossiers
  for select to authenticated
  using (
    (select private.is_super_admin())
    or client_id in (select private.user_client_ids())
  );

drop policy if exists client_dossiers_insert on public.client_dossiers;
create policy client_dossiers_insert on public.client_dossiers
  for insert to authenticated
  with check (client_id in (select private.user_client_ids()));

drop policy if exists client_dossiers_update on public.client_dossiers;
create policy client_dossiers_update on public.client_dossiers
  for update to authenticated
  using (client_id in (select private.user_client_ids()))
  with check (client_id in (select private.user_client_ids()));

drop policy if exists client_dossiers_delete on public.client_dossiers;
create policy client_dossiers_delete on public.client_dossiers
  for delete to authenticated
  using (client_id in (select private.user_client_ids()));
