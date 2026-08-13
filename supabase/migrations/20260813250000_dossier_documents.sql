-- Documents importés par dossier (factures, relevés) — métadonnées + Storage

create table public.dossier_documents (
  id bigint generated always as identity primary key,
  dossier_id bigint not null references public.client_dossiers (id) on delete cascade,
  doc_type text not null check (doc_type in ('invoice', 'bank', 'archive')),
  original_filename text not null,
  storage_path text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  source_id text,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (storage_path)
);

create index dossier_documents_dossier_id_idx on public.dossier_documents (dossier_id, created_at desc);
create index dossier_documents_type_idx on public.dossier_documents (dossier_id, doc_type);

comment on table public.dossier_documents is 'Fichiers sources importés (factures, relevés) stockés dans Storage.';

-- ---------------------------------------------------------------------------
-- RLS table
-- ---------------------------------------------------------------------------

alter table public.dossier_documents enable row level security;
alter table public.dossier_documents force row level security;

create policy dossier_documents_select on public.dossier_documents
  for select to authenticated
  using ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_documents_insert on public.dossier_documents
  for insert to authenticated
  with check ((select private.user_can_access_dossier(dossier_id)));

create policy dossier_documents_delete on public.dossier_documents
  for delete to authenticated
  using ((select private.user_can_access_dossier(dossier_id)));

grant select, insert, delete on table public.dossier_documents to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage bucket (privé)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'dossier-documents',
  'dossier-documents',
  false,
  52428800,
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/tiff',
    'application/zip',
    'application/x-zip-compressed',
    'text/csv',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function private.storage_path_dossier_id(object_path text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select nullif(split_part(object_path, '/', 2), '')::bigint;
$$;

revoke all on function private.storage_path_dossier_id(text) from public, anon;
grant execute on function private.storage_path_dossier_id(text) to authenticated;

create policy dossier_documents_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'dossier-documents'
    and (select private.user_can_access_dossier(private.storage_path_dossier_id(name)))
  );

create policy dossier_documents_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'dossier-documents'
    and (select private.user_can_access_dossier(private.storage_path_dossier_id(name)))
  );

create policy dossier_documents_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'dossier-documents'
    and (select private.user_can_access_dossier(private.storage_path_dossier_id(name)))
  )
  with check (
    bucket_id = 'dossier-documents'
    and (select private.user_can_access_dossier(private.storage_path_dossier_id(name)))
  );

create policy dossier_documents_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'dossier-documents'
    and (select private.user_can_access_dossier(private.storage_path_dossier_id(name)))
  );
