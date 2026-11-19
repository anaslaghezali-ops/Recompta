-- Tests phase 2 « Ventes » : facture créée multi-taux, mentions obligatoires,
-- numérotation (reprise, série unique factures + avoirs, devis à part), avoir,
-- devis → facture, lien public, catalogue, isolation.
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000002b1', 'p2-portail-a@test.ma'),
  ('00000000-0000-0000-0000-0000000002b2', 'p2-portail-b@test.ma');
insert into public.cabinets (id, name, slug) overriding system value values (9301, 'Cabinet P2', 'cabinet-p2');
insert into public.cabinet_clients (id, cabinet_id, name, ice) overriding system value values
  (9311, 9301, 'Société A P2', '005555555000055'),
  (9312, 9301, 'Société B P2', '006666666000066');
insert into public.client_portal_access (client_id, cabinet_id, user_id) values
  (9311, 9301, '00000000-0000-0000-0000-0000000002b1'),
  (9312, 9301, '00000000-0000-0000-0000-0000000002b2');
create temporary table t2 (k text primary key, v bigint, s text);
grant all on t2 to authenticated, anon;

do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000002b1","role":"authenticated"}', false); end $$;
set role authenticated;

do $$
declare cust bigint; inv bigint; q bigint; r record; failed boolean; tok text; doc jsonb; item bigint;
  move_draft_a bigint; move_draft_b bigint; move_line bigint;
