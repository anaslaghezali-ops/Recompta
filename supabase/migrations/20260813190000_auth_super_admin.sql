-- Recompta étape 1 : Auth + super-admin + cabinets
-- À coller dans : https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new
--
-- Le rôle super_admin est stocké dans public.user_roles ET dans
-- auth.users.raw_app_meta_data (pas user_metadata, éditable par l'utilisateur).

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('super_admin')),
  created_at timestamptz not null default now()
);

create table public.cabinets (
  id bigint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cabinets_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table public.cabinet_members (
  id bigint generated always as identity primary key,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'comptable' check (role in ('owner', 'admin', 'comptable')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (cabinet_id, user_id)
);

create index cabinet_members_user_id_idx on public.cabinet_members (user_id);
create index cabinet_members_cabinet_id_idx on public.cabinet_members (cabinet_id);

comment on table public.profiles is 'Profil applicatif lié à auth.users.';
comment on table public.user_roles is 'Rôles globaux (super_admin). Les rôles cabinet sont dans cabinet_members.';
comment on table public.cabinets is 'Cabinets comptables (tenants). Créés uniquement par le super-admin.';
comment on table public.cabinet_members is 'Appartenance utilisateur ↔ cabinet.';

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER dans private, jamais exposés comme API publique)
-- ---------------------------------------------------------------------------

create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = 'super_admin'
  );
$$;

create or replace function private.user_cabinet_ids()
returns setof bigint
language sql
stable
security definer
set search_path = ''
as $$
  select cabinet_id
  from public.cabinet_members
  where user_id = auth.uid()
    and is_active = true;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email)
  values (new.id, new.email);
  return new;
end;
$$;

create or replace function private.grant_super_admin(target_email text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid;
begin
  select id into uid
  from auth.users
  where lower(email) = lower(trim(target_email));

  if uid is null then
    raise exception 'Aucun compte Auth avec cet email. Créez d''abord le compte via login.html.';
  end if;

  insert into public.user_roles (user_id, role)
  values (uid, 'super_admin')
  on conflict (user_id) do update set role = 'super_admin';

  update auth.users
  set raw_app_meta_data =
    coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', 'super_admin')
  where id = uid;

  return 'super_admin attribué à ' || lower(trim(target_email));
end;
$$;

revoke all on function private.is_super_admin() from public, anon;
revoke all on function private.user_cabinet_ids() from public, anon;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.grant_super_admin(text) from public, anon, authenticated;

grant execute on function private.is_super_admin() to authenticated;
grant execute on function private.user_cabinet_ids() to authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.cabinets enable row level security;
alter table public.cabinet_members enable row level security;

alter table public.profiles force row level security;
alter table public.user_roles force row level security;
alter table public.cabinets force row level security;
alter table public.cabinet_members force row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id or (select private.is_super_admin()));

create policy profiles_update on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy user_roles_select on public.user_roles
  for select to authenticated
  using ((select auth.uid()) = user_id or (select private.is_super_admin()));

create policy cabinets_select on public.cabinets
  for select to authenticated
  using (
    (select private.is_super_admin())
    or id in (select private.user_cabinet_ids())
  );

create policy cabinets_insert on public.cabinets
  for insert to authenticated
  with check ((select private.is_super_admin()));

create policy cabinets_update on public.cabinets
  for update to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

create policy cabinets_delete on public.cabinets
  for delete to authenticated
  using ((select private.is_super_admin()));

create policy cabinet_members_select on public.cabinet_members
  for select to authenticated
  using (
    (select private.is_super_admin())
    or cabinet_id in (select private.user_cabinet_ids())
  );

create policy cabinet_members_insert on public.cabinet_members
  for insert to authenticated
  with check ((select private.is_super_admin()));

create policy cabinet_members_update on public.cabinet_members
  for update to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

create policy cabinet_members_delete on public.cabinet_members
  for delete to authenticated
  using ((select private.is_super_admin()));

-- ---------------------------------------------------------------------------
-- Grants Data API (tables non exposées à anon)
-- ---------------------------------------------------------------------------

grant select, update on table public.profiles to authenticated;
grant select on table public.user_roles to authenticated;
grant select, insert, update, delete on table public.cabinets to authenticated;
grant select, insert, update, delete on table public.cabinet_members to authenticated;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.user_roles to service_role;
grant select, insert, update, delete on table public.cabinets to service_role;
grant select, insert, update, delete on table public.cabinet_members to service_role;

grant usage, select on all sequences in schema public to authenticated, service_role;

insert into public.profiles (user_id, email)
select id, email from auth.users
on conflict (user_id) do nothing;
