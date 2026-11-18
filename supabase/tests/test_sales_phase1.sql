-- Tests phase 1 « Ventes » : isolation RLS, cycle d'une facture importée,
-- paiements partiels, double import, reprise de numérotation, honoraires intacts.
-- Tout se déroule dans une transaction annulée.
\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------------------
-- Données : un cabinet, un responsable, un collaborateur attribué au client A,
-- deux clients A et B avec chacun un accès portail.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'manager@test.ma'),
  ('00000000-0000-0000-0000-0000000000a2', 'collab@test.ma'),
  ('00000000-0000-0000-0000-0000000000b1', 'portail-a@test.ma'),
  ('00000000-0000-0000-0000-0000000000b2', 'portail-b@test.ma');
insert into public.cabinets (id, name, slug) overriding system value values (9001, 'Cabinet Test', 'cabinet-test');
insert into public.cabinet_members (cabinet_id, user_id, role) values
  (9001, '00000000-0000-0000-0000-0000000000a1', 'owner'),
  (9001, '00000000-0000-0000-0000-0000000000a2', 'comptable');
insert into public.cabinet_clients (id, cabinet_id, name, ice) overriding system value values
  (9101, 9001, 'Société A', '001111111000011'),
  (9102, 9001, 'Société B', '002222222000022');
insert into public.client_assignments (client_id, user_id, cabinet_id) values
  (9101, '00000000-0000-0000-0000-0000000000a2', 9001);
insert into public.client_portal_access (client_id, cabinet_id, user_id) values
  (9101, 9001, '00000000-0000-0000-0000-0000000000b1'),
  (9102, 9001, '00000000-0000-0000-0000-0000000000b2');
insert into public.client_dossiers (id, client_id, period_year, period_month) overriding system value values
  (9201, 9101, 2026, 9);

create temporary table t_ids (k text primary key, v bigint);
grant all on t_ids to authenticated;

-- ---------------------------------------------------------------------------
-- Portail A : client, facture importée en brouillon, validation
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', false); end $$;
set role authenticated;

do $$
declare cust bigint; inv bigint; r record; failed boolean;
begin
  insert into public.client_customers (issuer_client_id, name, ice, payment_days)
  values (9101, 'Hôtel Atlas', '003333333000033', 45) returning id into cust;
  insert into t_ids values ('custA', cust);

  insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, total_ht, total_vat, total_ttc)
  values (9101, cust, 'uploaded', ' F-2026-101 ', date '2026-09-10', 1000, 200, 1200) returning id into inv;
  insert into t_ids values ('invA', inv);

  select * into r from public.invoices where id = inv;
  assert r.status = 'draft' and r.cabinet_id = 9001 and r.external_number = 'F-2026-101', 'brouillon créé';

  -- Brouillon modifiable
  update public.invoices set total_ht = 1000, total_vat = 200, total_ttc = 1200, notes = 'ok' where id = inv;

  -- Paiement interdit sur un brouillon
  failed := false;
  begin
    insert into public.invoice_payments (invoice_id, amount, paid_on) values (inv, 100, date '2026-09-20');
  exception when others then failed := true; end;
  assert failed, 'pas de paiement sur brouillon';

  -- Validation : échéance par défaut = délai du client (45 j)
  perform public.sales_validate_invoice(inv);
  select * into r from public.invoices where id = inv;
  assert r.status = 'issued' and r.validated_at is not null, 'validée';
  assert r.due_date = date '2026-10-25', format('échéance %s', r.due_date);
  assert r.seller_snapshot ->> 'legal_name' = 'Société A' and r.seller_snapshot ->> 'ice' = '001111111000011', 'nom et ICE depuis cabinet_clients';
  assert r.client_snapshot ->> 'name' = 'Hôtel Atlas', 'acheteur figé';

  -- Verrouillée après validation
  failed := false;
  begin update public.invoices set total_ttc = 1300 where id = inv; exception when others then failed := true; end;
  assert failed, 'validée : non modifiable';
  failed := false;
  begin delete from public.invoices where id = inv; exception when others then failed := true; end;
  assert failed, 'validée : non supprimable';
  -- … sauf les notes internes
  update public.invoices set notes = 'relancé par téléphone' where id = inv;

  -- Double import bloqué (espaces et casse ignorés)
  failed := false;
  begin
    insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, total_ht, total_vat, total_ttc)
    values (9101, cust, 'uploaded', 'f-2026-101', date '2026-09-11', 10, 2, 12);
  exception when unique_violation then failed := true; end;
  assert failed, 'double import bloqué';

  -- Paiement partiel puis total ; trop-perçu refusé
  insert into public.invoice_payments (invoice_id, amount, paid_on, method) values (inv, 400, date '2026-09-30', 'virement');
  select * into r from public.sales_invoices where id = inv;
  assert r.payment_status = 'partial' and r.paid_amount = 400 and r.balance = 800, 'partiel';
  failed := false;
  begin
    insert into public.invoice_payments (invoice_id, amount, paid_on, method) values (inv, 900, date '2026-10-05', 'cheque');
  exception when others then failed := true; end;
  assert failed, 'trop-perçu refusé';
  insert into public.invoice_payments (invoice_id, amount, paid_on, method) values (inv, 800, date '2026-10-05', 'cheque');
  select * into r from public.sales_invoices where id = inv;
  assert r.payment_status = 'paid' and r.balance = 0 and r.last_paid_on = date '2026-10-05', 'payée';
  assert (select issuer_client_id from public.invoice_payments where invoice_id = inv limit 1) = 9101, 'paiement rattaché à l''émetteur';

  -- Annulation impossible tant qu'il y a des paiements
  failed := false;
  begin perform public.sales_void_invoice(inv, 'erreur de montant'); exception when others then failed := true; end;
  assert failed, 'annulation refusée avec paiements';
  delete from public.invoice_payments where invoice_id = inv;
  failed := false;
  begin perform public.sales_void_invoice(inv, '  '); exception when others then failed := true; end;
  assert failed, 'motif obligatoire';
  perform public.sales_void_invoice(inv, 'erreur de montant');
  select * into r from public.invoices where id = inv;
  assert r.status = 'voided' and r.void_reason = 'erreur de montant' and r.voided_by is not null, 'annulation tracée';

  -- Après annulation : la même facture peut être ressaisie
  insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, total_ht, total_vat, total_ttc)
  values (9101, cust, 'uploaded', 'F-2026-101', date '2026-09-10', 1000, 200, 1200) returning id into inv;
  insert into t_ids values ('invA2', inv);

  -- En retard : échéance passée, rien payé
  insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, due_date, total_ht, total_vat, total_ttc)
  values (9101, cust, 'uploaded', 'F-2025-900', date '2025-11-01', date '2025-12-01', 500, 100, 600) returning id into inv;
  perform public.sales_validate_invoice(inv);
  select * into r from public.sales_invoices where id = inv;
  assert r.is_overdue and r.payment_status = 'unpaid' and r.days_overdue > 0, 'en retard';

  -- Montants incohérents refusés à la validation
  insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, total_ht, total_vat, total_ttc)
  values (9101, cust, 'uploaded', 'F-2026-102', date '2026-09-12', 100, 20, 130) returning id into inv;
  failed := false;
  begin perform public.sales_validate_invoice(inv); exception when others then failed := true; end;
  assert failed, 'HT + TVA ≠ TTC refusé';

  -- Le portail ne voit pas les honoraires et ne peut rien émettre au nom du cabinet
  failed := false;
  begin
    insert into public.invoices (cabinet_id, client_id) values (9001, 9101);
  exception when others then failed := true; end;
  assert failed, 'portail : pas de facture d''honoraires';
