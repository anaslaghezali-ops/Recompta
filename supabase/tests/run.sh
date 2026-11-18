#!/usr/bin/env bash
# Rejoue toutes les migrations sur une base Postgres vierge puis lance les tests SQL.
# Usage : PGURL=postgres://postgres@localhost:5432/postgres supabase/tests/run.sh
set -euo pipefail
shopt -s nullglob
export PGOPTIONS="-c client_min_messages=warning"
cd "$(dirname "$0")/../.."
PSQL=(psql "${PGURL:?PGURL manquant}" -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -c "drop schema if exists public cascade; drop schema if exists private cascade; drop schema if exists auth cascade; drop schema if exists storage cascade; create schema public;"
"${PSQL[@]}" -f supabase/tests/00_supabase_stub.sql
for f in supabase/migrations/*.sql; do
  echo "migration $(basename "$f")"
  "${PSQL[@]}" -f "$f" >/dev/null
done
for t in supabase/tests/test_*.sql; do
  echo "test $(basename "$t")"
  "${PSQL[@]}" -f "$t"
done
for t in supabase/tests/test_*.sh; do
  [ -f "$t" ] || continue
  echo "test $(basename "$t")"
  bash "$t"
done
echo "tests SQL ok"
