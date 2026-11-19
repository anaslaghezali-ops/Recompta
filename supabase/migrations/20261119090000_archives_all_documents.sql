-- Vue « Tous les documents » (cabinet) et « Archives » (portail client).
--
-- Une seule lecture pour toutes les périodes d'un client :
--   public.archive_overview(p_client_id) -> { documents: [...], lines: [...] }
-- Les lignes renvoyées ne gardent que ce qui sert au classement (fournisseur,
-- n°, dates, montants) : pas de notes internes, pas de transactions bancaires.
--
-- Accès :
--   - cabinet : clients visibles selon private.user_client_ids() (attributions) ;
--   - portail : sa propre société seulement, sans les documents écartés par
--     le cabinet (extraction_status = 'ignored').
-- Le portail peut aussi télécharger les fichiers correspondants (règle de
-- lecture sur storage.objects, limitée aux documents non écartés de sa société).
-- Rejouable.

create or replace function private.portal_can_read_document(object_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.dossier_documents doc
    join public.client_dossiers d on d.id = doc.dossier_id
    where doc.storage_path = object_path
      and d.client_id = (select private.portal_client_id())
      and doc.extraction_status is distinct from 'ignored'
  );
$$;
revoke all on function private.portal_can_read_document(text) from public, anon;
grant execute on function private.portal_can_read_document(text) to authenticated;

drop policy if exists portal_documents_storage_select on storage.objects;
create policy portal_documents_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'dossier-documents'
    and (select private.portal_can_read_document(objects.name))
  );

create or replace function public.archive_overview(p_client_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_portal boolean;
  v_result jsonb;
begin
  if p_client_id is null then
    raise exception 'Client manquant' using errcode = '22023';
  end if;

  v_portal := coalesce(p_client_id = (select private.portal_client_id()), false);
  if not v_portal
     and not (select private.is_super_admin())
     and p_client_id not in (select private.user_client_ids()) then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', doc.id,
        'dossier_id', doc.dossier_id,
        'period_year', d.period_year,
        'period_month', d.period_month,
        'doc_type', doc.doc_type,
        'original_filename', doc.original_filename,
        'storage_path', doc.storage_path,
        'mime_type', doc.mime_type,
        'size_bytes', doc.size_bytes,
        'source_id', doc.source_id,
        'extraction_status', doc.extraction_status,
        'created_at', doc.created_at
      ) order by doc.created_at desc, doc.id desc)
      from public.dossier_documents doc
      join public.client_dossiers d on d.id = doc.dossier_id
      where d.client_id = p_client_id
        and (not v_portal or doc.extraction_status is distinct from 'ignored')
    ), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'dossier_id', w.dossier_id,
        'source_id', l ->> 'source_id',
        'source_file', l ->> 'source_file',
        'lib_frss', l ->> 'lib_frss',
        'ice_frs', l ->> 'ice_frs',
        'fact_num', l ->> 'fact_num',
        'date_fac', l ->> 'date_fac',
        'date_paie', l ->> 'date_paie',
        'm_ht', l -> 'm_ht',
        'tva', l -> 'tva',
        'm_ttc', l -> 'm_ttc',
        'taux', l -> 'taux',
        'from_bank', coalesce((l ->> '_from_bank') = 'true', false)
      ))
      from public.dossier_workspaces w
      join public.client_dossiers d on d.id = w.dossier_id
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(w.lines) = 'array' then w.lines else '[]'::jsonb end
      ) l
      where d.client_id = p_client_id
        and jsonb_typeof(l) = 'object'
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;
revoke all on function public.archive_overview(bigint) from public, anon;
grant execute on function public.archive_overview(bigint) to authenticated;

comment on function public.archive_overview(bigint) is
  'Documents de toutes les périodes d''un client + lignes réduites pour le classement (vue Tous les documents / Archives).';
