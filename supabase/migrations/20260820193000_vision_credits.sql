-- Crédits vision Freemium : quota mensuel (défaut plateforme + override cabinet).

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

insert into public.platform_settings (key, value)
values ('vision_credits_monthly_default', '10'::jsonb)
on conflict (key) do nothing;

comment on table public.platform_settings is
  'Paramètres globaux Recompta (super-admin). vision_credits_monthly_default = quota scans IA / mois.';

create table if not exists public.cabinet_vision_credits (
  cabinet_id bigint primary key references public.cabinets (id) on delete cascade,
  monthly_quota_override int check (monthly_quota_override is null or monthly_quota_override >= 0),
  used_this_period int not null default 0 check (used_this_period >= 0),
  period_start date not null default (date_trunc('month', timezone('utc', now()))::date),
  updated_at timestamptz not null default now()
);

comment on table public.cabinet_vision_credits is
  'Compteur crédits vision IA par cabinet. monthly_quota_override NULL = défaut plateforme.';

insert into public.cabinet_vision_credits (cabinet_id)
select c.id
from public.cabinets c
where not exists (
  select 1 from public.cabinet_vision_credits v where v.cabinet_id = c.id
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function private.platform_setting_int(p_key text, p_fallback int)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select (value)::int
      from public.platform_settings
      where key = p_key
    ),
    p_fallback
  );
$$;

create or replace function private.refresh_cabinet_credit_period(p_cabinet_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_month date := date_trunc('month', timezone('utc', now()))::date;
begin
  update public.cabinet_vision_credits
  set
    used_this_period = 0,
    period_start = current_month,
    updated_at = timezone('utc', now())
  where cabinet_id = p_cabinet_id
    and period_start < current_month;
end;
$$;

create or replace function private.ensure_cabinet_vision_credits(p_cabinet_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cabinet_vision_credits (cabinet_id)
  values (p_cabinet_id)
  on conflict (cabinet_id) do nothing;

  perform private.refresh_cabinet_credit_period(p_cabinet_id);
end;
$$;

create or replace function private.effective_vision_quota(p_cabinet_id bigint)
returns int
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  override_quota int;
  default_quota int;
begin
  select monthly_quota_override into override_quota
  from public.cabinet_vision_credits
  where cabinet_id = p_cabinet_id;

  default_quota := private.platform_setting_int('vision_credits_monthly_default', 10);
  return coalesce(override_quota, default_quota);
end;
$$;

create or replace function private.init_cabinet_vision_credits()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.cabinet_vision_credits (cabinet_id)
  values (new.id)
  on conflict (cabinet_id) do nothing;
  return new;
end;
$$;

drop trigger if exists cabinets_init_vision_credits on public.cabinets;
create trigger cabinets_init_vision_credits
  after insert on public.cabinets
  for each row execute function private.init_cabinet_vision_credits();

-- ---------------------------------------------------------------------------
-- API (authenticated + service)
-- ---------------------------------------------------------------------------

create or replace function public.get_my_vision_credits()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cid bigint;
  row public.cabinet_vision_credits%rowtype;
  quota int;
begin
  select cm.cabinet_id into cid
  from public.cabinet_members cm
  where cm.user_id = auth.uid()
    and cm.is_active = true
  order by cm.created_at
  limit 1;

  if cid is null then
    return json_build_object('cabinet_id', null, 'quota', 0, 'used', 0, 'remaining', 0);
  end if;

  perform private.ensure_cabinet_vision_credits(cid);

  select * into row
  from public.cabinet_vision_credits
  where cabinet_id = cid;

  quota := private.effective_vision_quota(cid);

  return json_build_object(
    'cabinet_id', cid,
    'quota', quota,
    'used', row.used_this_period,
    'remaining', greatest(quota - row.used_this_period, 0),
    'period_start', row.period_start,
    'monthly_quota_override', row.monthly_quota_override,
    'default_quota', private.platform_setting_int('vision_credits_monthly_default', 10)
  );
end;
$$;

create or replace function public.admin_get_vision_credits_settings()
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.is_super_admin()) then
    raise exception 'Accès réservé au super-admin';
  end if;

  return json_build_object(
    'default_monthly_quota', private.platform_setting_int('vision_credits_monthly_default', 10)
  );
end;
$$;

create or replace function public.admin_set_vision_credits_default(p_quota int)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_super_admin()) then
    raise exception 'Accès réservé au super-admin';
  end if;

  if p_quota is null or p_quota < 0 or p_quota > 100000 then
    raise exception 'Quota invalide (0 à 100000)';
  end if;

  insert into public.platform_settings (key, value, updated_by)
  values ('vision_credits_monthly_default', to_jsonb(p_quota), auth.uid())
  on conflict (key) do update
    set value = excluded.value,
        updated_at = timezone('utc', now()),
        updated_by = excluded.updated_by;

  return json_build_object('default_monthly_quota', p_quota);
end;
$$;

