-- Vérifie que chaque clé étrangère signalée par l'outil de conseil Supabase
-- (migration 20261119040000_index_foreign_keys) existe et est couverte par un
-- index dont c'est la première colonne. Lecture seule, transaction annulée.
\set ON_ERROR_STOP 1
begin;

do $$
declare
  r record;
  fk_count int;
  idx_count int;
begin
  for r in
    select * from (values
      ('billing_counters', 'issuer_client_id'),
      ('client_assignments', 'created_by'),
      ('client_customers', 'cabinet_id'),
      ('client_items', 'cabinet_id'),
      ('client_portal_access', 'created_by'),
      ('document_requests', 'cabinet_id'),
      ('document_requests', 'created_by'),
      ('dossier_documents', 'uploaded_by'),
      ('import_jobs', 'created_by'),
      ('invoice_payments', 'bank_dossier_id'),
      ('invoice_payments', 'created_by'),
      ('invoices', 'created_by'),
      ('invoices', 'credits_invoice_id'),
      ('invoices', 'voided_by'),
      ('platform_settings', 'updated_by'),
      ('portal_uploads', 'document_id'),
      ('portal_uploads', 'request_id'),
      ('portal_uploads', 'uploaded_by'),
      ('sales_reminders', 'cabinet_id'),
      ('sales_reminders', 'created_by')
    ) as v(tbl, col)
  loop
    select count(*) into fk_count
    from pg_constraint k
    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
    where k.contype = 'f'
      and k.conrelid = format('public.%I', r.tbl)::regclass
      and array_length(k.conkey, 1) = 1
      and a.attname = r.col;
    assert fk_count = 1, format('clé étrangère absente : %s(%s)', r.tbl, r.col);

    select count(*) into idx_count
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = format('public.%I', r.tbl)::regclass
      and i.indisvalid
      and a.attname = r.col;
    assert idx_count >= 1, format('clé étrangère sans index : %s(%s)', r.tbl, r.col);
  end loop;
end $$;

rollback;
\echo 'test_fk_indexes ok'
