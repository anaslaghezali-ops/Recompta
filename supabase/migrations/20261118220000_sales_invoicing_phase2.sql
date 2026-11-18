-- =============================================================================
-- Ventes des clients du cabinet — phase 2 : création de factures par le client
-- =============================================================================
--   * réglages émetteur complétés : préfixe des devis, validité, logo ;
--   * catalogue d'articles (client_items) ;
--   * devis (kind = 'quote', série DEV propre) → facture (source_quote_id) ;
--   * factures créées dans Recompta : lignes multi-taux, émission numérotée
--     (série unique factures + avoirs de la société), mentions figées ;
--   * avoir total sur une facture émise par Recompta ;
--   * lien de partage (share_token) lisible sans compte via
--     sales_public_document (le client final consulte / imprime le PDF).
-- Rejouable.
-- =============================================================================

alter table public.client_billing_settings
  add column if not exists quote_prefix text not null default 'DEV',
  add column if not exists quote_validity_days integer not null default 30,
  add column if not exists logo_data text;
alter table public.client_billing_settings drop constraint if exists client_billing_settings_logo_check;
alter table public.client_billing_settings add constraint client_billing_settings_logo_check
  check (logo_data is null or (logo_data like 'data:image/%' and length(logo_data) <= 400000));
alter table public.client_billing_settings drop constraint if exists client_billing_settings_quote_validity_check;
alter table public.client_billing_settings add constraint client_billing_settings_quote_validity_check
  check (quote_validity_days between 1 and 365);
alter table public.client_billing_settings drop constraint if exists client_billing_settings_vat_check;
alter table public.client_billing_settings add constraint client_billing_settings_vat_check
  check (default_vat_rate in (0, 7, 10, 14, 20));

-- Catalogue d'articles de la société
create table if not exists public.client_items (
  id bigint generated always as identity primary key,
  issuer_client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  unit text,
  unit_price_ht numeric(14,2) not null default 0,
  vat_rate numeric(5,2) not null default 20 check (vat_rate in (0, 7, 10, 14, 20)),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists client_items_issuer_idx on public.client_items (issuer_client_id);

create or replace function private.sales_item_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.issuer_client_id is distinct from old.issuer_client_id then
    raise exception 'Un article ne peut pas changer d''entreprise.';
  end if;
  select c.cabinet_id into new.cabinet_id from public.cabinet_clients c where c.id = new.issuer_client_id;
  new.label := trim(new.label);
  return new;
end;
$$;
drop trigger if exists client_items_guard on public.client_items;
create trigger client_items_guard
  before insert or update on public.client_items
  for each row execute function private.sales_item_guard();

-- Devis, lien devis → facture, lien de partage
alter table public.invoices drop constraint if exists invoices_kind_check;
alter table public.invoices add constraint invoices_kind_check check (kind in ('invoice', 'credit_note', 'quote'));
alter table public.billing_counters drop constraint if exists billing_counters_kind_check;
alter table public.billing_counters add constraint billing_counters_kind_check check (kind in ('invoice', 'credit_note', 'quote'));

alter table public.invoices
  add column if not exists source_quote_id bigint references public.invoices (id) on delete restrict,
  add column if not exists share_token text;
create unique index if not exists invoices_share_token_uidx on public.invoices (share_token) where share_token is not null;
create index if not exists invoices_source_quote_idx on public.invoices (source_quote_id) where source_quote_id is not null;

-- Série de numéros : cabinet par type ; société : factures + avoirs ensemble, devis à part.
drop index if exists public.invoices_series_seq_uidx;
create unique index invoices_series_seq_uidx on public.invoices (
  cabinet_id, coalesce(issuer_client_id, 0),
  (case when issuer_client_id is null then kind when kind = 'quote' then 'quote' else 'series' end), year, seq
) where seq is not null;

-- Lignes : TVA marocaine uniquement pour les ventes
create or replace function private.sales_line_rate_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.invoices i where i.id = new.invoice_id and i.issuer_client_id is not null)
     and new.vat_rate not in (0, 7, 10, 14, 20) then
    raise exception 'Taux de TVA non autorisé (0, 7, 10, 14 ou 20 %%).';
  end if;
  return new;
