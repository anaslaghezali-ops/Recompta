-- Corrige les déplacements de lignes entre factures :
-- - vérifier les factures OLD et NEW sur UPDATE ;
-- - recalculer les totaux des deux brouillons concernés.
create or replace function private.billing_lines_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  st text;
  internal_change boolean := coalesce(current_setting('recompta.billing_internal', true), '') = 'on';
begin
  if internal_change then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    select status into st from public.invoices where id = old.invoice_id;
    if st is distinct from 'draft' then
      raise exception 'Facture émise : les lignes ne peuvent plus être modifiées (créez un avoir).';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select status into st from public.invoices where id = new.invoice_id;
    if st is distinct from 'draft' then
      raise exception 'Facture émise : les lignes ne peuvent plus être modifiées (créez un avoir).';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
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
  if tg_op = 'DELETE' then
    perform private.billing_recompute(old.invoice_id);
    return null;
  end if;

  if tg_op = 'UPDATE' and old.invoice_id is distinct from new.invoice_id then
    perform private.billing_recompute(old.invoice_id);
  end if;

  perform private.billing_recompute(new.invoice_id);
  return null;
end;
$$;

drop trigger if exists invoice_lines_totals on public.invoice_lines;
create trigger invoice_lines_totals
  after insert or update or delete on public.invoice_lines
  for each row execute function private.billing_lines_after();
