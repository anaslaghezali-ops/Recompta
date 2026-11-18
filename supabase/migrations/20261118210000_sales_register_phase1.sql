-- =============================================================================
-- Ventes des clients du cabinet — phase 1 : registre des ventes + paiements
-- =============================================================================
-- Le moteur de facturation des honoraires est généralisé : l'émetteur d'une
-- facture est soit le cabinet (issuer_client_id vide : honoraires, inchangés),
-- soit un client du cabinet (issuer_client_id rempli : ses ventes).
--
--   * client_customers        : les clients de l'entreprise (« mes clients ») ;
--   * client_billing_settings : mentions de l'entreprise émettrice, SANS le nom
--                               ni l'ICE (source unique : cabinet_clients) ;
--   * invoices.origin         : 'created' (émise par Recompta, phase 2) ou
--                               'uploaded' (faite ailleurs, saisie ou importée) ;
--   * factures importées      : brouillon modifiable → « Valider » (verrouillée)
--                               → correction par annulation tracée (pas d'avoir) ;
--   * numérotation            : une seule série par société émettrice et par
--                               année (factures et avoirs), reprise possible
--                               d'un « dernier numéro utilisé » ;
--   * cabinet_clients.vat_regime : encaissement (défaut) ou débit ;
--   * pièces des ventes       : bucket séparé « sales-documents », jamais dans
--                               dossier_documents (analyse des achats intacte).
--
-- Droits : le portail ne voit et ne modifie que les ventes de SA société ;
-- le cabinet les lit (responsables + collaborateurs attribués) ; les règles
-- des honoraires sont restreintes aux lignes sans émetteur client, pour
-- invoices, invoice_lines, invoice_payments et billing_counters.
-- Rejouable (if not exists / drop … if exists).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Régime de TVA du client
-- ---------------------------------------------------------------------------
alter table public.cabinet_clients
  add column if not exists vat_regime text not null default 'encaissement';
alter table public.cabinet_clients drop constraint if exists cabinet_clients_vat_regime_check;
alter table public.cabinet_clients add constraint cabinet_clients_vat_regime_check
  check (vat_regime in ('encaissement', 'debit'));

-- ---------------------------------------------------------------------------
-- « Mes clients » de l'entreprise
-- ---------------------------------------------------------------------------
create table if not exists public.client_customers (
  id bigint generated always as identity primary key,
  issuer_client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  ice text check (ice is null or ice ~ '^[0-9]{15}$'),
  if_number text,
  address text,
  city text,
  email text,
  phone text,
  payment_days integer check (payment_days is null or payment_days between 0 and 365),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_customers_issuer_idx on public.client_customers (issuer_client_id);
create unique index if not exists client_customers_issuer_ice_uidx
  on public.client_customers (issuer_client_id, ice) where ice is not null;

create or replace function private.sales_customer_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.issuer_client_id is distinct from old.issuer_client_id then
    raise exception 'Un client ne peut pas changer d''entreprise.';
  end if;
  select c.cabinet_id into new.cabinet_id from public.cabinet_clients c where c.id = new.issuer_client_id;
  new.name := trim(new.name);
  new.ice := nullif(regexp_replace(coalesce(new.ice, ''), '\s', '', 'g'), '');
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists client_customers_guard on public.client_customers;
create trigger client_customers_guard
  before insert or update on public.client_customers
  for each row execute function private.sales_customer_guard();

-- ---------------------------------------------------------------------------
-- Mentions de l'entreprise émettrice (nom et ICE restent dans cabinet_clients)
-- ---------------------------------------------------------------------------
create table if not exists public.client_billing_settings (
  client_id bigint primary key references public.cabinet_clients (id) on delete cascade,
  legal_form text,
  capital text,
  address text,
  city text,
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
  default_payment_days integer not null default 30 check (default_payment_days between 0 and 365),
  default_vat_rate numeric(5,2) not null default 20,
  footer_note text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Factures : émetteur généralisé
-- ---------------------------------------------------------------------------
alter table public.invoices
  add column if not exists issuer_client_id bigint references public.cabinet_clients (id) on delete restrict,
  add column if not exists customer_id bigint references public.client_customers (id) on delete restrict,
  add column if not exists origin text not null default 'created',
  add column if not exists external_number text,
  add column if not exists document_path text,
  add column if not exists validated_at timestamptz,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users (id) on delete set null,
  add column if not exists void_reason text;

alter table public.invoices alter column client_id drop not null;

alter table public.invoices drop constraint if exists invoices_origin_check;
alter table public.invoices add constraint invoices_origin_check check (origin in ('created', 'uploaded'));

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft', 'issued', 'cancelled', 'voided'));

-- Honoraires : client du cabinet obligatoire. Ventes : client de l'entreprise obligatoire.
alter table public.invoices drop constraint if exists invoices_buyer_check;
alter table public.invoices add constraint invoices_buyer_check check (
  (issuer_client_id is null and client_id is not null and customer_id is null and origin = 'created')
  or (issuer_client_id is not null and customer_id is not null)
);

-- Numéros Recompta : une série par émetteur (cabinet : par type ; société : série unique).
alter table public.invoices drop constraint if exists invoices_cabinet_id_kind_year_seq_key;
create unique index if not exists invoices_series_seq_uidx on public.invoices (
  cabinet_id, coalesce(issuer_client_id, 0),
  (case when issuer_client_id is null then kind else 'series' end), year, seq
) where seq is not null;

-- Pas deux fois la même facture importée (hors enregistrements annulés).
create unique index if not exists invoices_issuer_external_number_uidx on public.invoices (
  issuer_client_id, upper(regexp_replace(external_number, '\s', '', 'g'))
) where issuer_client_id is not null and external_number is not null and status <> 'voided';

create index if not exists invoices_issuer_idx on public.invoices (issuer_client_id, status) where issuer_client_id is not null;
create index if not exists invoices_customer_idx on public.invoices (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Paiements : même séparation que les factures
-- ---------------------------------------------------------------------------
alter table public.invoice_payments
  add column if not exists issuer_client_id bigint references public.cabinet_clients (id) on delete cascade;
create index if not exists invoice_payments_issuer_idx on public.invoice_payments (issuer_client_id, paid_on)
  where issuer_client_id is not null;

-- ---------------------------------------------------------------------------
-- Compteurs : une série par émetteur
-- ---------------------------------------------------------------------------
alter table public.billing_counters
  add column if not exists issuer_client_id bigint references public.cabinet_clients (id) on delete cascade;
alter table public.billing_counters drop constraint if exists billing_counters_pkey;
create unique index if not exists billing_counters_series_uidx
  on public.billing_counters (cabinet_id, coalesce(issuer_client_id, 0), kind, year);

-- ---------------------------------------------------------------------------
-- Intégrité des factures (remplace la version honoraires, même comportement
-- pour les factures du cabinet)
-- ---------------------------------------------------------------------------
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
      if old.origin = 'uploaded' then
        raise exception 'Facture validée : annulez l''enregistrement au lieu de la supprimer.';
      end if;
      raise exception 'Une facture émise ne peut pas être supprimée (créez un avoir).';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Création uniquement en brouillon ; numéro / validation par fonctions dédiées
    new.status := 'draft';
    new.number := null; new.year := null; new.seq := null;
    new.seller_snapshot := null; new.client_snapshot := null;
    new.issued_at := null; new.credits_invoice_id := null;
    new.kind := 'invoice';
    new.validated_at := null; new.voided_at := null; new.voided_by := null; new.void_reason := null;
    if new.issuer_client_id is null then
      new.origin := 'created';
      new.customer_id := null; new.external_number := null; new.document_path := null;
    else
      select c.cabinet_id into new.cabinet_id from public.cabinet_clients c where c.id = new.issuer_client_id;
      new.client_id := null;
      if new.origin = 'created' then new.external_number := null; end if;
      new.external_number := nullif(trim(new.external_number), '');
      if not exists (select 1 from public.client_customers cc
                     where cc.id = new.customer_id and cc.issuer_client_id = new.issuer_client_id) then
        raise exception 'Choisissez un client de votre entreprise.';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if (new.cabinet_id, new.issuer_client_id, new.origin) is distinct from (old.cabinet_id, old.issuer_client_id, old.origin) then
    raise exception 'L''émetteur d''une facture ne peut pas changer.';
  end if;
  if old.status <> 'draft' then
    -- Seuls la date d'envoi et les notes internes restent modifiables
    if (new.client_id, new.kind, new.status, new.number, new.year, new.seq, new.issue_date, new.due_date,
        new.payment_method, new.total_ht, new.total_vat, new.total_ttc, new.seller_snapshot, new.client_snapshot,
        new.credits_invoice_id, new.reason, new.customer_id, new.external_number, new.document_path,
        new.validated_at, new.voided_at, new.voided_by, new.void_reason)
       is distinct from
       (old.client_id, old.kind, old.status, old.number, old.year, old.seq, old.issue_date, old.due_date,
        old.payment_method, old.total_ht, old.total_vat, old.total_ttc, old.seller_snapshot, old.client_snapshot,
        old.credits_invoice_id, old.reason, old.customer_id, old.external_number, old.document_path,
        old.validated_at, old.voided_at, old.voided_by, old.void_reason) then
      if old.origin = 'uploaded' then
        raise exception 'Facture validée : elle ne peut plus être modifiée (annulez l''enregistrement puis ressaisissez-la).';
      end if;
      raise exception 'Facture émise : elle ne peut plus être modifiée (créez un avoir).';
    end if;
  else
    -- Un brouillon ne s'émet / ne se valide que par les fonctions dédiées
    if new.status <> 'draft' or new.number is not null or new.seq is not null
       or new.validated_at is not null or new.voided_at is not null then
      raise exception 'Utilisez l''émission (ou la validation) de la facture.';
    end if;
    if new.origin = 'created' then
      -- Totaux calculés depuis les lignes
      new.total_ht := old.total_ht; new.total_vat := old.total_vat; new.total_ttc := old.total_ttc;
    else
      new.external_number := nullif(trim(new.external_number), '');
    end if;
    if new.issuer_client_id is not null and new.customer_id is distinct from old.customer_id
       and not exists (select 1 from public.client_customers cc
                       where cc.id = new.customer_id and cc.issuer_client_id = new.issuer_client_id) then
      raise exception 'Choisissez un client de votre entreprise.';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Paiements : factures émises / validées seulement ; ventes : pas de trop-perçu
-- ---------------------------------------------------------------------------
create or replace function private.billing_payment_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv record;
  already numeric;
begin
  select id, cabinet_id, status, kind, issuer_client_id, total_ttc into inv
  from public.invoices where id = new.invoice_id
  for update;
  if inv.status is distinct from 'issued' or inv.kind <> 'invoice' then
    raise exception 'Un paiement ne peut être enregistré que sur une facture émise.';
  end if;
  new.cabinet_id := inv.cabinet_id;
  new.issuer_client_id := inv.issuer_client_id;
  if inv.issuer_client_id is not null then
    if new.method not in ('virement', 'cheque', 'especes', 'carte', 'effet', 'prelevement', 'compensation', 'autre') then
      raise exception 'Mode de paiement inconnu.';
    end if;
    select coalesce(sum(p.amount), 0) into already
    from public.invoice_payments p
    where p.invoice_id = inv.id and p.id <> new.id;
    if already + new.amount > inv.total_ttc + 0.01 then
      raise exception 'Ce paiement dépasse le reste à payer (% MAD).', greatest(inv.total_ttc - already, 0);
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Numérotation : une série par émetteur, verrouillée par la ligne de compteur
-- ---------------------------------------------------------------------------
create or replace function private.billing_next_number_for(
  p_cabinet_id bigint, p_issuer_client_id bigint, p_kind text, p_year integer,
  out seq integer, out number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefix text;
  series_kind text := case when p_issuer_client_id is null then p_kind else 'invoice' end;
begin
  insert into public.billing_counters (cabinet_id, issuer_client_id, kind, year, last_seq)
  values (p_cabinet_id, p_issuer_client_id, series_kind, p_year, 0)
  on conflict do nothing;
  update public.billing_counters
  set last_seq = last_seq + 1
  where cabinet_id = p_cabinet_id
    and issuer_client_id is not distinct from p_issuer_client_id
    and kind = series_kind and year = p_year
  returning last_seq into seq;
  if p_issuer_client_id is null then
    select case when p_kind = 'credit_note' then coalesce(nullif(trim(credit_prefix), ''), 'AV')
                else coalesce(nullif(trim(invoice_prefix), ''), 'FAC') end
      into prefix
    from public.cabinet_billing_settings where cabinet_id = p_cabinet_id;
  else
    select case when p_kind = 'credit_note' then coalesce(nullif(trim(credit_prefix), ''), 'AV')
                else coalesce(nullif(trim(invoice_prefix), ''), 'FAC') end
      into prefix
    from public.client_billing_settings where client_id = p_issuer_client_id;
  end if;
  number := coalesce(prefix, case when p_kind = 'credit_note' then 'AV' else 'FAC' end)
            || '-' || p_year || '-' || lpad(seq::text, 4, '0');
end;
$$;

-- Ancienne signature (honoraires) conservée.
create or replace function private.billing_next_number(p_cabinet_id bigint, p_kind text, p_year integer, out seq integer, out number text)
language sql
security definer
set search_path = ''
as $$
  select n.seq, n.number from private.billing_next_number_for(p_cabinet_id, null, p_kind, p_year) n;
$$;

-- Mentions du vendeur : nom et ICE depuis cabinet_clients, le reste depuis les réglages.
create or replace function private.billing_seller_snapshot_for(p_cabinet_id bigint, p_issuer_client_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare snap jsonb;
begin
  if p_issuer_client_id is null then
    return private.billing_seller_snapshot(p_cabinet_id);
  end if;
  select coalesce(to_jsonb(s) - 'client_id' - 'updated_at', '{}'::jsonb)
         || jsonb_build_object('legal_name', c.name, 'ice', c.ice, 'client_name', c.name)
    into snap
  from public.cabinet_clients c
  left join public.client_billing_settings s on s.client_id = c.id
  where c.id = p_issuer_client_id;
  return snap;
end;
$$;

-- ---------------------------------------------------------------------------
-- Honoraires : les fonctions du cabinet refusent les ventes des clients
-- ---------------------------------------------------------------------------
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
  -- Honoraires uniquement : les ventes des clients ont leurs propres fonctions.
  if inv.id is null or inv.issuer_client_id is not null
     or inv.cabinet_id not in (select private.user_manager_cabinet_ids()) then
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
  if inv.id is null or inv.issuer_client_id is not null
     or inv.cabinet_id not in (select private.user_manager_cabinet_ids()) then
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

-- ---------------------------------------------------------------------------
-- Ventes : validation, annulation, reprise de numérotation (portail)
-- ---------------------------------------------------------------------------
create or replace function public.sales_validate_invoice(p_invoice_id bigint)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  cust public.client_customers;
  settings public.client_billing_settings;
  missing text[] := '{}';
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null or inv.issuer_client_id is null
     or inv.issuer_client_id is distinct from (select private.portal_client_id()) then
    raise exception 'Facture introuvable';
  end if;
  if inv.origin <> 'uploaded' then
    raise exception 'Seule une facture ajoutée (saisie ou importée) se valide ici.';
  end if;
  if inv.status <> 'draft' then
    raise exception 'Cette facture est déjà validée.';
  end if;
  if coalesce(inv.external_number, '') = '' then missing := array_append(missing, 'numéro'); end if;
  if inv.issue_date is null then missing := array_append(missing, 'date'); end if;
  if coalesce(inv.total_ttc, 0) <= 0 then missing := array_append(missing, 'montant TTC'); end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Complétez la facture avant de la valider : %', array_to_string(missing, ', ');
  end if;
  if inv.total_ht < 0 or inv.total_vat < 0 or abs(inv.total_ht + inv.total_vat - inv.total_ttc) > 0.01 then
    raise exception 'Montants incohérents : HT + TVA doit être égal au TTC.';
  end if;
  if inv.due_date is not null and inv.due_date < inv.issue_date then
    raise exception 'L''échéance ne peut pas précéder la date de la facture.';
  end if;

  select * into cust from public.client_customers where id = inv.customer_id;
  select * into settings from public.client_billing_settings where client_id = inv.issuer_client_id;

  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices
  set status = 'issued',
      validated_at = now(),
      issued_at = now(),
      due_date = coalesce(due_date, issue_date + coalesce(cust.payment_days, settings.default_payment_days, 30)),
      seller_snapshot = private.billing_seller_snapshot_for(cabinet_id, issuer_client_id),
      client_snapshot = jsonb_build_object(
        'name', cust.name, 'ice', cust.ice, 'if', cust.if_number,
        'address', cust.address, 'city', cust.city, 'email', cust.email, 'phone', cust.phone),
      updated_at = now()
  where id = inv.id
  returning * into inv;
  perform set_config('recompta.billing_internal', '', true);
  return inv;
end;
$$;

create or replace function public.sales_void_invoice(p_invoice_id bigint, p_reason text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null or inv.issuer_client_id is null
     or inv.issuer_client_id is distinct from (select private.portal_client_id()) then
    raise exception 'Facture introuvable';
  end if;
  if inv.origin <> 'uploaded' or inv.status <> 'issued' then
    raise exception 'Seule une facture ajoutée et validée peut être annulée ici.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indiquez le motif de l''annulation.';
  end if;
  if exists (select 1 from public.invoice_payments where invoice_id = inv.id) then
    raise exception 'Cette facture a des paiements enregistrés : supprimez-les avant d''annuler.';
  end if;

  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices
  set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason), updated_at = now()
  where id = inv.id
  returning * into inv;
  perform set_config('recompta.billing_internal', '', true);
  return inv;
end;
$$;

-- Reprise d'une série commencée ailleurs : seulement avant le premier numéro Recompta de l'année.
create or replace function public.sales_set_last_number(p_year integer, p_last_seq integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  cli bigint := private.portal_client_id();
  cab bigint;
begin
  if cli is null then
    raise exception 'Accès réservé au portail client.';
  end if;
  if p_year is null or p_year < 2000 or p_year > extract(year from current_date)::integer + 1 then
    raise exception 'Année invalide.';
  end if;
  if p_last_seq is null or p_last_seq < 0 or p_last_seq > 999999 then
    raise exception 'Numéro invalide.';
  end if;
  if exists (select 1 from public.invoices where issuer_client_id = cli and year = p_year and seq is not null) then
    raise exception 'Des factures ont déjà été numérotées par Recompta en % : la série ne peut plus être modifiée.', p_year;
  end if;
  select cabinet_id into cab from public.cabinet_clients where id = cli;
  insert into public.billing_counters (cabinet_id, issuer_client_id, kind, year, last_seq)
  values (cab, cli, 'invoice', p_year, p_last_seq)
  on conflict (cabinet_id, (coalesce(issuer_client_id, 0)), kind, year) do update set last_seq = excluded.last_seq;
  return p_last_seq;
end;
$$;

revoke all on function public.sales_validate_invoice(bigint) from public, anon;
revoke all on function public.sales_void_invoice(bigint, text) from public, anon;
revoke all on function public.sales_set_last_number(integer, integer) from public, anon;
grant execute on function public.sales_validate_invoice(bigint) to authenticated;
grant execute on function public.sales_void_invoice(bigint, text) to authenticated;
grant execute on function public.sales_set_last_number(integer, integer) to authenticated;
revoke all on function private.billing_next_number_for(bigint, bigint, text, integer) from public, anon, authenticated;
revoke all on function private.billing_seller_snapshot_for(bigint, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Vue de suivi : état de paiement calculé (jamais stocké)
-- ---------------------------------------------------------------------------
create or replace view public.sales_invoices
with (security_invoker = true)
as
select
  i.id, i.cabinet_id, i.issuer_client_id, i.customer_id, i.origin, i.status,
  i.external_number, i.number, i.issue_date, i.due_date, i.total_ht, i.total_vat, i.total_ttc,
  i.document_path, i.notes, i.validated_at, i.voided_at, i.void_reason, i.created_at,
  coalesce(c.name, i.client_snapshot ->> 'name') as customer_name,
  coalesce(p.paid, 0)::numeric(14,2) as paid_amount,
  greatest(i.total_ttc - coalesce(p.paid, 0), 0)::numeric(14,2) as balance,
  p.last_paid_on,
  case
    when i.status <> 'issued' then null
    when coalesce(p.paid, 0) >= i.total_ttc - 0.005 then 'paid'
    when coalesce(p.paid, 0) > 0 then 'partial'
    else 'unpaid'
  end as payment_status,
  (i.status = 'issued' and i.due_date < current_date and i.total_ttc - coalesce(p.paid, 0) > 0.005) as is_overdue,
  case when i.status = 'issued' and i.due_date < current_date and i.total_ttc - coalesce(p.paid, 0) > 0.005
       then current_date - i.due_date end as days_overdue
from public.invoices i
left join public.client_customers c on c.id = i.customer_id
left join lateral (
  select sum(pay.amount) as paid, max(pay.paid_on) as last_paid_on
  from public.invoice_payments pay where pay.invoice_id = i.id
) p on true
where i.issuer_client_id is not null;

-- ---------------------------------------------------------------------------
-- Droits (RLS)
-- ---------------------------------------------------------------------------
alter table public.client_customers enable row level security;
alter table public.client_billing_settings enable row level security;

-- Honoraires : uniquement les lignes sans émetteur client
drop policy if exists invoices_all on public.invoices;
create policy invoices_all on public.invoices for all to authenticated
  using (issuer_client_id is null and cabinet_id in (select private.user_manager_cabinet_ids()))
  with check (
    issuer_client_id is null
    and cabinet_id in (select private.user_manager_cabinet_ids())
    and client_id in (select c.id from public.cabinet_clients c where c.cabinet_id = invoices.cabinet_id)
  );

drop policy if exists invoice_lines_all on public.invoice_lines;
create policy invoice_lines_all on public.invoice_lines for all to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                 and i.issuer_client_id is null
                 and i.cabinet_id in (select private.user_manager_cabinet_ids())))
  with check (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                      and i.issuer_client_id is null
                      and i.cabinet_id in (select private.user_manager_cabinet_ids())));

drop policy if exists invoice_payments_all on public.invoice_payments;
create policy invoice_payments_all on public.invoice_payments for all to authenticated
  using (issuer_client_id is null and cabinet_id in (select private.user_manager_cabinet_ids()))
  with check (issuer_client_id is null
              and exists (select 1 from public.invoices i where i.id = invoice_payments.invoice_id
                          and i.issuer_client_id is null
                          and i.cabinet_id in (select private.user_manager_cabinet_ids())));

drop policy if exists billing_counters_select on public.billing_counters;
create policy billing_counters_select on public.billing_counters for select to authenticated
  using (issuer_client_id is null and cabinet_id in (select private.user_manager_cabinet_ids()));

-- Ventes, côté portail : uniquement SA société
drop policy if exists invoices_sales_portal on public.invoices;
create policy invoices_sales_portal on public.invoices for all to authenticated
  using (issuer_client_id = (select private.portal_client_id()))
  with check (issuer_client_id = (select private.portal_client_id()));

drop policy if exists invoice_lines_sales_portal on public.invoice_lines;
create policy invoice_lines_sales_portal on public.invoice_lines for all to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                 and i.issuer_client_id = (select private.portal_client_id())))
  with check (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                      and i.issuer_client_id = (select private.portal_client_id())));

drop policy if exists invoice_payments_sales_portal on public.invoice_payments;
create policy invoice_payments_sales_portal on public.invoice_payments for all to authenticated
  using (issuer_client_id = (select private.portal_client_id()))
  with check (issuer_client_id = (select private.portal_client_id()));

drop policy if exists billing_counters_sales_portal on public.billing_counters;
create policy billing_counters_sales_portal on public.billing_counters for select to authenticated
  using (issuer_client_id = (select private.portal_client_id()));

drop policy if exists client_customers_portal on public.client_customers;
create policy client_customers_portal on public.client_customers for all to authenticated
  using (issuer_client_id = (select private.portal_client_id()))
  with check (issuer_client_id = (select private.portal_client_id()));

drop policy if exists client_billing_settings_portal on public.client_billing_settings;
create policy client_billing_settings_portal on public.client_billing_settings for all to authenticated
  using (client_id = (select private.portal_client_id()))
  with check (client_id = (select private.portal_client_id()));

-- Ventes, côté cabinet : lecture (responsables + collaborateurs attribués)
drop policy if exists invoices_sales_cabinet_read on public.invoices;
create policy invoices_sales_cabinet_read on public.invoices for select to authenticated
  using (issuer_client_id in (select private.user_client_ids()));

drop policy if exists invoice_lines_sales_cabinet_read on public.invoice_lines;
create policy invoice_lines_sales_cabinet_read on public.invoice_lines for select to authenticated
  using (exists (select 1 from public.invoices i where i.id = invoice_lines.invoice_id
                 and i.issuer_client_id in (select private.user_client_ids())));

drop policy if exists invoice_payments_sales_cabinet_read on public.invoice_payments;
create policy invoice_payments_sales_cabinet_read on public.invoice_payments for select to authenticated
  using (issuer_client_id in (select private.user_client_ids()));

drop policy if exists billing_counters_sales_cabinet_read on public.billing_counters;
create policy billing_counters_sales_cabinet_read on public.billing_counters for select to authenticated
  using (issuer_client_id in (select private.user_client_ids()));

drop policy if exists client_customers_cabinet_read on public.client_customers;
create policy client_customers_cabinet_read on public.client_customers for select to authenticated
  using (issuer_client_id in (select private.user_client_ids()));

drop policy if exists client_billing_settings_cabinet_read on public.client_billing_settings;
create policy client_billing_settings_cabinet_read on public.client_billing_settings for select to authenticated
  using (client_id in (select private.user_client_ids()));

grant select, insert, update, delete on table public.client_customers to authenticated;
grant select, insert, update, delete on table public.client_billing_settings to authenticated;
grant select on table public.sales_invoices to authenticated;
grant all on table public.client_customers, public.client_billing_settings to service_role;
grant select on table public.sales_invoices to service_role;

-- ---------------------------------------------------------------------------
-- Pièces des ventes : bucket séparé (jamais dans dossier_documents)
-- Chemin : client/<id de la société>/<fichier>
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sales-documents', 'sales-documents', false, 52428800,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do nothing;

drop policy if exists sales_storage_portal_insert on storage.objects;
create policy sales_storage_portal_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sales-documents'
    and (storage.foldername(name))[1] = 'client'
    and (storage.foldername(name))[2] = (select private.portal_client_id())::text
  );

drop policy if exists sales_storage_read on storage.objects;
create policy sales_storage_read on storage.objects for select to authenticated
  using (
    bucket_id = 'sales-documents'
    and (storage.foldername(name))[1] = 'client'
    and (
      (storage.foldername(name))[2] = (select private.portal_client_id())::text
      or (storage.foldername(name))[2] in (select x::text from private.user_client_ids() x)
    )
  );

-- Suppression : seulement une pièce qui n'est rattachée à aucune facture validée.
drop policy if exists sales_storage_portal_delete on storage.objects;
create policy sales_storage_portal_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'sales-documents'
    and (storage.foldername(name))[1] = 'client'
    and (storage.foldername(name))[2] = (select private.portal_client_id())::text
    and not exists (select 1 from public.invoices i
                    where i.document_path = objects.name and i.status <> 'draft')
  );
