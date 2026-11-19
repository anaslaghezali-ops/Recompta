-- Restreint les liens publics aux documents encore émis.
-- Les factures annulées (cancelled/voided) ne sont plus accessibles via leur ancien jeton.
-- Les avoirs émis restent consultables car leur statut est également 'issued'.
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
  where share_token = p_token
    and issuer_client_id is not null
    and status = 'issued';
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
