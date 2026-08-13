-- Recompta étape 3 : clients et dossiers (année / mois) par cabinet

create table public.cabinet_clients (
  id bigint generated always as identity primary key,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  name text not null,
  ice char(15) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cabinet_clients_name_len check (char_length(trim(name)) >= 2),
  constraint cabinet_clients_ice_format check (ice ~ '^[0-9]{15}$'),
  unique (cabinet_id, ice)
);

create table public.client_dossiers (
  id bigint generated always as identity primary key,
  client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  period_year smallint not null check (period_year between 2000 and 2100),
  period_month smallint not null check (period_month between 1 and 12),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'exported')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, period_year, period_month)
);

create index cabinet_clients_cabinet_id_idx on public.cabinet_clients (cabinet_id);
create index client_dossiers_client_id_idx on public.client_dossiers (client_id);
create index client_dossiers_period_idx on public.client_dossiers (period_year desc, period_month desc);

comment on table public.cabinet_clients is 'Clients d''un cabinet comptable (nom + ICE société).';
comment on table public.client_dossiers is 'Dossier TVA mensuel d''un client (période année/mois).';

-- ---------------------------------------------------------------------------
-- Helpers RLS
-- ---------------------------------------------------------------------------

create or replace function private.user_client_ids()
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.cabinet_clients c
  where c.cabinet_id in (select private.user_cabinet_ids());
$$;

create or replace function private.user_dossier_ids()
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select d.id
  from public.client_dossiers d
  where d.client_id in (select private.user_client_ids());
$$;

revoke all on function private.user_client_ids() from public, anon;
revoke all on function private.user_dossier_ids() from public, anon;
grant execute on function private.user_client_ids() to authenticated;
grant execute on function private.user_dossier_ids() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.cabinet_clients enable row level security;
alter table public.client_dossiers enable row level security;
alter table public.cabinet_clients force row level security;
alter table public.client_dossiers force row level security;

create policy cabinet_clients_select on public.cabinet_clients
  for select to authenticated
  using (
    (select private.is_super_admin())
    or cabinet_id in (select private.user_cabinet_ids())
  );

create policy cabinet_clients_insert on public.cabinet_clients
  for insert to authenticated
  with check (cabinet_id in (select private.user_cabinet_ids()));

create policy cabinet_clients_update on public.cabinet_clients
  for update to authenticated
  using (cabinet_id in (select private.user_cabinet_ids()))
  with check (cabinet_id in (select private.user_cabinet_ids()));

create policy cabinet_clients_delete on public.cabinet_clients
  for delete to authenticated
  using (cabinet_id in (select private.user_cabinet_ids()));

create policy client_dossiers_select on public.client_dossiers
  for select to authenticated
  using (
    (select private.is_super_admin())
    or id in (select private.user_dossier_ids())
  );

create policy client_dossiers_insert on public.client_dossiers
  for insert to authenticated
  with check (client_id in (select private.user_client_ids()));

create policy client_dossiers_update on public.client_dossiers
  for update to authenticated
  using (id in (select private.user_dossier_ids()))
  with check (client_id in (select private.user_client_ids()));

create policy client_dossiers_delete on public.client_dossiers
  for delete to authenticated
  using (id in (select private.user_dossier_ids()));

grant select, insert, update, delete on table public.cabinet_clients to authenticated, service_role;
grant select, insert, update, delete on table public.client_dossiers to authenticated, service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;
