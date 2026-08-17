-- DELETE client PostgREST + RLS peut renvoyer OK sans enlever aucune ligne.
-- RPC SECURITY DEFINER : vérifie l'accès dossier, puis supprime vraiment.

create or replace function public.delete_dossier_documents(p_ids bigint[])
returns bigint[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_ids bigint[];
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    return array[]::bigint[];
  end if;

  with removed as (
    delete from public.dossier_documents as d
    where d.id = any (p_ids)
      and private.user_can_access_dossier(d.dossier_id)
    returning d.id
  )
  select coalesce(array_agg(removed.id), array[]::bigint[])
    into deleted_ids
  from removed;

  return deleted_ids;
end;
$$;

revoke all on function public.delete_dossier_documents(bigint[]) from public, anon;
grant execute on function public.delete_dossier_documents(bigint[]) to authenticated, service_role;

comment on function public.delete_dossier_documents(bigint[]) is
  'Supprime des documents de dossier après contrôle d''accès cabinet. Retourne les id réellement effacés.';
