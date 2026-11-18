-- =============================================================================
-- Ventes des clients du cabinet — phase 4 : remontée côté cabinet, TVA collectée
-- =============================================================================
-- sales_collected_detail(client, année, mois) : une ligne par document (et par
-- taux de TVA) qui entre dans la TVA collectée du mois, selon le régime du client :
--   * encaissement : chaque paiement daté du mois, au prorata de la facture
--     (paiement partiel → TVA partielle) ;
--   * débit        : chaque facture / avoir émis ou validé dans le mois.
-- Factures créées dans Recompta : ventilation par taux depuis les lignes.
-- Factures ajoutées (faites ailleurs) : taux déduit HT / TVA, montants au prorata.
-- Les droits sont ceux de l'appelant (security invoker) : le cabinet ne voit que
-- les clients qui lui sont accessibles, le portail que sa société.
-- Rejouable.
-- =============================================================================

create or replace function public.sales_collected_detail(p_client_id bigint, p_year integer, p_month integer)
returns table (
  invoice_id bigint,
  kind text,
  number text,
  customer_name text,
  customer_ice text,
  issue_date date,
  paid_on date,
  payment_method text,
  payment_id bigint,
  rate numeric,
  base_ht numeric,
  vat numeric,
  ttc numeric,
  regime text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select make_date(p_year, p_month, 1) as d0,
           (make_date(p_year, p_month, 1) + interval '1 month')::date as d1,
           (select c.vat_regime from public.cabinet_clients c where c.id = p_client_id) as regime
  ),
  docs as (
    select i.* from public.invoices i
    where i.issuer_client_id = p_client_id and i.kind in ('invoice', 'credit_note')
  ),
  -- Ventilation par taux d'un document : lignes (créé) ou taux déduit (ajouté)
  rates as (
    select d.id as invoice_id, l.vat_rate as rate,
           sum(l.total_ht) as ht, sum(round(l.total_ht * l.vat_rate / 100, 2)) as vat
    from docs d join public.invoice_lines l on l.invoice_id = d.id
    where d.origin = 'created'
    group by d.id, l.vat_rate
    union all
    select d.id, case when d.total_ht <> 0 then round(d.total_vat * 100 / d.total_ht, 2) else 0 end, d.total_ht, d.total_vat
    from docs d
    where d.origin = 'uploaded' or not exists (select 1 from public.invoice_lines l where l.invoice_id = d.id)
  ),
  -- Encaissement : paiements du mois
  enc as (
    select d.id as invoice_id, pay.paid_on, pay.method, pay.id as payment_id,
           case when d.total_ttc <> 0 then pay.amount / d.total_ttc else 0 end as ratio
    from docs d
    join public.invoice_payments pay on pay.invoice_id = d.id
    cross join params p
    where p.regime = 'encaissement' and d.kind = 'invoice'
      and pay.paid_on >= p.d0 and pay.paid_on < p.d1
  ),
  -- Débit : documents émis / validés dans le mois (avoirs compris, négatifs)
  deb as (
    select d.id as invoice_id, null::date as paid_on, null::text as method, null::bigint as payment_id, 1::numeric as ratio
    from docs d cross join params p
    where p.regime = 'debit' and d.status in ('issued', 'cancelled')
      and d.issue_date >= p.d0 and d.issue_date < p.d1
  ),
  flows as (select * from enc union all select * from deb)
  select d.id, d.kind, coalesce(d.number, d.external_number),
         coalesce(d.client_snapshot ->> 'name', cc.name), coalesce(d.client_snapshot ->> 'ice', cc.ice),
         d.issue_date, f.paid_on, f.method, f.payment_id,
         r.rate,
         round(r.ht * f.ratio, 2),
         round(r.vat * f.ratio, 2),
         round((r.ht + r.vat) * f.ratio, 2),
         (select regime from params)
  from flows f
  join docs d on d.id = f.invoice_id
  join rates r on r.invoice_id = d.id
  left join public.client_customers cc on cc.id = d.customer_id
  where r.ht <> 0 or r.vat <> 0
  order by coalesce(f.paid_on, d.issue_date), d.id, r.rate desc;
$$;

revoke all on function public.sales_collected_detail(bigint, integer, integer) from public, anon;
grant execute on function public.sales_collected_detail(bigint, integer, integer) to authenticated, service_role;
