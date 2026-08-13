-- Persistance workspace dossier TVA (lignes, banque, historique)

create table public.dossier_workspaces (
  dossier_id bigint primary key references public.client_dossiers (id) on delete cascade,
  lines jsonb not null default '[]'::jsonb,
  bank_transactions jsonb not null default '[]'::jsonb,
  bank_meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.dossier_activity (
  id bigint generated always as identity primary key,
  dossier_id bigint not null references public.client_dossiers (id) on delete cascade,
  event_type text not null,
  summary text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index dossier_activity_dossier_id_idx on public.dossier_activity (dossier_id, created_at desc);

comment on table public.dossier_workspaces is 'État métier d''un dossier TVA (lignes factures + relevé bancaire).';
comment on table public.dossier_activity is 'Historique des actions sur un dossier TVA.';

-- ---------------------------------------------------------------------------
-- Helper RLS
-- ---------------------------------------------------------------------------

create or replace function private.user_can_access_dossier(p_dossier_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select private.is_super_admin())
    or exists (
      select 1
      from public.client_dossiers d
      join public.cabinet_clients c on c.id = d.client_id
      join public.cabinet_members m on m.cabinet_id = c.cabinet_id
      where d.id = p_dossier_id
        and m.user_id = auth.uid()
        and m.is_active = true
    );
$$;

revoke all on function private.user_can_access_dossier(bigint) from public, anon;
grant execute on function private.user_can_access_dossier(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.dossier_workspaces enable row level security;
alter table public.dossier_activity enable row level security;
alter table public.dossier_workspaces force row level security;
alter table public.dossier_activity force row level security;

create policy dossier_workspaces_select on public.dossier_workspaces
  for select to authenticated
  using ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_workspaces_insert on public.dossier_workspaces
  for insert to authenticated
  with check ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_workspaces_update on public.dossier_workspaces
  for update to authenticated
  using ((select private.user_can_access_dossier(dossier_id)))
  with check ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_workspaces_delete on public.dossier_workspaces
  for delete to authenticated
  using ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_activity_select on public.dossier_activity
  for select to authenticated
  using ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_activity_insert on public.dossier_activity
  for insert to authenticated
  with check ((select private.user_can_access_dossier(dossier_id)));

grant select, insert, update, delete on table public.dossier_workspaces to authenticated, service_role;
grant select, insert on table public.dossier_activity to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Touch client_dossiers.updated_at when workspace changes
create or replace function private.touch_dossier_on_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.client_dossiers
  set updated_at = now()
  where id = new.dossier_id;
  return new;
end;
$$;

create trigger dossier_workspaces_touch_dossier
  after insert or update on public.dossier_workspaces
  for each row execute function private.touch_dossier_on_workspace();
