"""Onboarding et gestion multi-tenant Recompta."""

from __future__ import annotations

import os
import re
from typing import Any

import httpx
from pydantic import BaseModel, Field


class OnboardRequest(BaseModel):
    cabinet_name: str = Field(..., min_length=2, max_length=120)
    display_name: str = Field("", max_length=80)


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower().strip())
    return slug.strip("-")[:60] or "cabinet"


async def _supabase_admin() -> tuple[str, dict[str, str]]:
    url = os.getenv("SUPABASE_URL", "").rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis pour l'onboarding")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    return url, headers


async def create_cabinet_for_user(user_id: str, cabinet_name: str, display_name: str = "") -> dict[str, Any]:
    """Crée un cabinet + membership owner pour un nouvel utilisateur."""
    url, headers = await _supabase_admin()
    slug = _slugify(cabinet_name)

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Cabinet
        cab_resp = await client.post(
            f"{url}/rest/v1/recompta_cabinets",
            headers=headers,
            json={"name": cabinet_name, "slug": slug},
        )
        if cab_resp.status_code not in (200, 201):
            raise RuntimeError(f"Création cabinet échouée: {cab_resp.text}")
        cabinet = cab_resp.json()[0]

        # Owner membership
        mem_resp = await client.post(
            f"{url}/rest/v1/recompta_cabinet_members",
            headers=headers,
            json={
                "cabinet_id": cabinet["id"],
                "user_id": user_id,
                "role": "owner",
                "display_name": display_name or cabinet_name,
            },
        )
        if mem_resp.status_code not in (200, 201):
            raise RuntimeError(f"Création membre échouée: {mem_resp.text}")

    return cabinet


async def get_user_cabinet(user_id: str) -> dict[str, Any] | None:
    url, headers = await _supabase_admin()
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.get(
            f"{url}/rest/v1/recompta_cabinet_members",
            headers=headers,
            params={
                "user_id": f"eq.{user_id}",
                "is_active": "eq.true",
                "select": "role,display_name,cabinet:recompta_cabinets(id,name,slug,plan,trial_ends_at)",
                "limit": "1",
            },
        )
    if resp.status_code != 200 or not resp.json():
        return None
    row = resp.json()[0]
    return {"role": row["role"], "display_name": row.get("display_name"), **row["cabinet"]}
