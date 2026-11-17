-- Durcissement des droits d'exécution (avis de sécurité Supabase, 17/11/2026)
--
-- * cabinet_id_for_dossier : aucune vérification d'accès ; utilisée uniquement
--   par le serveur Python avec la clé service_role -> fermée aux rôles publics.
-- * Fonctions admin et de crédits : elles contrôlent déjà l'appelant, mais
--   n'ont aucune raison d'être appelables sans connexion -> retirées à anon.
-- * workspace_anomaly_count : search_path figé.

revoke execute on function public.cabinet_id_for_dossier(bigint) from public, anon, authenticated;
grant execute on function public.cabinet_id_for_dossier(bigint) to service_role;

revoke execute on function public.admin_get_vision_credits_settings() from public, anon;
revoke execute on function public.admin_list_cabinet_vision_credits() from public, anon;
revoke execute on function public.admin_set_cabinet_vision_quota(bigint, integer) from public, anon;
revoke execute on function public.admin_set_vision_credits_default(integer) from public, anon;
revoke execute on function public.get_my_vision_credits() from public, anon;
revoke execute on function public.get_workspace_cockpit(bigint) from public, anon;
revoke execute on function public.delete_dossier_documents(bigint[]) from public, anon;

grant execute on function public.admin_get_vision_credits_settings() to authenticated, service_role;
grant execute on function public.admin_list_cabinet_vision_credits() to authenticated, service_role;
grant execute on function public.admin_set_cabinet_vision_quota(bigint, integer) to authenticated, service_role;
grant execute on function public.admin_set_vision_credits_default(integer) to authenticated, service_role;
grant execute on function public.get_my_vision_credits() to authenticated, service_role;
grant execute on function public.get_workspace_cockpit(bigint) to authenticated, service_role;
grant execute on function public.delete_dossier_documents(bigint[]) to authenticated, service_role;

alter function private.workspace_anomaly_count(jsonb) set search_path = '';
