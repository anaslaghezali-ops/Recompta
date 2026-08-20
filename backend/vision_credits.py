"""Compteur crédits vision IA (Freemium) — consommation via Supabase RPC."""

from __future__ import annotations

import contextvars
import logging
from typing import Any

import httpx

from supabase_service import service_headers, supabase_url

logger = logging.getLogger(__name__)

_active_cabinet_id: contextvars.ContextVar[int | None] = contextvars.ContextVar(
    "vision_credits_cabinet_id",
    default=None,
)


def set_active_cabinet_id(cabinet_id: int | None) -> contextvars.Token:
    return _active_cabinet_id.set(cabinet_id)


def reset_active_cabinet_id(token: contextvars.Token) -> None:
    _active_cabinet_id.reset(token)


def get_active_cabinet_id() -> int | None:
    return _active_cabinet_id.get()


async def _cabinet_id_via_rest(dossier_id: int, client: httpx.AsyncClient) -> int | None:
    response = await client.get(
        f"{supabase_url()}/rest/v1/client_dossiers",
        params={"id": f"eq.{dossier_id}", "select": "client_id", "limit": "1"},
        headers=service_headers(),
    )
    if response.status_code >= 400:
        logger.warning("client_dossiers lookup failed: %s", response.text[:200])
        return None
    rows = response.json()
    if not rows:
        return None
    client_id = rows[0].get("client_id")
    if client_id is None:
        return None

    response = await client.get(
        f"{supabase_url()}/rest/v1/cabinet_clients",
        params={"id": f"eq.{client_id}", "select": "cabinet_id", "limit": "1"},
        headers=service_headers(),
    )
    if response.status_code >= 400:
        logger.warning("cabinet_clients lookup failed: %s", response.text[:200])
        return None
    rows = response.json()
    if not rows:
        return None
    cabinet_id = rows[0].get("cabinet_id")
    return int(cabinet_id) if cabinet_id is not None else None


async def cabinet_id_for_dossier(dossier_id: int, client: httpx.AsyncClient | None = None) -> int | None:
    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=30.0)
    try:
        response = await client.post(
            f"{supabase_url()}/rest/v1/rpc/cabinet_id_for_dossier",
            headers=service_headers(),
            json={"p_dossier_id": dossier_id},
        )
        if response.status_code < 400:
            data = response.json()
            if data is not None:
                return int(data)
        else:
            logger.warning("cabinet_id_for_dossier RPC failed: %s", response.text[:200])

        return await _cabinet_id_via_rest(dossier_id, client)
    finally:
        if owns_client and client is not None:
            await client.aclose()


async def consume_vision_credit(
    cabinet_id: int | None,
    count: int = 1,
    client: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    if cabinet_id is None:
        return {"ok": False, "error": "Cabinet requis pour consommer un crédit vision"}

    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=30.0)
    try:
        response = await client.post(
            f"{supabase_url()}/rest/v1/rpc/consume_vision_credit",
            headers=service_headers(),
            json={"p_cabinet_id": cabinet_id, "p_count": count},
        )
        if response.status_code >= 400:
            logger.warning("consume_vision_credit HTTP %s: %s", response.status_code, response.text[:200])
            return {"ok": False, "error": "Impossible de vérifier le quota crédits"}
        return response.json()
    finally:
        if owns_client and client is not None:
            await client.aclose()


async def ensure_vision_credit_available(cabinet_id: int | None) -> tuple[bool, str]:
    """Consomme 1 crédit avant un appel OpenAI Vision. Retourne (ok, message)."""
    if cabinet_id is None:
        return False, "Quota crédits : cabinet non identifié — extraction IA bloquée."

    result = await consume_vision_credit(cabinet_id, 1)
    if result.get("ok"):
        return True, ""

    error = result.get("error") or "Quota crédits vision épuisé pour ce mois."
    remaining = result.get("remaining", 0)
    quota = result.get("quota", 0)
    return False, f"{error} ({remaining}/{quota} restants)."
