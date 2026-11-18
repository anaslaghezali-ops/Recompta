-- =============================================================================
-- Ventes des clients du cabinet — phase 5 : encaissements depuis le relevé
-- =============================================================================
-- Un paiement créé depuis une ligne de relevé garde la référence stable de
-- cette ligne (bank_ref : date | montant | libellé normalisé | rang) et le
-- dossier d'origine. Un même crédit peut régler plusieurs factures (une ligne
-- de paiement par facture, même bank_ref) mais jamais deux fois la même :
-- index unique (invoice_id, bank_ref) → pas de doublon si le relevé est
-- réimporté ou le rapprochement relancé.
-- Le cabinet (responsables + collaborateurs attribués) peut créer et annuler
-- ces paiements « relevé », uniquement ; les paiements saisis par le client
-- restent les siens. Rejouable.
-- =============================================================================

alter table public.invoice_payments
  add column if not exists bank_ref text,
  add column if not exists bank_label text,
  add column if not exists bank_dossier_id bigint references public.client_dossiers (id) on delete set null,
  add column if not exists source text not null default 'manual';
alter table public.invoice_payments drop constraint if exists invoice_payments_source_check;
alter table public.invoice_payments add constraint invoice_payments_source_check check (source in ('manual', 'bank'));
alter table public.invoice_payments drop constraint if exists invoice_payments_bank_ref_check;
alter table public.invoice_payments add constraint invoice_payments_bank_ref_check
  check ((source = 'bank') = (bank_ref is not null));
create unique index if not exists invoice_payments_bank_ref_uidx
  on public.invoice_payments (invoice_id, bank_ref) where bank_ref is not null;
create index if not exists invoice_payments_bank_ref_idx
  on public.invoice_payments (issuer_client_id, bank_ref) where bank_ref is not null;

-- Le cabinet crée / annule les encaissements issus du relevé de ses clients
drop policy if exists invoice_payments_sales_cabinet_bank_insert on public.invoice_payments;
create policy invoice_payments_sales_cabinet_bank_insert on public.invoice_payments for insert to authenticated
  with check (source = 'bank' and bank_ref is not null and issuer_client_id in (select private.user_client_ids()));
drop policy if exists invoice_payments_sales_cabinet_bank_delete on public.invoice_payments;
create policy invoice_payments_sales_cabinet_bank_delete on public.invoice_payments for delete to authenticated
  using (source = 'bank' and issuer_client_id in (select private.user_client_ids()));
