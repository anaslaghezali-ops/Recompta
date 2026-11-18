-- Statut de lecture par document : une facture non lue ne doit plus passer
-- inaperçue (elle bloque la déclaration tant qu'elle n'est pas relancée ou
-- ignorée).
--
--   extraction_status : null (jamais tenté) | done | failed | ignored
--   extraction_error  : raison lisible du dernier échec
--   extraction_attempts : nombre de tentatives de lecture
--
-- Rejouable sans risque.

alter table public.dossier_documents
  add column if not exists extraction_status text,
  add column if not exists extraction_error text,
  add column if not exists extraction_attempts integer not null default 0,
  add column if not exists extracted_at timestamptz;

alter table public.dossier_documents
  drop constraint if exists dossier_documents_extraction_status_check;
alter table public.dossier_documents
  add constraint dossier_documents_extraction_status_check
  check (extraction_status is null or extraction_status in ('done', 'failed', 'ignored'));

comment on column public.dossier_documents.extraction_status is
  'null = jamais lu, done = lignes extraites, failed = lecture échouée, ignored = écarté par l''utilisateur (pas une facture)';

-- Le cabinet peut seulement marquer un document « ignoré » ou le rétablir :
-- droit de mise à jour limité à ces deux colonnes.
drop policy if exists dossier_documents_update on public.dossier_documents;
create policy dossier_documents_update on public.dossier_documents
  for update to authenticated
  using ((select private.user_can_access_dossier(dossier_id)))
  with check ((select private.user_can_access_dossier(dossier_id)));

grant update (extraction_status, extraction_error) on table public.dossier_documents to authenticated;
grant update on table public.dossier_documents to service_role;