begin
  insert into public.client_customers (issuer_client_id, name, ice, payment_days)
  values (9311, 'Client P2', '007777777000077', 60) returning id into cust;
  insert into t2 (k, v) values ('cust', cust);

  -- Catalogue
  insert into public.client_items (issuer_client_id, label, unit_price_ht, vat_rate) values (9311, 'Prestation', 1000, 20) returning id into item;
  failed := false;
  begin insert into public.client_items (issuer_client_id, label, vat_rate) values (9311, 'X', 18); exception when others then failed := true; end;
  assert failed, 'taux non marocain refusé au catalogue';

  -- Facture créée multi-taux
  insert into public.invoices (issuer_client_id, customer_id, origin, issue_date) values (9311, cust, 'created', date '2026-11-10') returning id into inv;
  insert into t2 (k, v) values ('inv', inv);
  insert into public.invoice_lines (invoice_id, position, label, quantity, unit_price_ht, vat_rate) values
    (inv, 1, 'Prestation', 2, 1000, 20), (inv, 2, 'Transport', 1, 500, 14), (inv, 3, 'Formation', 1, 300, 0);
  failed := false;
  begin insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate) values (inv, 'Y', 1, 1, 18); exception when others then failed := true; end;
  assert failed, 'taux non marocain refusé en ligne';
  select * into r from public.invoices where id = inv;
  assert r.total_ht = 2800 and r.total_vat = 470 and r.total_ttc = 3270, format('totaux multi-taux %s %s %s', r.total_ht, r.total_vat, r.total_ttc);

  -- Mentions manquantes : émission refusée
  failed := false;
  begin perform public.sales_issue_invoice(inv); exception when others then failed := true; end;
  assert failed, 'mentions obligatoires exigées';
  insert into public.client_billing_settings (client_id, address, if_number, rc_number, tp_number, legal_form, capital, rib, invoice_prefix, logo_data)
  values (9311, '12 rue Test, Casablanca', '11223344', '445566', '55667788', 'SARL', '100 000 DH', '011780000012345678901234', 'FA', 'data:image/png;base64,AAAA');

  -- Reprise de la série : dernier numéro 41
  perform public.sales_set_last_number(2026, 41);
  select * into r from public.sales_issue_invoice(inv);
  assert r.number = 'FA-2026-0042' and r.seq = 42, format('numéro %s', r.number);
  assert r.due_date = date '2027-01-09', format('échéance client 60 j : %s', r.due_date);
  assert r.seller_snapshot ->> 'legal_name' = 'Société A P2' and r.seller_snapshot ->> 'rc_number' = '445566', 'mentions figées';
  assert not (r.seller_snapshot ? 'logo_data'), 'logo hors mentions figées';

  -- Verrouillée après émission
  failed := false;
  begin update public.invoice_lines set quantity = 3 where invoice_id = inv; exception when others then failed := true; end;
  assert failed, 'lignes verrouillées';
  failed := false;
  begin update public.invoices set share_token = repeat('x', 64) where id = inv; exception when others then failed := true; end;
  assert failed, 'jeton non modifiable à la main';

  -- Déplacement interdit depuis une facture émise vers un brouillon
  insert into public.invoices (issuer_client_id, customer_id, origin, issue_date)
  values (9311, cust, 'created', date '2026-11-11') returning id into move_draft_a;
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate)
  values (move_draft_a, 'Brouillon cible', 1, 100, 20);
  select id into move_line from public.invoice_lines where invoice_id = inv order by id limit 1;
  failed := false;
  begin
    update public.invoice_lines set invoice_id = move_draft_a where id = move_line;
  exception when others then failed := true;
  end;
  assert failed, 'ligne d''une facture émise impossible à déplacer vers un brouillon';
  assert (select invoice_id = inv from public.invoice_lines where id = move_line), 'ligne émise conservée sur sa facture';
  assert (select total_ttc = 120 from public.invoices where id = move_draft_a), 'total du brouillon cible inchangé après refus';

  -- Déplacement entre deux brouillons : recalcul des deux factures
  insert into public.invoices (issuer_client_id, customer_id, origin, issue_date)
  values (9311, cust, 'created', date '2026-11-11') returning id into move_draft_a;
  insert into public.invoices (issuer_client_id, customer_id, origin, issue_date)
  values (9311, cust, 'created', date '2026-11-11') returning id into move_draft_b;
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate)
  values (move_draft_a, 'Ligne mobile', 1, 100, 20);
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate)
  values (move_draft_b, 'Ligne conservée', 1, 50, 20);
  select id into move_line from public.invoice_lines
  where invoice_id = move_draft_a and label = 'Ligne mobile';
  update public.invoice_lines set invoice_id = move_draft_b where id = move_line;
  assert (select total_ttc = 0 from public.invoices where id = move_draft_a), 'ancien brouillon recalculé après déplacement';
  assert (select total_ttc = 180 from public.invoices where id = move_draft_b), 'nouveau brouillon recalculé après déplacement';

  -- Un brouillon qui contient des lignes peut être supprimé (cascade des lignes)
  failed := false;
  begin delete from public.invoices where id = move_draft_b; exception when others then failed := true; end;
  assert not failed, 'brouillon avec lignes supprimable';
  assert (select count(*) = 0 from public.invoice_lines where invoice_id = move_draft_b), 'lignes du brouillon supprimées';
  -- …mais pas une facture émise ni ses lignes
  failed := false;
  begin delete from public.invoices where id = inv; exception when others then failed := true; end;
  assert failed, 'facture émise non supprimable';
  failed := false;
  begin delete from public.invoice_lines where invoice_id = inv; exception when others then failed := true; end;
  assert failed, 'lignes émises non supprimables';

  -- Lien public
  tok := public.sales_share_token(inv);
  assert length(tok) = 64, 'jeton 64 caractères';
  assert public.sales_share_token(inv) = tok, 'jeton stable';
  insert into t2 (k, s) values ('tok', tok);

  -- Devis : série propre, transformation en facture
  insert into public.invoices (issuer_client_id, customer_id, kind, issue_date) values (9311, cust, 'quote', date '2026-11-12') returning id into q;
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate) values (q, 'Étude', 1, 5000, 20);
  select * into r from public.sales_issue_invoice(q);
  assert r.kind = 'quote' and r.number = 'DEV-2026-0001', format('devis %s', r.number);
  assert r.due_date = date '2026-12-12', 'validité 30 jours';
  failed := false;
  begin insert into public.invoice_payments (invoice_id, amount) values (q, 10); exception when others then failed := true; end;
  assert failed, 'pas de paiement sur un devis';
  inv := public.sales_convert_quote(q);
  select * into r from public.invoices where id = inv;
  assert r.status = 'draft' and r.kind = 'invoice' and r.source_quote_id = q and r.total_ttc = 6000, 'devis → facture brouillon';
  failed := false;
  begin perform public.sales_convert_quote(q); exception when others then failed := true; end;
  assert failed, 'pas de double transformation';
  select * into r from public.sales_issue_invoice(inv);
  assert r.number = 'FA-2026-0043', format('suite de série %s', r.number);
  insert into t2 (k, v) values ('inv2', inv);
  assert (select converted_invoice_id = inv from public.sales_invoices where kind = 'quote' and number = 'DEV-2026-0001'), 'lien devis → facture';

  -- Avoir : même série, facture annulée
  failed := false;
  begin perform public.sales_credit_invoice(inv, ''); exception when others then failed := true; end;
  assert failed, 'motif obligatoire';
  select * into r from public.sales_credit_invoice(inv, 'Erreur de prix');
  assert r.kind = 'credit_note' and r.number = 'AV-2026-0044' and r.total_ttc = -6000, format('avoir %s %s', r.number, r.total_ttc);
  assert (select status from public.invoices where id = inv) = 'cancelled', 'facture annulée par avoir';
  assert (select count(*) from public.invoice_lines where invoice_id = r.id) = 1, 'lignes de l''avoir';

  -- Devis refusé
  insert into public.invoices (issuer_client_id, customer_id, kind) values (9311, cust, 'quote') returning id into q;
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate) values (q, 'Autre', 1, 100, 20);
  perform public.sales_issue_invoice(q);
  perform public.sales_refuse_quote(q);
  assert (select status from public.invoices where id = q) = 'cancelled', 'devis refusé';

  -- Vue : devis et avoirs hors encours
  assert (select count(*) from public.sales_invoices where kind = 'quote' and balance <> 0) = 0, 'devis sans solde';
