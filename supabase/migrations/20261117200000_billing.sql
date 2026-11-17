-- ---------------------------------------------------------------------------
-- Facturation des honoraires du cabinet à ses clients (V1)
--
-- Conformité (CGI art. 145) :
--   * numérotation continue, sans trou, attribuée uniquement à l'émission ;
--   * série distincte pour les avoirs (AV) ;
--   * une facture émise n'est plus modifiable ni supprimable : on l'annule
--     par un avoir qui la référence ;
--   * coordonnées du cabinet et du client figées à l'émission (instantané).
--
-- Accès : responsable et administrateurs du cabinet uniquement
-- (private.user_manager_cabinet_ids(), migration client_assignments).
-- ---------------------------------------------------------------------------

-- Coordonnées de facturation du client (complètent nom + ICE existants)
alter table public.cabinet_clients
  add column if not exists billing_address text,
  add column if not exists billing_city text,
  add column if not exists billing_email text,
  add column if not exists billing_phone text,
  add column if not exists billing_if text;

-- Mentions légales du cabinet (vendeur)
create table if not exists public.cabinet_billing_settings (
  cabinet_id bigint primary key references public.cabinets (id) on delete cascade,
  legal_name text,
  legal_form text,
  capital text,
  address text,
  city text,
  ice text,
  if_number text,
  tp_number text,
  rc_number text,
  rc_city text,
  phone text,
  email text,
  bank_name text,
  rib text,
  invoice_prefix text not null default 'FAC',
  credit_prefix text not null default 'AV',
  default_payment_days integer not null default 30 check (default_payment_days between 0 and 120),
  default_vat_rate numeric(5,2) not null default 20,
  footer_note text,
  updated_at timestamptz not null default now()
);

-- Catalogue de prestations
create table if not exists public.billing_services (
  id bigint generated always as identity primary key,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  unit_price_ht numeric(14,2) not null default 0,
  vat_rate numeric(5,2) not null default 20,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists billing_services_cabinet_idx on public.billing_services (cabinet_id);

-- Compteurs de numérotation (une série par cabinet, type et année)
create table if not exists public.billing_counters (
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  kind text not null check (kind in ('invoice', 'credit_note')),
  year integer not null,
  last_seq integer not null default 0,
  primary key (cabinet_id, kind, year)
);

-- Factures et avoirs
create table if not exists public.invoices (
  id bigint generated always as identity primary key,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  client_id bigint not null references public.cabinet_clients (id) on delete restrict,
  kind text not null default 'invoice' check (kind in ('invoice', 'credit_note')),
  status text not null default 'draft' check (status in ('draft', 'issued', 'cancelled')),
  number text,
  year integer,
  seq integer,
  issue_date date,
  due_date date,
  payment_method text,
  credits_invoice_id bigint references public.invoices (id) on delete restrict,
  reason text,
  notes text,
  total_ht numeric(14,2) not null default 0,
  total_vat numeric(14,2) not null default 0,
  total_ttc numeric(14,2) not null default 0,
  seller_snapshot jsonb,
  client_snapshot jsonb,
  sent_at timestamptz,
  issued_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cabinet_id, kind, year, seq)
);
create index if not exists invoices_cabinet_idx on public.invoices (cabinet_id, status);
create index if not exists invoices_client_idx on public.invoices (client_id);

create table if not exists public.invoice_lines (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices (id) on delete cascade,
  position integer not null default 0,
  label text not null default '',
  quantity numeric(12,3) not null default 1,
  unit_price_ht numeric(14,2) not null default 0,
  vat_rate numeric(5,2) not null default 20,
  total_ht numeric(14,2) generated always as (round(quantity * unit_price_ht, 2)) stored
);
create index if not exists invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

