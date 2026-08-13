-- Corrige les policies RLS sur client_dossiers (récursion / FORCE RLS).
-- Symptôme : "new row violates row-level security policy for table client_dossiers"

drop policy if exists client_dossiers_select on public.client_dossiers;
drop policy if exists client_dossiers_insert on public.client_dossiers;
drop policy if exists client_dossiers_update on public.client_dossiers;
drop policy if exists client_dossiers_delete on public.client_dossiers;

create policy client_dossiers_select on public.client_dossiers
  for select to authenticated
  using (
    (select private.is_super_admin())
    or exists (
      select 1
      from public.cabinet_clients c
      join public.cabinet_members m on m.cabinet_id = c.cabinet_id
      where c.id = client_dossiers.client_id
        and m.user_id = auth.uid()
        and m.is_active = true
    )
  );

create policy client_dossiers_insert on public.client_dossiers
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.cabinet_clients c
      join public.cabinet_members m on m.cabinet_id = c.cabinet_id
      where c.id = client_id
        and m.user_id = auth.uid()
        and m.is_active = true
    )
  );

create policy client_dossiers_update on public.client_dossiers
  for update to authenticated
  using (
    exists (
      select 1
      from public.cabinet_clients c
      join public.cabinet_members m on m.cabinet_id = c.cabinet_id
      where c.id = client_dossiers.client_id
        and m.user_id = auth.uid()
        and m.is_active = true
    )
  )
  with check (
    exists (
      select 1
      from public.cabinet_clients c
      join public.cabinet_members m on m.cabinet_id = c.cabinet_id
      where c.id = client_id
        and m.user_id = auth.uid()
        and m.is_active = true
    )
  );

create policy client_dossiers_delete on public.client_dossiers
  for delete to authenticated
  using (
    exists (
      select 1
      from public.cabinet_clients c
      join public.cabinet_members m on m.cabinet_id = c.cabinet_id
      where c.id = client_dossiers.client_id
        and m.user_id = auth.uid()
        and m.is_active = true
    )
  );
