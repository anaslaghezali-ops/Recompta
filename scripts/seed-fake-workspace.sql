-- Jeu de test volume — AUCUNE extraction IA, 0 token.
-- 1. Remplacez 123 par l'id d'un dossier existant (client_dossiers.id)
-- 2. Collez dans https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new
-- 3. Rechargez dossiers.html (Ctrl+Shift+R)

-- 400 factures fictives + 120 ops banque, 1 anomalie / 10 lignes
insert into public.dossier_workspaces (dossier_id, lines, bank_transactions, bank_meta, updated_at)
values (
  123,
  (
    select coalesce(jsonb_agg(line), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'fact_num', 'FAKE-' || lpad(n::text, 5, '0'),
        'lib_frss', 'FOURNISSEUR TEST ' || n,
        'ice_frs', case when n % 10 = 0 then '' else '000000000000001' end,
        'designation', 'MATIERES CONSOMMABLES',
        'm_ht', 100, 'tva', 20, 'm_ttc', 120, 'taux', 0.2,
        'date_fac', '2026-08-01',
        'field_confidence', jsonb_build_object(
          'fact_num', jsonb_build_object('level', 'ok', 'reason', 'Présent'),
          'lib_frss', jsonb_build_object('level', 'ok', 'reason', 'Présent'),
          'ice_frs', case when n % 10 = 0
            then jsonb_build_object('level', 'error', 'reason', 'ICE manquant (jeu de test)')
            else jsonb_build_object('level', 'ok', 'reason', 'Présent')
          end,
          'date_paie', jsonb_build_object('level', 'warn', 'reason', 'Date de paiement absente')
        )
      ) as line
      from generate_series(1, 400) as n
    ) t
  ),
  (
    select coalesce(jsonb_agg(op), '[]'::jsonb)
    from (
      select jsonb_build_object(
        'date', '2026-08-01',
        'label', 'Virement test ' || n,
        'amount', -120
      ) as op
      from generate_series(1, 120) as n
    ) t
  ),
  '{"filename":"releve-test-fictif.csv","bankName":"TEST"}'::jsonb,
  now()
)
on conflict (dossier_id) do update
set
  lines = excluded.lines,
  bank_transactions = excluded.bank_transactions,
  bank_meta = excluded.bank_meta,
  updated_at = now();

-- Vérifier les résumés (doit afficher 400 / 120 / 40)
select dossier_id, line_count, bank_count, anomaly_count,
       pg_column_size(lines) as lines_bytes,
       pg_column_size(bank_transactions) as bank_bytes
from public.dossier_workspaces
where dossier_id = 123;
