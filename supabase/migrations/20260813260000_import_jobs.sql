-- File d'attente d'import asynchrone (factures, relevés)

create table public.import_jobs (
  id bigint generated always as identity primary key,
  dossier_id bigint not null references public.client_dossiers (id) on delete cascade,
  doc_type text not null check (doc_type in ('invoice', 'bank')),
  status text not null default 'queued' check (
    status in ('uploading', 'queued', 'processing', 'completed', 'failed', 'cancelled')
  ),
  total_files int not null default 0 check (total_files >= 0),
  uploaded_files int not null default 0 check (uploaded_files >= 0),
  processed_files int not null default 0 check (processed_files >= 0),
  failed_files int not null default 0 check (failed_files >= 0),
  options jsonb not null default '{}'::jsonb,
  error_summary text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.import_job_files (
  id bigint generated always as identity primary key,
  job_id bigint not null references public.import_jobs (id) on delete cascade,
  original_filename text not null,
  storage_path text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  status text not null default 'queued' check (
    status in ('queued', 'uploaded', 'processing', 'done', 'failed')
  ),
  source_id text,
  line_count int not null default 0 check (line_count >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (storage_path)
);

create index import_jobs_dossier_id_idx on public.import_jobs (dossier_id, created_at desc);
create index import_jobs_status_idx on public.import_jobs (status, created_at);
create index import_job_files_job_id_idx on public.import_job_files (job_id, id);

comment on table public.import_jobs is 'Lots d''import mis en file d''attente pour traitement asynchrone.';
comment on table public.import_job_files is 'Fichiers d''un lot d''import (Storage + statut unitaire).';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.import_jobs enable row level security;
alter table public.import_job_files enable row level security;
alter table public.import_jobs force row level security;
alter table public.import_job_files force row level security;

create policy import_jobs_select on public.import_jobs
  for select to authenticated
  using ((select private.user_can_access_dossier(dossier_id)));

create policy import_jobs_insert on public.import_jobs
  for insert to authenticated
  with check ((select private.user_can_access_dossier(dossier_id)));

create policy import_jobs_update on public.import_jobs
  for update to authenticated
  using ((select private.user_can_access_dossier(dossier_id)))
  with check ((select private.user_can_access_dossier(dossier_id)));

create policy import_job_files_select on public.import_job_files
  for select to authenticated
  using (
    exists (
      select 1
      from public.import_jobs j
      where j.id = job_id
        and (select private.user_can_access_dossier(j.dossier_id))
    )
  );

create policy import_job_files_insert on public.import_job_files
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.import_jobs j
      where j.id = job_id
        and (select private.user_can_access_dossier(j.dossier_id))
    )
  );

create policy import_job_files_update on public.import_job_files
  for update to authenticated
  using (
    exists (
      select 1
      from public.import_jobs j
      where j.id = job_id
        and (select private.user_can_access_dossier(j.dossier_id))
    )
  )
  with check (
    exists (
      select 1
      from public.import_jobs j
      where j.id = job_id
        and (select private.user_can_access_dossier(j.dossier_id))
    )
  );

grant select, insert, update on table public.import_jobs to authenticated, service_role;
grant select, insert, update on table public.import_job_files to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Storage bucket (privé, file d'attente)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'import-queue',
  'import-queue',
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

create or replace function private.storage_path_import_dossier_id(object_path text)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select nullif(split_part(object_path, '/', 2), '')::bigint;
$$;

revoke all on function private.storage_path_import_dossier_id(text) from public, anon;
grant execute on function private.storage_path_import_dossier_id(text) to authenticated;

create policy import_queue_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'import-queue'
    and (select private.user_can_access_dossier(private.storage_path_import_dossier_id(name)))
  );

create policy import_queue_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'import-queue'
    and (select private.user_can_access_dossier(private.storage_path_import_dossier_id(name)))
  );

create policy import_queue_storage_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'import-queue'
    and (select private.user_can_access_dossier(private.storage_path_import_dossier_id(name)))
  )
  with check (
    bucket_id = 'import-queue'
    and (select private.user_can_access_dossier(private.storage_path_import_dossier_id(name)))
  );

create policy import_queue_storage_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'import-queue'
    and (select private.user_can_access_dossier(private.storage_path_import_dossier_id(name)))
  );
