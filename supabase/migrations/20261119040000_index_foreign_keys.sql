-- Index sur les clés étrangères non couvertes (signalées par l'outil de conseil
-- Supabase, « unindexed foreign keys »).
-- Sans index, chaque suppression ou mise à jour d'une ligne référencée (un
-- utilisateur, un cabinet, une facture, un dossier…) oblige Postgres à parcourir
-- toute la table qui la référence, et les jointures sur ces colonnes sont plus
-- lentes. Chaque index ci-dessous a la clé étrangère comme première colonne.
-- Les colonnes presque toujours vides (voided_by, credits_invoice_id,
-- bank_dossier_id) reçoivent un index partiel « where … is not null » : plus
-- petit, et toujours utilisé pour la recherche d'une valeur précise.
-- Pas de « concurrently » : les migrations Supabase s'exécutent dans une
-- transaction, et ces tables sont encore petites (création quasi instantanée).
-- Aucun index existant n'est supprimé.

create index if not exists billing_counters_issuer_client_id_idx
  on public.billing_counters (issuer_client_id);
create index if not exists client_assignments_created_by_idx
  on public.client_assignments (created_by);
create index if not exists client_customers_cabinet_id_idx
  on public.client_customers (cabinet_id);
create index if not exists client_items_cabinet_id_idx
  on public.client_items (cabinet_id);
create index if not exists client_portal_access_created_by_idx
  on public.client_portal_access (created_by);
create index if not exists document_requests_cabinet_id_idx
  on public.document_requests (cabinet_id);
create index if not exists document_requests_created_by_idx
  on public.document_requests (created_by);
create index if not exists dossier_documents_uploaded_by_idx
  on public.dossier_documents (uploaded_by);
create index if not exists import_jobs_created_by_idx
  on public.import_jobs (created_by);
create index if not exists invoice_payments_bank_dossier_id_idx
  on public.invoice_payments (bank_dossier_id) where bank_dossier_id is not null;
create index if not exists invoice_payments_created_by_idx
  on public.invoice_payments (created_by);
create index if not exists invoices_created_by_idx
  on public.invoices (created_by);
create index if not exists invoices_credits_invoice_id_idx
  on public.invoices (credits_invoice_id) where credits_invoice_id is not null;
create index if not exists invoices_voided_by_idx
  on public.invoices (voided_by) where voided_by is not null;
create index if not exists platform_settings_updated_by_idx
  on public.platform_settings (updated_by);
create index if not exists portal_uploads_document_id_idx
  on public.portal_uploads (document_id);
create index if not exists portal_uploads_request_id_idx
  on public.portal_uploads (request_id);
create index if not exists portal_uploads_uploaded_by_idx
  on public.portal_uploads (uploaded_by);
create index if not exists sales_reminders_cabinet_id_idx
  on public.sales_reminders (cabinet_id);
create index if not exists sales_reminders_created_by_idx
  on public.sales_reminders (created_by);
