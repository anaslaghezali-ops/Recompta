#!/usr/bin/env python3
"""Vérifie que le backend peut joindre Supabase (et optionnellement OpenAI)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

_backend = Path(__file__).resolve().parents[1]
load_dotenv(_backend / ".env")
load_dotenv(_backend.parent / ".env")


def main() -> int:
    url = (os.getenv("SUPABASE_URL") or "https://pbyoxfxngfutoiqjirkx.supabase.co").rstrip("/")
    service_key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    openai_key = (os.getenv("OPENAI_API_KEY") or "").strip()

    print(f"SUPABASE_URL = {url}")
    print(f"SUPABASE_SERVICE_ROLE_KEY = {'(définie)' if service_key else 'MANQUANTE'}")

    try:
        response = httpx.get(f"{url}/rest/v1/", timeout=15.0)
        print(f"Supabase reachable: HTTP {response.status_code} (401 attendu sans clé)")
    except httpx.ConnectError as exc:
        print(f"ERREUR Connexion Supabase impossible: {exc}")
        print("→ Vérifiez SUPABASE_URL (pas de localhost, pas de faute de frappe).")
        return 1

    if not service_key:
        print("WARN: sans SUPABASE_SERVICE_ROLE_KEY le worker d'import ne tourne pas.")
        return 1

    try:
        response = httpx.get(
            f"{url}/rest/v1/import_jobs",
            params={"select": "id", "limit": "1"},
            headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
            timeout=15.0,
        )
        print(f"Supabase API (service role): HTTP {response.status_code}")
        if response.status_code >= 400:
            print(response.text[:300])
            return 1
    except httpx.ConnectError as exc:
        print(f"ERREUR API Supabase: {exc}")
        return 1

    if openai_key:
        try:
            response = httpx.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {openai_key}"},
                timeout=15.0,
            )
            print(f"OpenAI reachable: HTTP {response.status_code}")
        except httpx.ConnectError as exc:
            print(f"WARN OpenAI injoignable: {exc}")
    else:
        print("OPENAI_API_KEY non définie (extraction IA désactivée).")

    print("OK — connectivité backend")
    return 0


if __name__ == "__main__":
    sys.exit(main())
