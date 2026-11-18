-- Tests phases 3 à 5 « Ventes » : relances, TVA collectée (encaissement / débit),
-- encaissements depuis le relevé (traçables, annulables, sans doublon).
\set ON_ERROR_STOP 1
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000003a1', 'p3-manager@test.ma'),
  ('00000000-0000-0000-0000-0000000003b1', 'p3-portail-a@test.ma'),
  ('00000000-0000-0000-0000-0000000003b2', 'p3-portail-b@test.ma');
insert into public.cabinets (id, name, slug) overriding system value values (9401, 'Cabinet P3', 'cabinet-p3');
insert into public.cabinet_members (cabinet_id, user_id, role) values (9401, '00000000-0000-0000-0000-0000000003a1', 'owner');
insert into public.cabinet_clients (id, cabinet_id, name, ice) overriding system value values
  (9411, 9401, 'Société A P3', '008888888000088'),
  (9412, 9401, 'Société B P3', '009999999000099');
insert into public.client_portal_access (client_id, cabinet_id, user_id) values
  (9411, 9401, '00000000-0000-0000-0000-0000000003b1'),
  (9412, 9401, '00000000-0000-0000-0000-0000000003b2');
insert into public.client_dossiers (id, client_id, period_year, period_month) overriding system value values (9421, 9411, 2026, 10);
insert into public.client_billing_settings (client_id, address, if_number, rc_number, tp_number) values (9411, 'Casa', '1', '2', '3');
create temporary table t3 (k text primary key, v bigint);
grant all on t3 to authenticated;

-- Portail A : une facture de septembre (multi-taux) payée en deux fois, en septembre puis en octobre
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000003b1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare cust bigint; inv bigint; up bigint; r record; failed boolean;
begin
  insert into public.client_customers (issuer_client_id, name, ice) values (9411, 'Client Sept', '001010101000010') returning id into cust;
  insert into t3 values ('cust', cust);
  insert into public.invoices (issuer_client_id, customer_id, origin, issue_date, due_date)
  values (9411, cust, 'created', date '2026-09-15', date '2026-09-30') returning id into inv;
  insert into public.invoice_lines (invoice_id, label, quantity, unit_price_ht, vat_rate) values
    (inv, 'Produit', 1, 1000, 20), (inv, 'Transport', 1, 1000, 14);
  perform public.sales_issue_invoice(inv);                -- TTC 2340
  insert into t3 values ('inv', inv);
  insert into public.invoice_payments (invoice_id, amount, paid_on) values (inv, 1170, date '2026-09-20');

  -- Facture faite ailleurs, octobre, non payée
  insert into public.invoices (issuer_client_id, customer_id, origin, external_number, issue_date, due_date, total_ht, total_vat, total_ttc)
  values (9411, cust, 'uploaded', 'EXT-1', date '2026-10-05', date '2026-10-10', 500, 100, 600) returning id into up;
  perform public.sales_validate_invoice(up);
  insert into t3 values ('up', up);

  -- Relances (phase 3)
  insert into public.sales_reminders (invoice_id, level, channel, message) values (inv, 1, 'email', 'Bonjour…');
  insert into public.sales_reminders (invoice_id, level, channel, message) values (inv, 2, 'copie', 'Relance 2');
  select * into r from public.sales_invoices where id = inv;
  assert r.reminder_count = 2 and r.last_reminder_level = 2, 'historique des relances';
  failed := false;
  begin update public.sales_reminders set message = 'x' where invoice_id = inv; exception when others then failed := true; end;
  assert failed or not found, 'relance non modifiable';
  failed := false;
  begin delete from public.sales_reminders where invoice_id = inv; exception when others then failed := true; end;
  assert (select count(*) from public.sales_reminders where invoice_id = inv) = 2, 'relance non supprimable';
end $$;
reset role;

-- B ne voit pas les relances de A et ne peut pas en créer
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000003b2","role":"authenticated"}', false); end $$;
set role authenticated;
do $$ declare failed boolean := false; begin
  assert (select count(*) from public.sales_reminders) = 0, 'B : relances de A invisibles';
  begin insert into public.sales_reminders (invoice_id, channel) values ((select v from t3 where k = 'inv'), 'email'); exception when others then failed := true; end;
  assert failed, 'B : pas de relance sur A';
  assert (select count(*) from public.sales_collected_detail(9411, 2026, 9)) = 0, 'B : TVA de A invisible';
