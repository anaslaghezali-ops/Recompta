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


def _sanitize_env_secret(value: str) -> str:
    """Retire espaces et commentaires inline ; garde uniquement ASCII pour les en-têtes HTTP."""
    cleaned = (value or "").strip()
    if "#" in cleaned:
        cleaned = cleaned.split("#", 1)[0].strip()
    return "".join(ch for ch in cleaned if ord(ch) < 128)


def _warn_non_ascii_secret(name: str, value: str) -> None:
    bad = [(i, ch, hex(ord(ch))) for i, ch in enumerate(value) if ord(ch) >= 128]
    if not bad:
        return
    sample = ", ".join(f"pos {i} {repr(ch)} ({code})" for i, ch, code in bad[:3])
    print(f"ERREUR {name} contient des caractères non ASCII ({sample}).")
    print("→ Recopiez la clé depuis Supabase/OpenAI, une seule ligne, sans commentaire après.")


def main() -> int:
    url = (os.getenv("SUPABASE_URL") or "https://pbyoxfxngfutoiqjirkx.supabase.co").rstrip("/")
    service_key_raw = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    openai_key_raw = (os.getenv("OPENAI_API_KEY") or "").strip()
    _warn_non_ascii_secret("SUPABASE_SERVICE_ROLE_KEY", service_key_raw)
    _warn_non_ascii_secret("OPENAI_API_KEY", openai_key_raw)
    service_key = _sanitize_env_secret(service_key_raw)
    openai_key = _sanitize_env_secret(openai_key_raw)

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
    except UnicodeEncodeError as exc:
        print(f"ERREUR en-tête HTTP invalide (caractère spécial dans une clé): {exc}")
        print("→ Vérifiez SUPABASE_SERVICE_ROLE_KEY : uniquement eyJ... sans tiret long — ni commentaire.")
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
        except UnicodeEncodeError as exc:
            print(f"ERREUR OPENAI_API_KEY invalide (caractère spécial): {exc}")
            return 1
        except httpx.ConnectError as exc:
            print(f"WARN OpenAI injoignable: {exc}")
    else:
        print("OPENAI_API_KEY non définie (extraction IA désactivée).")

    print("OK — connectivité backend")
    return 0


if __name__ == "__main__":
    sys.exit(main())