end;
$$;
drop trigger if exists invoice_lines_sales_rate on public.invoice_lines;
create trigger invoice_lines_sales_rate
  before insert or update on public.invoice_lines
  for each row execute function private.sales_line_rate_guard();

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
    -- Devis : seulement pour une société (jamais pour les honoraires)
    new.kind := case when new.issuer_client_id is not null and new.kind = 'quote' then 'quote' else 'invoice' end;
    new.source_quote_id := null; new.share_token := null;
    new.validated_at := null; new.voided_at := null; new.voided_by := null; new.void_reason := null;
    if new.issuer_client_id is null then
      new.origin := 'created';
      new.customer_id := null; new.external_number := null; new.document_path := null;
    else
      select c.cabinet_id into new.cabinet_id from public.cabinet_clients c where c.id = new.issuer_client_id;
      new.client_id := null;
      if new.kind = 'quote' then new.origin := 'created'; end if;
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
        new.validated_at, new.voided_at, new.voided_by, new.void_reason, new.source_quote_id, new.share_token)
       is distinct from
       (old.client_id, old.kind, old.status, old.number, old.year, old.seq, old.issue_date, old.due_date,
        old.payment_method, old.total_ht, old.total_vat, old.total_ttc, old.seller_snapshot, old.client_snapshot,
        old.credits_invoice_id, old.reason, old.customer_id, old.external_number, old.document_path,
        old.validated_at, old.voided_at, old.voided_by, old.void_reason, old.source_quote_id, old.share_token) then
      if old.origin = 'uploaded' then
        raise exception 'Facture validée : elle ne peut plus être modifiée (annulez l''enregistrement puis ressaisissez-la).';
      end if;
      raise exception 'Facture émise : elle ne peut plus être modifiée (créez un avoir).';
    end if;
  else
    -- Un brouillon ne s'émet / ne se valide que par les fonctions dédiées
    if new.status <> 'draft' or new.number is not null or new.seq is not null
       or new.validated_at is not null or new.voided_at is not null
       or new.kind is distinct from old.kind or new.share_token is not null
       or new.source_quote_id is distinct from old.source_quote_id then
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
create or replace function private.billing_next_number_for(
  p_cabinet_id bigint, p_issuer_client_id bigint, p_kind text, p_year integer,
  out seq integer, out number text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  prefix text;
  -- Société : factures et avoirs dans une seule série ; devis dans leur propre série.
  series_kind text := case when p_issuer_client_id is null then p_kind
                           when p_kind = 'quote' then 'quote' else 'invoice' end;
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
                when p_kind = 'quote' then coalesce(nullif(trim(quote_prefix), ''), 'DEV')
                else coalesce(nullif(trim(invoice_prefix), ''), 'FAC') end
      into prefix
    from public.client_billing_settings where client_id = p_issuer_client_id;
  end if;
  number := coalesce(prefix, case when p_kind = 'credit_note' then 'AV' when p_kind = 'quote' then 'DEV' else 'FAC' end)
            || '-' || p_year || '-' || lpad(seq::text, 4, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- Aide : la facture appartient-elle à la société connectée au portail ?
-- ---------------------------------------------------------------------------
create or replace function private.sales_lock_own(p_invoice_id bigint)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare inv public.invoices;
begin
  select * into inv from public.invoices where id = p_invoice_id for update;
  if inv.id is null or inv.issuer_client_id is null
     or inv.issuer_client_id is distinct from (select private.portal_client_id()) then
    raise exception 'Document introuvable';
  end if;
  return inv;
end;
$$;
revoke all on function private.sales_lock_own(bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Émission d'une facture ou d'un devis créé dans Recompta
-- ---------------------------------------------------------------------------
create or replace function public.sales_issue_invoice(p_invoice_id bigint)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  issuer public.cabinet_clients;
  cust public.client_customers;
  settings public.client_billing_settings;
  n record;
  y integer;
  missing text[] := '{}';
begin
  inv := private.sales_lock_own(p_invoice_id);
  if inv.origin <> 'created' or inv.kind not in ('invoice', 'quote') then
    raise exception 'Seuls les factures et devis créés dans Recompta s''émettent ici.';
  end if;
  if inv.status <> 'draft' then
    raise exception 'Ce document est déjà émis.';
  end if;
  if not exists (select 1 from public.invoice_lines where invoice_id = inv.id and quantity <> 0) then
    raise exception 'Ajoutez au moins une ligne.';
  end if;

  select * into issuer from public.cabinet_clients where id = inv.issuer_client_id;
  select * into settings from public.client_billing_settings where client_id = inv.issuer_client_id;
  select * into cust from public.client_customers where id = inv.customer_id;

  -- Mentions obligatoires de l'émetteur (liste à valider par l'expert-comptable)
  if coalesce(trim(issuer.ice), '') !~ '^[0-9]{15}$' then missing := array_append(missing, 'ICE (15 chiffres)'); end if;
  if coalesce(trim(settings.address), '') = '' then missing := array_append(missing, 'adresse'); end if;
  if inv.kind = 'invoice' then
    if coalesce(trim(settings.if_number), '') = '' then missing := array_append(missing, 'IF'); end if;
    if coalesce(trim(settings.rc_number), '') = '' then missing := array_append(missing, 'RC'); end if;
    if coalesce(trim(settings.tp_number), '') = '' then missing := array_append(missing, 'patente (TP)'); end if;
  end if;
  if array_length(missing, 1) > 0 then
    raise exception 'Complétez vos réglages de facturation avant d''émettre : %', array_to_string(missing, ', ');
  end if;
  if inv.due_date is not null and inv.issue_date is not null and inv.due_date < inv.issue_date then
    raise exception 'L''échéance ne peut pas précéder la date du document.';
  end if;

  perform private.billing_recompute(inv.id);
  select * into inv from public.invoices where id = inv.id;
  if inv.kind = 'invoice' and inv.total_ttc <= 0 then
    raise exception 'Le total de la facture doit être positif.';
  end if;

  y := extract(year from coalesce(inv.issue_date, current_date))::integer;
  select * into n from private.billing_next_number_for(inv.cabinet_id, inv.issuer_client_id, inv.kind, y);

  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices
  set status = 'issued',
      number = n.number,
      year = y,
      seq = n.seq,
      issue_date = coalesce(issue_date, current_date),
      due_date = coalesce(due_date, coalesce(issue_date, current_date) +
        case when kind = 'quote' then coalesce(settings.quote_validity_days, 30)
             else coalesce(cust.payment_days, settings.default_payment_days, 30) end),
      seller_snapshot = private.billing_seller_snapshot_for(cabinet_id, issuer_client_id) - 'logo_data',
      client_snapshot = jsonb_build_object(
        'name', cust.name, 'ice', cust.ice, 'if', cust.if_number,
        'address', cust.address, 'city', cust.city, 'email', cust.email, 'phone', cust.phone),
      issued_at = now(),
      updated_at = now()
  where id = inv.id
  returning * into inv;
  perform set_config('recompta.billing_internal', '', true);
  return inv;
end;
$$;

-- ---------------------------------------------------------------------------
-- Avoir total sur une facture émise par Recompta (même série que les factures)
-- ---------------------------------------------------------------------------
create or replace function public.sales_credit_invoice(p_invoice_id bigint, p_reason text)
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
begin
  inv := private.sales_lock_own(p_invoice_id);
  if inv.origin <> 'created' or inv.kind <> 'invoice' or inv.status <> 'issued' then
    raise exception 'Seule une facture émise par Recompta se corrige par un avoir.';
  end if;
  if exists (select 1 from public.invoice_payments where invoice_id = inv.id) then
    raise exception 'Cette facture a des paiements enregistrés : supprimez-les avant de faire l''avoir.';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Indiquez le motif de l''avoir.';
  end if;

  select * into n from private.billing_next_number_for(inv.cabinet_id, inv.issuer_client_id, 'credit_note', y);
  perform set_config('recompta.billing_internal', 'on', true);
  insert into public.invoices (cabinet_id, issuer_client_id, customer_id, origin, kind, status, number, year, seq,
    issue_date, due_date, payment_method, credits_invoice_id, reason, total_ht, total_vat, total_ttc,
    seller_snapshot, client_snapshot, issued_at, created_by)
  values (inv.cabinet_id, inv.issuer_client_id, inv.customer_id, 'created', 'credit_note', 'issued', n.number, y, n.seq,
    current_date, current_date, inv.payment_method, inv.id, trim(p_reason), -inv.total_ht, -inv.total_vat, -inv.total_ttc,
    private.billing_seller_snapshot_for(inv.cabinet_id, inv.issuer_client_id) - 'logo_data', inv.client_snapshot, now(), auth.uid())
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
-- Devis : transformer en facture (brouillon), ou marquer refusé
-- ---------------------------------------------------------------------------
create or replace function public.sales_convert_quote(p_quote_id bigint)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.invoices;
  new_id bigint;
begin
  q := private.sales_lock_own(p_quote_id);
  if q.kind <> 'quote' or q.status <> 'issued' then
    raise exception 'Seul un devis émis peut être transformé en facture.';
  end if;
  if exists (select 1 from public.invoices i where i.source_quote_id = q.id and i.status <> 'cancelled' and i.status <> 'voided') then
    raise exception 'Ce devis a déjà été transformé en facture.';
  end if;
  perform set_config('recompta.billing_internal', 'on', true);
  insert into public.invoices (cabinet_id, issuer_client_id, customer_id, origin, kind, status, issue_date,
    payment_method, notes, source_quote_id, created_by)
  values (q.cabinet_id, q.issuer_client_id, q.customer_id, 'created', 'invoice', 'draft', current_date,
    q.payment_method, q.notes, q.id, auth.uid())
  returning id into new_id;
  insert into public.invoice_lines (invoice_id, position, label, quantity, unit_price_ht, vat_rate)
  select new_id, l.position, l.label, l.quantity, l.unit_price_ht, l.vat_rate
  from public.invoice_lines l where l.invoice_id = q.id;
  perform set_config('recompta.billing_internal', '', true);
  perform private.billing_recompute(new_id);
  return new_id;
end;
$$;

create or replace function public.sales_refuse_quote(p_quote_id bigint)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare q public.invoices;
begin
  q := private.sales_lock_own(p_quote_id);
  if q.kind <> 'quote' or q.status <> 'issued' then
    raise exception 'Seul un devis émis peut être marqué refusé.';
  end if;
  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices set status = 'cancelled', updated_at = now() where id = q.id returning * into q;
  perform set_config('recompta.billing_internal', '', true);
  return q;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lien de partage (lecture sans compte par le client final)
-- ---------------------------------------------------------------------------
create or replace function public.sales_share_token(p_invoice_id bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare inv public.invoices;
begin
  inv := private.sales_lock_own(p_invoice_id);
  if inv.status = 'draft' then
    raise exception 'Émettez le document avant de le partager.';
  end if;
  if inv.origin <> 'created' then
    raise exception 'Seuls les documents créés dans Recompta se partagent par lien.';
  end if;
  if inv.share_token is null then
    perform set_config('recompta.billing_internal', 'on', true);
    update public.invoices
    set share_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
        sent_at = coalesce(sent_at, now())
    where id = inv.id
    returning * into inv;
    perform set_config('recompta.billing_internal', '', true);
  end if;
  return inv.share_token;
end;
$$;

create or replace function public.sales_public_document(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  inv public.invoices;
  result jsonb;
begin
  if p_token is null or length(p_token) < 40 then
    return null;
  end if;
  select * into inv from public.invoices
  where share_token = p_token and issuer_client_id is not null and status <> 'draft';
  if inv.id is null then
    return null;
  end if;
  select jsonb_build_object(
    'kind', inv.kind, 'status', inv.status, 'number', inv.number,
    'issue_date', inv.issue_date, 'due_date', inv.due_date, 'payment_method', inv.payment_method,
    'reason', inv.reason, 'notes', inv.notes,
    'total_ht', inv.total_ht, 'total_vat', inv.total_vat, 'total_ttc', inv.total_ttc,
    'seller', inv.seller_snapshot, 'client', inv.client_snapshot,
    'logo_data', (select s.logo_data from public.client_billing_settings s where s.client_id = inv.issuer_client_id),
    'original_number', (select o.number from public.invoices o where o.id = inv.credits_invoice_id),
    'original_date', (select o.issue_date from public.invoices o where o.id = inv.credits_invoice_id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
        'label', l.label, 'quantity', l.quantity, 'unit_price_ht', l.unit_price_ht,
        'vat_rate', l.vat_rate, 'total_ht', l.total_ht) order by l.position, l.id)
      from public.invoice_lines l where l.invoice_id = inv.id), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.sales_issue_invoice(bigint) from public, anon;
revoke all on function public.sales_credit_invoice(bigint, text) from public, anon;
revoke all on function public.sales_convert_quote(bigint) from public, anon;
revoke all on function public.sales_refuse_quote(bigint) from public, anon;
revoke all on function public.sales_share_token(bigint) from public, anon;
grant execute on function public.sales_issue_invoice(bigint) to authenticated;
grant execute on function public.sales_credit_invoice(bigint, text) to authenticated;
grant execute on function public.sales_convert_quote(bigint) to authenticated;
grant execute on function public.sales_refuse_quote(bigint) to authenticated;
grant execute on function public.sales_share_token(bigint) to authenticated;
revoke all on function public.sales_public_document(text) from public;
grant execute on function public.sales_public_document(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Vue : type de document, liens devis / avoir (colonnes ajoutées en fin)
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
  (case when i.kind = 'invoice' then greatest(i.total_ttc - coalesce(p.paid, 0), 0) else 0 end)::numeric(14,2) as balance,
  p.last_paid_on,
  case
    when i.status <> 'issued' or i.kind <> 'invoice' then null
    when coalesce(p.paid, 0) >= i.total_ttc - 0.005 then 'paid'
    when coalesce(p.paid, 0) > 0 then 'partial'
    else 'unpaid'
  end as payment_status,
  (i.kind = 'invoice' and i.status = 'issued' and i.due_date < current_date and i.total_ttc - coalesce(p.paid, 0) > 0.005) as is_overdue,
  case when i.kind = 'invoice' and i.status = 'issued' and i.due_date < current_date and i.total_ttc - coalesce(p.paid, 0) > 0.005
       then current_date - i.due_date end as days_overdue,
  i.kind,
  i.credits_invoice_id,
  i.source_quote_id,
  i.reason,
  i.sent_at,
  (i.share_token is not null) as is_shared,
  (select x.id from public.invoices x where x.source_quote_id = i.id and x.status not in ('cancelled', 'voided') limit 1) as converted_invoice_id,
  c.email as customer_email
from public.invoices i
left join public.client_customers c on c.id = i.customer_id
left join lateral (
  select sum(pay.amount) as paid, max(pay.paid_on) as last_paid_on
  from public.invoice_payments pay where pay.invoice_id = i.id
) p on true
where i.issuer_client_id is not null;

-- ---------------------------------------------------------------------------
-- Droits : catalogue
-- ---------------------------------------------------------------------------
alter table public.client_items enable row level security;
drop policy if exists client_items_portal on public.client_items;
create policy client_items_portal on public.client_items for all to authenticated
  using (issuer_client_id = (select private.portal_client_id()))
  with check (issuer_client_id = (select private.portal_client_id()));
drop policy if exists client_items_cabinet_read on public.client_items;
create policy client_items_cabinet_read on public.client_items for select to authenticated
  using (issuer_client_id in (select private.user_client_ids()));
grant select, insert, update, delete on table public.client_items to authenticated;
grant all on table public.client_items to service_role;
