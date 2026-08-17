-- Recrée la RPC : retour tabulaire (lisible par supabase-js) + suppression Storage.
-- DROP obligatoire : le type de retour change (bigint[] → TABLE).

drop function if exists public.delete_dossier_documents(bigint[]);
drop function if exists public.delete_dossier_documents(jsonb);

create or replace function public.delete_dossier_documents(p_ids bigint[])
returns table(id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed_ids bigint[] := array[]::bigint[];
  removed_paths text[] := array[]::text[];
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return;
  end if;

  with removed as (
    delete from public.dossier_documents as d
    where d.id = any (p_ids)
      and private.user_can_access_dossier(d.dossier_id)
    returning d.id, d.storage_path
  )
  select
    coalesce(array_agg(removed.id), array[]::bigint[]),
    coalesce(
      array_agg(removed.storage_path) filter (where removed.storage_path is not null),
      array[]::text[]
    )
  into removed_ids, removed_paths
  from removed;

  if cardinality(removed_paths) > 0 then
    begin
      delete from storage.objects as obj
      where obj.bucket_id = 'dossier-documents'
        and obj.name = any (removed_paths);
    exception
      when others then
        null;
    end;
  end if;

  return query select unnest(removed_ids);
end;
$$;

revoke all on function public.delete_dossier_documents(bigint[]) from public, anon;
grant execute on function public.delete_dossier_documents(bigint[]) to authenticated, service_role;

comment on function public.delete_dossier_documents(bigint[]) is
  'Supprime des documents de dossier (ligne + fichier Storage) après contrôle d''accès cabinet.';

notify pgrst, 'reload schema';