create table if not exists public.invoice_payments (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices (id) on delete cascade,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  paid_on date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'virement',
  reference text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on public.invoice_payments (invoice_id);
create index if not exists invoice_payments_cabinet_idx on public.invoice_payments (cabinet_id);

-- ---------------------------------------------------------------------------
-- Intégrité : totaux, immutabilité des factures émises
-- ---------------------------------------------------------------------------

create or replace function private.billing_recompute(p_invoice_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare prev text := coalesce(current_setting('recompta.billing_internal', true), '');
begin
  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices i
  set total_ht = coalesce(t.ht, 0),
      total_vat = coalesce(t.vat, 0),
      total_ttc = coalesce(t.ht, 0) + coalesce(t.vat, 0),
      updated_at = now()
  from (
    select sum(l.total_ht) as ht, sum(round(l.total_ht * l.vat_rate / 100, 2)) as vat
    from public.invoice_lines l
    where l.invoice_id = p_invoice_id
  ) t
  where i.id = p_invoice_id and i.status = 'draft';
  perform set_config('recompta.billing_internal', prev, true);
end;
$$;

create or replace function private.billing_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target bigint := coalesce(new.invoice_id, old.invoice_id);
  st text;
begin
  select status into st from public.invoices where id = target;
  if st is distinct from 'draft' and not coalesce(current_setting('recompta.billing_internal', true), '') = 'on' then
    raise exception 'Facture émise : les lignes ne peuvent plus être modifiées (créez un avoir).';
  end if;
  if tg_op = 'DELETE' then
    perform private.billing_recompute(old.invoice_id);
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.billing_lines_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.billing_recompute(coalesce(new.invoice_id, old.invoice_id));
  return null;
end;
$$;

drop trigger if exists invoice_lines_guard on public.invoice_lines;
create trigger invoice_lines_guard
  before insert or update or delete on public.invoice_lines
  for each row execute function private.billing_lines_guard();

drop trigger if exists invoice_lines_totals on public.invoice_lines;
create trigger invoice_lines_totals
  after insert or update on public.invoice_lines
  for each row execute function private.billing_lines_after();

create or replace function private.billing_invoice_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('recompta.billing_internal', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Une facture émise ne peut pas être supprimée (créez un avoir).';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    -- Création uniquement en brouillon ; numéro attribué par billing_issue_invoice
    new.status := 'draft';
    new.number := null; new.year := null; new.seq := null;
    new.seller_snapshot := null; new.client_snapshot := null;
    new.issued_at := null; new.credits_invoice_id := null;
    new.kind := 'invoice';
    return new;
  end if;
  -- UPDATE
  if old.status <> 'draft' then
    -- Seuls la date d'envoi et les notes internes restent modifiables
    if (new.client_id, new.kind, new.status, new.number, new.year, new.seq, new.issue_date, new.due_date,
        new.payment_method, new.total_ht, new.total_vat, new.total_ttc, new.seller_snapshot, new.client_snapshot,
        new.credits_invoice_id, new.reason)
       is distinct from
       (old.client_id, old.kind, old.status, old.number, old.year, old.seq, old.issue_date, old.due_date,
        old.payment_method, old.total_ht, old.total_vat, old.total_ttc, old.seller_snapshot, old.client_snapshot,
        old.credits_invoice_id, old.reason) then
      raise exception 'Facture émise : elle ne peut plus être modifiée (créez un avoir).';
    end if;
  else
    -- Un brouillon ne s'émet que via billing_issue_invoice
    if new.status <> 'draft' or new.number is not null or new.seq is not null then
      raise exception 'Utilisez l''émission de facture pour lui attribuer un numéro.';
    end if;
    new.total_ht := old.total_ht; new.total_vat := old.total_vat; new.total_ttc := old.total_ttc;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists invoices_guard on public.invoices;
create trigger invoices_guard
  before insert or update or delete on public.invoices
  for each row execute function private.billing_invoice_guard();

create or replace function private.billing_payment_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare inv record;
begin
  select cabinet_id, status, kind into inv from public.invoices where id = new.invoice_id;
  if inv.status is distinct from 'issued' or inv.kind <> 'invoice' then
    raise exception 'Un paiement ne peut être enregistré que sur une facture émise.';
  end if;
  new.cabinet_id := inv.cabinet_id;
  return new;
end;
$$;

drop trigger if exists invoice_payments_guard on public.invoice_payments;
create trigger invoice_payments_guard
  before insert or update on public.invoice_payments
  for each row execute function private.billing_payment_guard();

-- ---------------------------------------------------------------------------
-- Émission (numéro définitif) et annulation par avoir
-- ---------------------------------------------------------------------------

create or replace function private.billing_seller_snapshot(p_cabinet_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(to_jsonb(s) - 'cabinet_id' - 'updated_at', '{}'::jsonb)
         || jsonb_build_object('cabinet_name', c.name)
  from public.cabinets c
  left join public.cabinet_billing_settings s on s.cabinet_id = c.id
  where c.id = p_cabinet_id;
$$;

create or replace function private.billing_next_number(p_cabinet_id bigint, p_kind text, p_year integer, out seq integer, out number text)
language plpgsql
security definer
set search_path = ''
as $$
declare prefix text;
begin
  insert into public.billing_counters (cabinet_id, kind, year, last_seq)
  values (p_cabinet_id, p_kind, p_year, 0)
  on conflict do nothing;
  update public.billing_counters
  set last_seq = last_seq + 1
  where cabinet_id = p_cabinet_id and kind = p_kind and year = p_year
  returning last_seq into seq;
  select case when p_kind = 'credit_note' then coalesce(nullif(trim(credit_prefix), ''), 'AV')
              else coalesce(nullif(trim(invoice_prefix), ''), 'FAC') end
    into prefix
  from public.cabinet_billing_settings where cabinet_id = p_cabinet_id;
  number := coalesce(prefix, case when p_kind = 'credit_note' then 'AV' else 'FAC' end)
            || '-' || p_year || '-' || lpad(seq::text, 4, '0');
end;
$$;

create or replace function public.billing_issue_invoice(p_invoice_id bigint)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  cli public.cabinet_clients;
  settings public.cabinet_billing_settings;
  n record;
  y integer;
  missing text[] := '{}';
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null or inv.cabinet_id not in (select private.user_manager_cabinet_ids()) then
    raise exception 'Facture introuvable';
  end if;
  if inv.status <> 'draft' then
    raise exception 'Cette facture est déjà émise';
  end if;
  if not exists (select 1 from public.invoice_lines where invoice_id = inv.id and quantity <> 0) then
    raise exception 'Ajoutez au moins une ligne à la facture';
  end if;

  select * into settings from public.cabinet_billing_settings where cabinet_id = inv.cabinet_id;
  if coalesce(trim(settings.legal_name), '') = '' then missing := array_append(missing, 'raison sociale'); end if;
  if coalesce(trim(settings.address), '') = '' then missing := array_append(missing, 'adresse'); end if;
  if coalesce(trim(settings.ice), '') = '' then missing := array_append(missing, 'ICE'); end if;
  if coalesce(trim(settings.if_number), '') = '' then missing := array_append(missing, 'IF'); end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Complétez les informations du cabinet avant d''émettre : %', array_to_string(missing, ', ');
  end if;

  select * into cli from public.cabinet_clients where id = inv.client_id;

  perform private.billing_recompute(inv.id);
  y := extract(year from coalesce(inv.issue_date, current_date))::integer;
  select * into n from private.billing_next_number(inv.cabinet_id, 'invoice', y);

  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices
  set status = 'issued',
      number = n.number,
      year = y,
      seq = n.seq,
      issue_date = coalesce(issue_date, current_date),
      due_date = coalesce(due_date, coalesce(issue_date, current_date) + coalesce(settings.default_payment_days, 30)),
      seller_snapshot = private.billing_seller_snapshot(inv.cabinet_id),
      client_snapshot = jsonb_build_object(
        'name', cli.name, 'ice', cli.ice, 'if', cli.billing_if,
        'address', cli.billing_address, 'city', cli.billing_city,
        'email', cli.billing_email, 'phone', cli.billing_phone),
      issued_at = now(),
      updated_at = now()
  where id = inv.id
  returning * into inv;
  perform set_config('recompta.billing_internal', '', true);
  return inv;
end;
$$;

create or replace function public.billing_cancel_invoice(p_invoice_id bigint, p_reason text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  credit public.invoices;
  n record;
  y integer := extract(year from current_date)::integer;
  paid numeric;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null or inv.cabinet_id not in (select private.user_manager_cabinet_ids()) then
    raise exception 'Facture introuvable';
  end if;
  if inv.kind <> 'invoice' or inv.status <> 'issued' then
    raise exception 'Seule une facture émise peut être annulée';
  end if;
  select coalesce(sum(amount), 0) into paid from public.invoice_payments where invoice_id = inv.id;
  if paid > 0 then
    raise exception 'Cette facture a des paiements enregistrés : supprimez-les avant de l''annuler';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indiquez le motif de l''annulation';
  end if;

  select * into n from private.billing_next_number(inv.cabinet_id, 'credit_note', y);
  perform set_config('recompta.billing_internal', 'on', true);

  insert into public.invoices (cabinet_id, client_id, kind, status, number, year, seq, issue_date, due_date,
    payment_method, credits_invoice_id, reason, total_ht, total_vat, total_ttc,
    seller_snapshot, client_snapshot, issued_at, created_by)
  values (inv.cabinet_id, inv.client_id, 'credit_note', 'issued', n.number, y, n.seq, current_date, current_date,
    inv.payment_method, inv.id, trim(p_reason), -inv.total_ht, -inv.total_vat, -inv.total_ttc,
    private.billing_seller_snapshot(inv.cabinet_id), inv.client_snapshot, now(), auth.uid())
  returning * into credit;

  insert into public.invoice_lines (invoice_id, position, label, quantity, unit_price_ht, vat_rate)
  select credit.id, l.position, l.label, -l.quantity, l.unit_price_ht, l.vat_rate
  from public.invoice_lines l where l.invoice_id = inv.id;

  update public.invoices set status = 'cancelled', updated_at = now() where id = inv.id;
  perform set_config('recompta.billing_internal', '', true);
  return credit;
end;
$$;

revoke all on function public.billing_issue_invoice(bigint) from public, anon;
revoke all on function public.billing_cancel_invoice(bigint, text) from public, anon;
grant execute on function public.billing_issue_invoice(bigint) to authenticated;
grant execute on function public.billing_cancel_invoice(bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS : responsable et administrateurs du cabinet
-- ---------------------------------------------------------------------------

alter table public.cabinet_billing_settings enable row level security;
alter table public.billing_services enable row level security;
alter table public.billing_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.invoice_payments enable row level security;

drop policy if exists billing_settings_all on public.cabinet_billing_settings;
create policy billing_settings_all on public.cabinet_billing_settings for all to authenticated
  using (cabinet_id in (select private.user_manager_cabinet_ids()))
  with check (cabinet_id in (select private.user_manager_cabinet_ids()));

drop policy if exists billing_services_all on public.billing_services;
create policy billing_services_all on public.billing_services for all to authenticated
  using (cabinet_id in (select private.user_manager_cabinet_ids()))
  with check (cabinet_id in (select private.user_manager_cabinet_ids()));

-- Compteurs : lecture seule (écriture via fonctions sécurisées)
drop policy if exists billing_counters_select on public.billing_counters;
create policy billing_counters_select on public.billing_counters for select to authenticated
  using (cabinet_id in (select private.user_manager_cabinet_ids()));

drop policy if exists invoices_all on public.invoices;
create policy invoices_all on public.invoices for all to authenticated
  using (cabinet_id in (select private.user_manager_cabinet_ids()))
  with check (
    cabinet_id in (select private.user_manager_cabinet_ids())
    and client_id in (select c.id from public.cabinet_clients c where c.cabinet_id = invoices.cabinet_id)
  );

drop policy if exists invoice_lines_all on public.invoice_lines;
create policy invoice_lines_all on public.invoice_lines for all to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                 and i.cabinet_id in (select private.user_manager_cabinet_ids())))
  with check (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                      and i.cabinet_id in (select private.user_manager_cabinet_ids())));

drop policy if exists invoice_payments_all on public.invoice_payments;
create policy invoice_payments_all on public.invoice_payments for all to authenticated
  using (cabinet_id in (select private.user_manager_cabinet_ids()))
  with check (exists (select 1 from public.invoices i where i.id = invoice_payments.invoice_id
                      and i.cabinet_id in (select private.user_manager_cabinet_ids())));

grant select, insert, update, delete on table public.cabinet_billing_settings to authenticated;
grant select, insert, update, delete on table public.billing_services to authenticated;
grant select on table public.billing_counters to authenticated;
grant select, insert, update, delete on table public.invoices to authenticated;
grant select, insert, update, delete on table public.invoice_lines to authenticated;
grant select, insert, update, delete on table public.invoice_payments to authenticated;
grant all on table public.cabinet_billing_settings, public.billing_services, public.billing_counters,
  public.invoices, public.invoice_lines, public.invoice_payments to service_role;
