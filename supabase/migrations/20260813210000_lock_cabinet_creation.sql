-- Seul le super-admin peut créer des cabinets (défense en profondeur).
-- Les comptes cabinet sont créés via l'Edge Function admin-create-cabinet (service_role).

drop policy if exists cabinets_insert on public.cabinets;
create policy cabinets_insert on public.cabinets
  for insert to authenticated
  with check ((select private.is_super_admin()));

-- Empêcher un cabinet owner d'ajouter des membres ou des cabinets
drop policy if exists cabinet_members_insert on public.cabinet_members;
create policy cabinet_members_insert on public.cabinet_members
  for insert to authenticated
  with check ((select private.is_super_admin()));

comment on table public.cabinets is
  'Cabinets comptables. Création réservée au super-admin (page admin ou Edge Function).';
