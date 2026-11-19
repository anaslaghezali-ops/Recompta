-- Tests « Tous les documents » / « Archives » : archive_overview et lecture
-- des fichiers par le portail. Transaction annulée.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'manager-arch@test.ma'),
  ('00000000-0000-0000-0000-0000000000c2', 'collab-arch@test.ma'),
  ('00000000-0000-0000-0000-0000000000d1', 'portail-arch-a@test.ma'),
  ('00000000-0000-0000-0000-0000000000d2', 'portail-arch-b@test.ma');
insert into public.cabinets (id, name, slug) overriding system value values (9501, 'Cabinet Archives', 'cabinet-archives');
insert into public.cabinet_members (cabinet_id, user_id, role) values
  (9501, '00000000-0000-0000-0000-0000000000c1', 'owner'),
  (9501, '00000000-0000-0000-0000-0000000000c2', 'comptable');
insert into public.cabinet_clients (id, cabinet_id, name, ice) overriding system value values
  (9601, 9501, 'Archives A', '004444444000044'),
  (9602, 9501, 'Archives B', '005555555000055');
insert into public.client_portal_access (client_id, cabinet_id, user_id) values
  (9601, 9501, '00000000-0000-0000-0000-0000000000d1'),
  (9602, 9501, '00000000-0000-0000-0000-0000000000d2');
insert into public.client_dossiers (id, client_id, period_year, period_month) overriding system value values
  (9701, 9601, 2026, 8), (9702, 9601, 2026, 9), (9703, 9602, 2026, 9);
insert into public.dossier_documents (id, dossier_id, doc_type, original_filename, storage_path, size_bytes, source_id, extraction_status)
  overriding system value values
  (9801, 9701, 'invoice', 'achibest-aout.pdf', 'dossier/9701/a_achibest.pdf', 1000, 'src-1', 'done'),
  (9802, 9702, 'invoice', 'achibest-sept.pdf', 'dossier/9702/b_achibest.pdf', 2000, 'src-1', 'done'),
  (9803, 9702, 'invoice', 'menu-resto.pdf', 'dossier/9702/c_menu.pdf', 500, null, 'ignored'),
  (9804, 9702, 'bank', 'releve-sept.pdf', 'dossier/9702/d_releve.pdf', 800, null, null),
  (9805, 9703, 'invoice', 'autre-client.pdf', 'dossier/9703/e_autre.pdf', 100, null, null);
insert into public.dossier_workspaces (dossier_id, lines) values
  (9701, '[{"source_id":"src-1","lib_frss":"ACHI-BEST FOOD","ice_frs":"001234567000089","fact_num":"FV-1","date_fac":"2026-08-03","date_paie":"2026-08-20","m_ht":100,"tva":20,"m_ttc":120,"taux":0.2,"field_confidence":{"x":1},"note_interne":"secret"}]'),
  (9702, '[{"source_id":"src-1","lib_frss":"Achibest","ice_frs":"001234567000089","fact_num":"FV-2","date_fac":"2026-09-03","m_ht":200,"tva":40,"m_ttc":240,"taux":0.2},
           {"lib_frss":"SAHAM BANK","source_file":"releve-sept.pdf","_from_bank":true,"m_ttc":15}]'),
  (9703, '[{"lib_frss":"Fournisseur B","m_ttc":10}]');

-- Cabinet (responsable) : tout, y compris le document écarté.
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare r jsonb;
begin
  r := public.archive_overview(9601);
  assert jsonb_array_length(r -> 'documents') = 4, format('cabinet : 4 documents, %s', jsonb_array_length(r -> 'documents'));
  assert jsonb_array_length(r -> 'lines') = 3, 'cabinet : 3 lignes';
  assert (select count(*) from jsonb_array_elements(r -> 'documents') d where d ->> 'extraction_status' = 'ignored') = 1, 'écarté visible au cabinet';
  assert (select bool_and(d ? 'period_month') from jsonb_array_elements(r -> 'documents') d), 'période jointe';
  assert not exists (select 1 from jsonb_array_elements(r -> 'lines') l where l ? 'note_interne' or l ? 'field_confidence'), 'lignes réduites';
  assert (select count(*) from jsonb_array_elements(r -> 'lines') l where (l ->> 'from_bank')::boolean) = 1, 'ligne banque marquée';
end $$;
reset role;

-- Collaborateur sans attribution : refusé.
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare failed boolean := false;
begin
  begin perform public.archive_overview(9601); exception when others then failed := true; end;
  assert failed, 'collaborateur non attribué refusé';
end $$;
reset role;

-- Portail A : sa société, sans le document écarté ; pas la société B.
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare r jsonb; failed boolean := false;
begin
  r := public.archive_overview(9601);
  assert jsonb_array_length(r -> 'documents') = 3, format('portail : 3 documents, %s', jsonb_array_length(r -> 'documents'));
  assert not exists (select 1 from jsonb_array_elements(r -> 'documents') d where d ->> 'extraction_status' = 'ignored'), 'écarté masqué au portail';
  begin perform public.archive_overview(9602); exception when others then failed := true; end;
  assert failed, 'portail : autre société refusée';
  assert private.portal_can_read_document('dossier/9702/b_achibest.pdf'), 'fichier lisible';
  assert not private.portal_can_read_document('dossier/9702/c_menu.pdf'), 'fichier écarté illisible';
  assert not private.portal_can_read_document('dossier/9703/e_autre.pdf'), 'fichier autre société illisible';
end $$;
reset role;

-- Anonyme : aucun droit d'exécution.
do $$
declare failed boolean := false;
begin
  set local role anon;
  begin perform public.archive_overview(9601); exception when others then failed := true; end;
  reset role;
  assert failed, 'anon refusé';
end $$;

rollback;