end $$;
reset role;

-- Lien public : lisible sans compte, rien d'autre
set role anon;
do $$
declare doc jsonb; tok text := (select s from t2 where k = 'tok');
begin
  doc := public.sales_public_document(tok);
  assert doc ->> 'number' = 'FA-2026-0042', 'document public';
  assert jsonb_array_length(doc -> 'lines') = 3, 'lignes publiques';
  assert doc ->> 'logo_data' like 'data:image/%', 'logo public';
  assert public.sales_public_document('court') is null, 'jeton court refusé';
  assert public.sales_public_document(repeat('a', 64)) is null, 'jeton inconnu';
end $$;
reset role;

-- Document annulé : toujours lisible par son lien, avec son statut (mention « Annulée »)
do $$ begin
  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices set status = 'cancelled' where share_token = (select s from t2 where k = 'tok');
end $$;
set role anon;
do $$
declare doc jsonb := public.sales_public_document((select s from t2 where k = 'tok'));
begin
  assert doc is not null, 'document annulé encore lisible';
  assert doc ->> 'status' = 'cancelled', 'statut annulé transmis';
end $$;
reset role;
do $$ begin
  perform set_config('recompta.billing_internal', 'on', true);
  update public.invoices set status = 'issued' where share_token = (select s from t2 where k = 'tok');
end $$;

-- Société B : ne voit pas le catalogue ni les documents de A, ne peut rien émettre pour A
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000002b2","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare failed boolean; inv bigint := (select v from t2 where k = 'inv2');
begin
  assert (select count(*) from public.client_items) = 0, 'B : catalogue de A invisible';
  assert (select count(*) from public.sales_invoices) = 0, 'B : documents de A invisibles';
  failed := false;
  begin perform public.sales_share_token(inv); exception when others then failed := true; end;
  assert failed, 'B : pas de lien sur un document de A';
  failed := false;
  begin perform public.sales_credit_invoice(inv, 'x'); exception when others then failed := true; end;
  assert failed, 'B : pas d''avoir sur A';
  failed := false;
  begin perform public.sales_set_last_number(2027, 3); exception when others then failed := true; end;
  assert not failed, 'B : sa propre reprise de série reste possible';
end $$;
reset role;

rollback;
\echo 'test_sales_phase2 ok'
