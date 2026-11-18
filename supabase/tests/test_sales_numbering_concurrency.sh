#!/usr/bin/env bash
# Numérotation sous accès concurrent : 40 transactions simultanées demandent un
# numéro pour la même société ; on attend 1..40 sans trou ni doublon.
# Les données de test sont créées puis supprimées (base de test uniquement).
set -euo pipefail
PSQL=(psql "${PGURL:?PGURL manquant}" -v ON_ERROR_STOP=1 -q -X -At)
N=40

"${PSQL[@]}" <<'SQL'
insert into public.cabinets (id, name, slug) overriding system value values (9501, 'Cabinet Concurrence', 'cabinet-concurrence');
insert into public.cabinet_clients (id, cabinet_id, name, ice) overriding system value
  values (9601, 9501, 'Société Concurrence', '004444444000044');
create table public.t_numbers (seq integer, number text);
SQL

for i in $(seq 1 "$N"); do
  "${PSQL[@]}" -c "begin;
    insert into public.t_numbers select n.seq, n.number from private.billing_next_number_for(9501, 9601, 'invoice', 2026) n;
    select pg_sleep(random() * 0.2);
    commit;" >/dev/null &
done
wait

result="$("${PSQL[@]}" -c "select count(*), count(distinct seq), min(seq), max(seq) from public.t_numbers")"
"${PSQL[@]}" <<'SQL'
drop table public.t_numbers;
delete from public.billing_counters where issuer_client_id = 9601;
delete from public.cabinet_clients where id = 9601;
delete from public.cabinets where id = 9501;
SQL

if [ "$result" != "$N|$N|1|$N" ]; then
  echo "numérotation concurrente KO : $result (attendu $N|$N|1|$N)" >&2
  exit 1
fi
echo "test_sales_numbering_concurrency ok ($N numéros, sans trou ni doublon)"