create or replace function public.admin_set_cabinet_vision_quota(
  p_cabinet_id bigint,
  p_quota int
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.is_super_admin()) then
    raise exception 'Accès réservé au super-admin';
  end if;

  if p_quota is not null and (p_quota < 0 or p_quota > 100000) then
    raise exception 'Quota cabinet invalide (0 à 100000, ou NULL pour défaut)';
  end if;

  perform private.ensure_cabinet_vision_credits(p_cabinet_id);

  update public.cabinet_vision_credits
  set
    monthly_quota_override = p_quota,
    updated_at = timezone('utc', now())
  where cabinet_id = p_cabinet_id;

  return json_build_object(
    'cabinet_id', p_cabinet_id,
    'monthly_quota_override', p_quota,
    'effective_quota', private.effective_vision_quota(p_cabinet_id)
  );
end;
$$;

create or replace function public.admin_list_cabinet_vision_credits()
returns setof json
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.is_super_admin()) then
    raise exception 'Accès réservé au super-admin';
  end if;

  return query
  select json_build_object(
    'cabinet_id', c.id,
    'cabinet_name', c.name,
    'slug', c.slug,
    'monthly_quota_override', v.monthly_quota_override,
    'effective_quota', private.effective_vision_quota(c.id),
    'used', v.used_this_period,
    'remaining', greatest(private.effective_vision_quota(c.id) - v.used_this_period, 0),
    'period_start', v.period_start
  )
  from public.cabinets c
  left join public.cabinet_vision_credits v on v.cabinet_id = c.id
  order by c.created_at desc;
end;
$$;

create or replace function public.consume_vision_credit(
  p_cabinet_id bigint,
  p_count int default 1
)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  quota int;
  row public.cabinet_vision_credits%rowtype;
begin
  if p_cabinet_id is null then
    return json_build_object('ok', true, 'skipped', true, 'reason', 'no_cabinet');
  end if;

  if p_count is null or p_count < 1 then
    raise exception 'p_count doit être >= 1';
  end if;

  perform private.ensure_cabinet_vision_credits(p_cabinet_id);

  select * into row
  from public.cabinet_vision_credits
  where cabinet_id = p_cabinet_id
  for update;

  quota := private.effective_vision_quota(p_cabinet_id);

  if row.used_this_period + p_count > quota then
    return json_build_object(
      'ok', false,
      'quota', quota,
      'used', row.used_this_period,
      'remaining', greatest(quota - row.used_this_period, 0),
      'error', 'Quota crédits vision épuisé pour ce mois'
    );
  end if;

  update public.cabinet_vision_credits
  set
    used_this_period = used_this_period + p_count,
    updated_at = timezone('utc', now())
  where cabinet_id = p_cabinet_id;

  return json_build_object(
    'ok', true,
    'quota', quota,
    'used', row.used_this_period + p_count,
    'remaining', greatest(quota - (row.used_this_period + p_count), 0)
  );
end;
$$;

create or replace function public.cabinet_id_for_dossier(p_dossier_id bigint)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select cc.cabinet_id
  from public.client_dossiers d
  join public.cabinet_clients cc on cc.id = d.client_id
  where d.id = p_dossier_id;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.platform_settings enable row level security;
alter table public.cabinet_vision_credits enable row level security;
alter table public.platform_settings force row level security;
alter table public.cabinet_vision_credits force row level security;

create policy platform_settings_select on public.platform_settings
  for select to authenticated
  using ((select private.is_super_admin()));

create policy platform_settings_write on public.platform_settings
  for all to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

create policy cabinet_vision_credits_select on public.cabinet_vision_credits
  for select to authenticated
  using (
    (select private.is_super_admin())
    or cabinet_id in (select private.user_cabinet_ids())
  );

create policy cabinet_vision_credits_update on public.cabinet_vision_credits
  for update to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

grant select on table public.platform_settings to authenticated, service_role;
grant select, update on table public.cabinet_vision_credits to authenticated, service_role;
grant insert on table public.cabinet_vision_credits to service_role;

grant execute on function public.get_my_vision_credits() to authenticated;
grant execute on function public.admin_get_vision_credits_settings() to authenticated;
grant execute on function public.admin_set_vision_credits_default(int) to authenticated;
grant execute on function public.admin_set_cabinet_vision_quota(bigint, int) to authenticated;
grant execute on function public.admin_list_cabinet_vision_credits() to authenticated;
grant execute on function public.consume_vision_credit(bigint, int) to service_role;
grant execute on function public.cabinet_id_for_dossier(bigint) to service_role, authenticated;

revoke all on function private.platform_setting_int(text, int) from public, anon, authenticated;
revoke all on function private.refresh_cabinet_credit_period(bigint) from public, anon, authenticated;
revoke all on function private.ensure_cabinet_vision_credits(bigint) from public, anon, authenticated;
revoke all on function private.effective_vision_quota(bigint) from public, anon, authenticated;
