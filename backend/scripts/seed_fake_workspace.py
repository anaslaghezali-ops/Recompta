#!/usr/bin/env python3
"""
Injecte un gros workspace fictif (sans extraction IA, 0 token).

Usage :
  python backend/scripts/seed_fake_workspace.py --dossier-id 123 --lines 400 --bank 120

Sans identifiants Supabase, imprime le SQL à coller dans le SQL Editor.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
import httpx
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))

from workspace_summary import (
    build_fake_bank_transactions,
    build_fake_invoice_lines,
    count_anomalies_from_stored_confidence,
    estimate_payload_bytes,
)

_backend = Path(__file__).resolve().parents[1]
load_dotenv(_backend / ".env")
load_dotenv(_backend.parent / ".env")


def _sql_literal(value: object) -> str:
    return json.dumps(value, ensure_ascii=False).replace("'", "''")


def build_sql(dossier_id: int, lines: list, bank: list) -> str:
    return f"""-- Jeu fictif (aucun fichier, aucun token IA)
-- dossier_id = {dossier_id}

insert into public.dossier_workspaces (dossier_id, lines, bank_transactions, bank_meta, updated_at)
values (
  {dossier_id},
  '{_sql_literal(lines)}'::jsonb,
  '{_sql_literal(bank)}'::jsonb,
  '{{"filename":"releve-test-fictif.csv","bankName":"TEST"}}'::jsonb,
  now()
)
on conflict (dossier_id) do update
set
  lines = excluded.lines,
  bank_transactions = excluded.bank_transactions,
  bank_meta = excluded.bank_meta,
  updated_at = now();
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed workspace fictif pour tester le portefeuille.")
    parser.add_argument("--dossier-id", type=int, required=True)
    parser.add_argument("--lines", type=int, default=400)
    parser.add_argument("--bank", type=int, default=120)
    parser.add_argument("--anomaly-every", type=int, default=10)
    parser.add_argument("--print-sql", action="store_true", help="Toujours imprimer le SQL, même si l'API réussit")
    args = parser.parse_args()

    lines = build_fake_invoice_lines(args.lines, anomaly_every=args.anomaly_every)
    bank = build_fake_bank_transactions(args.bank)
    anomalies = count_anomalies_from_stored_confidence(lines)
    payload_bytes = estimate_payload_bytes(lines, bank)

    print(f"Lignes fictives : {len(lines)}")
    print(f"Ops banque : {len(bank)}")
    print(f"Anomalies attendues : {anomalies}")
    print(f"Taille JSON complet : {payload_bytes:,} octets")
    print(f"Taille résumé : ~80 octets (line_count/bank_count/anomaly_count)")

    sql = build_sql(args.dossier_id, lines, bank)
    url = (os.getenv("SUPABASE_URL") or "").rstrip("/")
    key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()

    if not url or not key:
        print("\nPas de SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — collez ce SQL :")
        print(sql)
        return 0

    payload = {
        "dossier_id": args.dossier_id,
        "lines": lines,
        "bank_transactions": bank,
        "bank_meta": {"filename": "releve-test-fictif.csv", "bankName": "TEST"},
        "updated_at": "2026-08-17T00:00:00Z",
    }
    response = httpx.post(
        f"{url}/rest/v1/dossier_workspaces",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=representation",
        },
        params={"on_conflict": "dossier_id"},
        json=payload,
        timeout=60.0,
    )
    if args.print_sql:
        print(sql)
    if response.status_code >= 400:
        print(f"API {response.status_code}: {response.text[:500]}")
        print("\nCollez le SQL à la place :")
        print(sql)
        return 1

    row = response.json()
    if isinstance(row, list):
        row = row[0] if row else {}
    print(
        "Enregistré. Résumés : "
        f"line_count={row.get('line_count')} "
        f"bank_count={row.get('bank_count')} "
        f"anomaly_count={row.get('anomaly_count')}"
    )
    print("Ouvrez dossiers.html (Ctrl+Shift+R) — le portefeuille ne charge que ces 3 chiffres.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
