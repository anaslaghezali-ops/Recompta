-- Jeu de test volume — AUCUNE extraction IA, 0 token.
-- Collez dans https://supabase.com/dashboard/project/pbyoxfxngfutoiqjirkx/sql/new
-- Utilise le dossier le plus récemment modifié. Pour forcer un id : changez la ligne target.

-- Voir les dossiers existants (l'id 123 n'existe pas — c'était un exemple)
-- select id, client_id, period_year, period_month, status from public.client_dossiers order by updated_at desc;

with target as (
  select id
  from public.client_dossiers
  order by updated_at desc
  limit 1
),
fake_lines as (
  select coalesce(jsonb_agg(line), '[]'::jsonb) as lines
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
fake_bank as (
  select coalesce(jsonb_agg(op), '[]'::jsonb) as bank
  from (
    select jsonb_build_object(
      'date', '2026-08-01',
      'label', 'Virement test ' || n,
      'amount', -120
    ) as op
    from generate_series(1, 120) as n
  ) t
)
insert into public.dossier_workspaces (dossier_id, lines, bank_transactions, bank_meta, updated_at)
select
  target.id,
  fake_lines.lines,
  fake_bank.bank,
  '{"filename":"releve-test-fictif.csv","bankName":"TEST"}'::jsonb,
  now()
from target, fake_lines, fake_bank
where target.id is not null
on conflict (dossier_id) do update
set
  lines = excluded.lines,
  bank_transactions = excluded.bank_transactions,
  bank_meta = excluded.bank_meta,
  updated_at = now();

-- Vérifier les résumés (400 / 120 / 40) sur le dossier ciblé
select w.dossier_id, w.line_count, w.bank_count, w.anomaly_count,
       pg_column_size(w.lines) as lines_bytes,
       pg_column_size(w.bank_transactions) as bank_bytes
from public.dossier_workspaces w
join public.client_dossiers d on d.id = w.dossier_id
order by w.updated_at desc
limit 1;