end $$;

-- Reprise de numérotation : dernier numéro 57 en 2026
do $$ begin perform public.sales_set_last_number(2026, 57); end $$;
reset role;

do $$
declare n record;
begin
  select * into n from private.billing_next_number_for(9001, 9101, 'invoice', 2026);
  assert n.seq = 58 and n.number = 'FAC-2026-0058', format('reprise série A : %s', n.number);
  select * into n from private.billing_next_number_for(9001, 9101, 'credit_note', 2026);
  assert n.seq = 59 and n.number = 'AV-2026-0059', format('série unique A (avoirs inclus) : %s', n.number);
  select * into n from private.billing_next_number_for(9001, 9102, 'invoice', 2026);
  assert n.seq = 1, 'série B indépendante';
  select * into n from private.billing_next_number(9001, 'invoice', 2026);
  assert n.seq = 1 and n.number = 'FAC-2026-0001', 'série honoraires indépendante';
  select * into n from private.billing_next_number(9001, 'credit_note', 2026);
  assert n.seq = 1 and n.number = 'AV-2026-0001', 'honoraires : avoirs dans leur propre série (inchangé)';
end $$;

-- ---------------------------------------------------------------------------
-- Portail B : ne voit et ne touche rien de A
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare failed boolean; inv_a bigint := (select v from t_ids where k = 'invA2'); cust_a bigint := (select v from t_ids where k = 'custA');
begin
  assert (select count(*) from public.invoices where issuer_client_id = 9101) = 0, 'B ne voit pas les factures de A';
  assert (select count(*) from public.sales_invoices) = 0, 'B : vue vide';
  assert (select count(*) from public.client_customers) = 0, 'B ne voit pas les clients de A';
  assert (select count(*) from public.invoice_payments) = 0, 'B ne voit pas les paiements de A';
  update public.invoices set notes = 'piraté' where id = inv_a;
  assert not found, 'B ne modifie pas A';

  failed := false;
  begin
    insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, total_ht, total_vat, total_ttc)
    values (9101, cust_a, 'uploaded', 'X-1', current_date, 1, 0, 1);
  exception when others then failed := true; end;
  assert failed, 'B ne crée pas de vente au nom de A';

  failed := false;
  begin insert into public.client_customers (issuer_client_id, name) values (9101, 'Intrus'); exception when others then failed := true; end;
  assert failed, 'B ne crée pas de client pour A';

  -- B ne peut pas utiliser un client de A sur sa propre facture
  failed := false;
  begin
    insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, total_ht, total_vat, total_ttc)
    values (9102, cust_a, 'uploaded', 'B-1', current_date, 1, 0, 1);
  exception when others then failed := true; end;
  assert failed, 'B ne peut pas facturer un client de A';

  failed := false;
  begin perform public.sales_validate_invoice(inv_a); exception when others then failed := true; end;
  assert failed, 'B ne valide pas une facture de A';

  failed := false;
  begin
    insert into public.invoice_payments (invoice_id, amount, paid_on) values (inv_a, 1, current_date);
  exception when others then failed := true; end;
  assert failed, 'B ne paie pas une facture de A';

  -- Stockage : B ne dépose pas dans le dossier de A
  failed := false;
  begin
    insert into storage.objects (bucket_id, name) values ('sales-documents', 'client/9101/x.pdf');
  exception when others then failed := true; end;
  assert failed, 'B ne dépose pas chez A';
  insert into storage.objects (bucket_id, name) values ('sales-documents', 'client/9102/facture.pdf');