end $$;
reset role;

-- Cabinet : TVA collectée (encaissement), paiement octobre depuis le relevé
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000003a1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$
declare inv bigint := (select v from t3 where k = 'inv'); up bigint := (select v from t3 where k = 'up');
        v numeric; n int; failed boolean; pid bigint;
begin
  -- Septembre : moitié payée → moitié de la TVA (200 × 0,5 + 140 × 0,5 = 170)
  select sum(vat) into v from public.sales_collected_detail(9411, 2026, 9);
  assert v = 170, format('TVA septembre encaissement : %s', v);
  assert (select count(*) from public.sales_collected_detail(9411, 2026, 9)) = 2, 'ventilation par taux';

  -- Octobre : encaissement du solde depuis le relevé (phase 5)
  insert into public.invoice_payments (invoice_id, amount, paid_on, method, source, bank_ref, bank_label, bank_dossier_id)
  values (inv, 1170, date '2026-10-08', 'virement', 'bank', '2026-10-08|1170.00|VIR CLIENT SEPT|1', 'VIR CLIENT SEPT', 9421) returning id into pid;
  -- Réimport du même relevé : refusé (pas de doublon)
  failed := false;
  begin
    insert into public.invoice_payments (invoice_id, amount, paid_on, source, bank_ref)
    values (inv, 1, date '2026-10-08', 'bank', '2026-10-08|1170.00|VIR CLIENT SEPT|1');
  exception when others then failed := true; end;
  assert failed, 'même ligne de relevé : pas de second paiement';
  -- Le cabinet ne peut pas saisir un paiement « manuel » à la place du client
  failed := false;
  begin insert into public.invoice_payments (invoice_id, amount, paid_on) values (up, 10, date '2026-10-09'); exception when others then failed := true; end;
  assert failed, 'cabinet : seulement des encaissements issus du relevé';

  -- Facture de septembre payée en octobre → TVA d'octobre
  select sum(vat) into v from public.sales_collected_detail(9411, 2026, 10);
  assert v = 170, format('TVA octobre (solde de septembre) : %s', v);
  assert (select bool_and(paid_on = date '2026-10-08') from public.sales_collected_detail(9411, 2026, 10)), 'date d''encaissement';
  assert (select payment_status from public.sales_invoices where id = inv) = 'paid', 'payée après relevé';

  -- Annulation d'un encaissement issu du relevé : tracé puis retiré
  delete from public.invoice_payments where id = pid;
  assert found, 'cabinet : annulation d''un encaissement du relevé';
  assert (select coalesce(sum(vat), 0) from public.sales_collected_detail(9411, 2026, 10)) = 0, 'TVA retirée après annulation';

  -- Paiement groupé : un virement règle deux factures (même bank_ref, deux lignes)
  insert into public.invoice_payments (invoice_id, amount, paid_on, source, bank_ref) values
    (inv, 1170, date '2026-10-12', 'bank', '2026-10-12|1770.00|VIR GROUPE|1'),
    (up, 600, date '2026-10-12', 'bank', '2026-10-12|1770.00|VIR GROUPE|1');
  select count(*) into n from public.invoice_payments where bank_ref = '2026-10-12|1770.00|VIR GROUPE|1';
  assert n = 2, 'virement groupé';
  select sum(vat) into v from public.sales_collected_detail(9411, 2026, 10);
  assert v = 270, format('TVA octobre avec la facture ajoutée : %s', v);
end $$;
reset role;

-- Régime débit : la TVA suit la date de facture
update public.cabinet_clients set vat_regime = 'debit' where id = 9411;
do $$ begin perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000003a1","role":"authenticated"}', false); end $$;
set role authenticated;
do $$ declare v numeric; begin
  select sum(vat) into v from public.sales_collected_detail(9411, 2026, 9);
  assert v = 340, format('débit septembre : %s', v);
  select sum(vat) into v from public.sales_collected_detail(9411, 2026, 10);
  assert v = 100, format('débit octobre : %s', v);
end $$;
reset role;

rollback;
\echo 'test_sales_phase345 ok'
