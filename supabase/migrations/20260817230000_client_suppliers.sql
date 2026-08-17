-- Carnet fournisseurs persistant : ICE/IF → nom officiel (code comptable plus tard).

create table public.client_suppliers (
  id bigint generated always as identity primary key,
  client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  ice char(15),
  if_number text,
  official_name text not null,
  accounting_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint client_suppliers_name_len check (char_length(trim(official_name)) >= 1),
  constraint client_suppliers_ice_format check (ice is null or ice ~ '^[0-9]{15}$'),
  constraint client_suppliers_has_identity check (ice is not null or coalesce(if_number, '') <> '')
);

create unique index client_suppliers_client_ice_uidx
  on public.client_suppliers (client_id, ice)
  where ice is not null;

create unique index client_suppliers_client_if_uidx
  on public.client_suppliers (client_id, if_number)
  where ice is null and coalesce(if_number, '') <> '';

create index client_suppliers_client_id_idx on public.client_suppliers (client_id);

comment on table public.client_suppliers is
  'Nom officiel d''un fournisseur pour un client, clé ICE puis IF. accounting_code = code cabinet (ex. 005).';

alter table public.client_suppliers enable row level security;
alter table public.client_suppliers force row level security;

create policy client_suppliers_select on public.client_suppliers
  for select to authenticated
  using (
    (select private.is_super_admin())
    or client_id in (select private.user_client_ids())
  );

create policy client_suppliers_insert on public.client_suppliers
  for insert to authenticated
  with check (client_id in (select private.user_client_ids()));

create policy client_suppliers_update on public.client_suppliers
  for update to authenticated
  using (client_id in (select private.user_client_ids()))
  with check (client_id in (select private.user_client_ids()));

create policy client_suppliers_delete on public.client_suppliers
  for delete to authenticated
  using (client_id in (select private.user_client_ids()));

grant select, insert, update, delete on table public.client_suppliers to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
