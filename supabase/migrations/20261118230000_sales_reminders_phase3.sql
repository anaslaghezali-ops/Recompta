-- =============================================================================
-- Ventes des clients du cabinet — phase 3 : relances
-- =============================================================================
-- Historique des relances par facture (jamais supprimé : c'est une trace).
-- Le message est rédigé et envoyé depuis le portail (copie ou email) ;
-- la base enregistre qui, quand, par quel canal et quel texte.
-- Rejouable.
-- =============================================================================

create table if not exists public.sales_reminders (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references public.invoices (id) on delete cascade,
  issuer_client_id bigint not null references public.cabinet_clients (id) on delete cascade,
  cabinet_id bigint not null references public.cabinets (id) on delete cascade,
  level integer not null default 1 check (level between 1 and 3),
  channel text not null default 'email' check (channel in ('email', 'copie', 'telephone', 'courrier')),
  message text,
  note text,
  sent_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);
create index if not exists sales_reminders_invoice_idx on public.sales_reminders (invoice_id, sent_at);
create index if not exists sales_reminders_issuer_idx on public.sales_reminders (issuer_client_id, sent_at);

create or replace function private.sales_reminder_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare inv record;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Une relance enregistrée ne se modifie pas.';
  end if;
  select id, issuer_client_id, cabinet_id, kind, status into inv from public.invoices where id = new.invoice_id;
  if inv.issuer_client_id is null or inv.kind <> 'invoice' or inv.status <> 'issued' then
    raise exception 'On ne relance qu''une facture de vente validée ou émise.';
  end if;
  new.issuer_client_id := inv.issuer_client_id;
  new.cabinet_id := inv.cabinet_id;
  new.created_by := coalesce(new.created_by, auth.uid());
  new.sent_at := coalesce(new.sent_at, now());
  return new;
end;
$$;
drop trigger if exists sales_reminders_guard on public.sales_reminders;
create trigger sales_reminders_guard
  before insert or update on public.sales_reminders
  for each row execute function private.sales_reminder_guard();

alter table public.sales_reminders enable row level security;
drop policy if exists sales_reminders_portal_select on public.sales_reminders;
create policy sales_reminders_portal_select on public.sales_reminders for select to authenticated
  using (issuer_client_id = (select private.portal_client_id()));
drop policy if exists sales_reminders_portal_insert on public.sales_reminders;
create policy sales_reminders_portal_insert on public.sales_reminders for insert to authenticated
  with check (issuer_client_id = (select private.portal_client_id()));
drop policy if exists sales_reminders_cabinet_read on public.sales_reminders;
create policy sales_reminders_cabinet_read on public.sales_reminders for select to authenticated
  using (issuer_client_id in (select private.user_client_ids()));
grant select, insert on table public.sales_reminders to authenticated;
grant all on table public.sales_reminders to service_role;

-- Vue : nombre et date de la dernière relance (colonnes ajoutées en fin)
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
  c.email as customer_email,
  coalesce(r.n, 0)::integer as reminder_count,
  r.last_at as last_reminder_at,
  r.last_level as last_reminder_level
from public.invoices i
left join public.client_customers c on c.id = i.customer_id
left join lateral (
  select sum(pay.amount) as paid, max(pay.paid_on) as last_paid_on
  from public.invoice_payments pay where pay.invoice_id = i.id
) p on true
left join lateral (
  select count(*) as n, max(sr.sent_at) as last_at,
         (array_agg(sr.level order by sr.sent_at desc, sr.id desc))[1] as last_level
  from public.sales_reminders sr where sr.invoice_id = i.id
) r on true
where i.issuer_client_id is not null;
