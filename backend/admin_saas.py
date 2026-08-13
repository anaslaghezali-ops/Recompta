from __future__ import annotations

import os
import re
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/admin", tags=["admin"])

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class CreateCabinetRequest(BaseModel):
    cabinet_name: str = Field(min_length=2)
    slug: str
    owner_email: str = Field(min_length=3)
    owner_password: str = Field(min_length=6)
    display_name: str = ""


def _supabase_url() -> str:
    url = (os.getenv("SUPABASE_URL") or "https://pbyoxfxngfutoiqjirkx.supabase.co").rstrip("/")
    return url


def _service_key() -> str:
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not key:
        raise HTTPException(
            status_code=503,
            detail="SUPABASE_SERVICE_ROLE_KEY manquante (backend local uniquement).",
        )
    return key


async def require_super_admin(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentification requise")
    token = authorization.removeprefix("Bearer ").strip()
    base = _supabase_url()
    anon = os.getenv("SUPABASE_ANON_KEY") or ""
    if not anon:
        raise HTTPException(status_code=503, detail="SUPABASE_ANON_KEY manquante")

    async with httpx.AsyncClient(timeout=30.0) as client:
        user_resp = await client.get(
            f"{base}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": anon},
        )
        if user_resp.status_code != 200:
            raise HTTPException(status_code=401, detail="Session invalide")
        user = user_resp.json()
        user_id = user.get("id")
        if not user_id:
            raise HTTPException(status_code=401, detail="Session invalide")

        role_resp = await client.get(
            f"{base}/rest/v1/user_roles",
            params={"user_id": f"eq.{user_id}", "select": "role"},
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": anon,
            },
        )
        roles = role_resp.json() if role_resp.status_code == 200 else []
        if not any(r.get("role") == "super_admin" for r in roles):
            raise HTTPException(status_code=403, detail="Accès réservé au super-admin")

    return user


@router.post("/cabinets")
async def create_cabinet(
    body: CreateCabinetRequest,
    _user: dict = Depends(require_super_admin),
) -> dict:
    slug = body.slug.strip().lower()
    if not _SLUG_RE.match(slug):
        raise HTTPException(status_code=400, detail="Slug invalide")

    base = _supabase_url()
    service = _service_key()
    headers = {
        "Authorization": f"Bearer {service}",
        "apikey": service,
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        create_resp = await client.post(
            f"{base}/auth/v1/admin/users",
            headers=headers,
            json={
                "email": str(body.owner_email).lower(),
                "password": body.owner_password,
                "email_confirm": True,
                "user_metadata": {"display_name": body.display_name} if body.display_name else {},
            },
        )
        if create_resp.status_code not in (200, 201):
            detail = create_resp.json().get("msg") or create_resp.text
            if create_resp.status_code == 422 and "already" in detail.lower():
                raise HTTPException(status_code=409, detail="Cet email est déjà utilisé")
            raise HTTPException(status_code=400, detail=detail)

        owner_id = create_resp.json().get("id")
        if not owner_id:
            raise HTTPException(status_code=500, detail="Utilisateur non créé")

        cab_resp = await client.post(
            f"{base}/rest/v1/cabinets",
            headers={**headers, "Prefer": "return=representation"},
            json={"name": body.cabinet_name.strip(), "slug": slug},
        )
        if cab_resp.status_code not in (200, 201):
            await client.delete(f"{base}/auth/v1/admin/users/{owner_id}", headers=headers)
            detail = cab_resp.json() if cab_resp.content else cab_resp.text
            if cab_resp.status_code == 409:
                raise HTTPException(status_code=409, detail="Ce slug existe déjà")
            raise HTTPException(status_code=400, detail=str(detail))

        cabinet = cab_resp.json()
        if isinstance(cabinet, list):
            cabinet = cabinet[0]

        mem_resp = await client.post(
            f"{base}/rest/v1/cabinet_members",
            headers=headers,
            json={"cabinet_id": cabinet["id"], "user_id": owner_id, "role": "owner"},
        )
        if mem_resp.status_code not in (200, 201, 204):
            await client.delete(f"{base}/rest/v1/cabinets?id=eq.{cabinet['id']}", headers=headers)
            await client.delete(f"{base}/auth/v1/admin/users/{owner_id}", headers=headers)
            raise HTTPException(status_code=400, detail=mem_resp.text)

        if body.display_name:
            await client.patch(
                f"{base}/rest/v1/profiles",
                params={"user_id": f"eq.{owner_id}"},
                headers=headers,
                json={"display_name": body.display_name.strip()},
            )

    return {
        "cabinet": cabinet,
        "owner": {"id": owner_id, "email": str(body.owner_email).lower(), "display_name": body.display_name or None},
    }