end $$;
reset role;

-- ---------------------------------------------------------------------------
-- Cabinet : lecture des ventes, pas d'écriture ; honoraires inchangés
-- ---------------------------------------------------------------------------
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare inv bigint; r record; failed boolean; inv_a bigint := (select v from t_ids where k = 'invA2');
begin
  assert (select count(*) from public.sales_invoices where issuer_client_id = 9101) >= 2, 'responsable : lit les ventes de A';
  update public.invoices set notes = 'cabinet' where id = inv_a;
  assert not found, 'responsable : ne modifie pas les ventes';
  failed := false;
  begin perform public.billing_issue_invoice(inv_a); exception when others then failed := true; end;
  assert failed, 'émission honoraires refusée sur une vente';

  -- Honoraires : brouillon, ligne, émission, avoir (comme avant)
  insert into public.cabinet_billing_settings (cabinet_id, legal_name, address, ice, if_number)
  values (9001, 'Cabinet Test SARL', 'Casablanca', '009999999000099', '1234567');
  insert into public.invoices (cabinet_id, client_id) values (9001, 9102) returning id into inv;
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate) values (inv, 'Tenue', 1, 2000, 20);
  select * into r from public.billing_issue_invoice(inv);
  assert r.number = format('FAC-%s-%s', r.year, lpad((case when r.year = 2026 then 2 else 1 end)::text, 4, '0')),
    format('honoraires numérotés à la suite : %s', r.number);
  assert r.total_ttc = 2400, 'totaux honoraires';
  assert (select count(*) from public.invoices where issuer_client_id is null and cabinet_id = 9001) = 1, 'honoraires visibles';
  select * into r from public.billing_cancel_invoice(inv, 'test');
  assert r.kind = 'credit_note' and r.total_ttc = -2400, 'avoir honoraires';
end $$;
reset role;

-- Le portail A ne voit pas les honoraires du cabinet
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$ begin
  assert (select count(*) from public.invoices where issuer_client_id is null) = 0, 'portail : honoraires invisibles';
  assert (select count(*) from public.invoice_payments where issuer_client_id is null) = 0, 'portail : paiements honoraires invisibles';
  assert (select count(*) from public.billing_counters where issuer_client_id is null) = 0, 'portail : compteurs cabinet invisibles';
  -- Dépôt de sa propre pièce de vente : autorisé, et jamais dans dossier_documents
  insert into storage.objects (bucket_id, name) values ('sales-documents', 'client/9101/F-2026-101.pdf');
end $$;
reset role;

-- Collaborateur attribué à A seulement
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', false); end $$;
set role authenticated;
do $$ begin
  assert (select count(*) from public.sales_invoices where issuer_client_id = 9101) >= 2, 'collaborateur : voit A';
  assert (select count(*) from public.sales_invoices where issuer_client_id = 9102) = 0, 'collaborateur : ne voit pas B';
end $$;
reset role;

do $$ begin
  assert (select count(*) from public.dossier_documents) = 0, 'aucune pièce de vente dans dossier_documents';
  -- Simule une facture déjà numérotée par Recompta en 2027 (phase 2)
  perform set_config('recompta.billing_internal', 'on', true);
  insert into public.invoices (cabinet_id, issuer_client_id, customer_id, origin, status, year, seq, number, issue_date)
  values (9001, 9101, (select v from t_ids where k = 'custA'), 'created', 'issued', 2027, 1, 'FAC-2027-0001', date '2027-01-05');
  perform set_config('recompta.billing_internal', '', true);
end $$;
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$ declare failed boolean := false; begin
  begin perform public.sales_set_last_number(2027, 5); exception when others then failed := true; end;
  assert failed, 'reprise refusée une fois la série utilisée';
end $$;
reset role;

rollback;
\echo 'test_sales_phase1 ok'
