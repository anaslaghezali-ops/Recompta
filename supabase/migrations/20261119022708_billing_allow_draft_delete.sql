-- Suppression d'un brouillon de facture qui contient des lignes.
-- Lors d'un « on delete cascade », la facture est déjà supprimée quand le
-- trigger des lignes s'exécute : son statut est introuvable (NULL) et l'ancienne
-- garde refusait avec « Facture émise… ». La garde de la facture
-- (billing_invoice_guard) a déjà vérifié qu'il s'agit d'un brouillon : la ligne
-- d'une facture qui n'existe plus peut donc partir.
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
    if tg_op = 'DELETE' and not found then
      return old;  -- suppression en cascade d'un brouillon
    end if;
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
