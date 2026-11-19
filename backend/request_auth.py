from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException, Request

from supabase_service import supabase_url


def _user_headers(access_token: str, api_key: str) -> dict[str, str]:
    # La clé publique identifie le projet ; le JWT utilisateur détermine le rôle
    # PostgreSQL et fait appliquer les politiques RLS de la requête.
    if not api_key.strip():
        raise HTTPException(status_code=401, detail="Clé publique Supabase manquante.")
    return {
        "apikey": api_key.strip(),
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
    }


async def authenticate_request(request: Request) -> dict[str, Any]:
    authorization = request.headers.get("authorization", "")
    scheme, _, access_token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not access_token.strip():
        raise HTTPException(status_code=401, detail="Connexion requise.")

    api_key = request.headers.get("apikey", "")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{supabase_url()}/auth/v1/user",
                headers=_user_headers(access_token.strip(), api_key),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Vérification de session indisponible.") from exc

    if response.status_code in {400, 401, 403}:
        raise HTTPException(status_code=401, detail="Session invalide ou expirée.")
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="Service d'authentification indisponible.")
    response.raise_for_status()
    user = response.json()
    if not user.get("id"):
        raise HTTPException(status_code=401, detail="Session invalide.")
    app_metadata = user.get("app_metadata") or {}
    return {
        "id": str(user["id"]),
        "access_token": access_token.strip(),
        # Posé uniquement par l'Edge Function client-portal (non modifiable par
        # l'utilisateur) : présent = compte d'un client du portail, pas du cabinet.
        "portal_client_id": app_metadata.get("portal_client_id"),
    }


def require_cabinet_user(user: dict[str, Any]) -> None:
    """Refuse les comptes du portail client sur les routes réservées au cabinet.

    Un client du portail peut lire son propre dossier (RLS client_dossiers), mais
    l'analyse IA consomme les crédits du cabinet et les imports relèvent du cabinet.
    """
    if user.get("portal_client_id"):
        raise HTTPException(status_code=403, detail="Action réservée au cabinet.")


async def require_dossier_access(dossier_id: int, access_token: str, api_key: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{supabase_url()}/rest/v1/client_dossiers",
                params={"id": f"eq.{int(dossier_id)}", "select": "id", "limit": "1"},
                headers=_user_headers(access_token, api_key),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Vérification des droits indisponible.") from exc

    if response.status_code in {400, 401, 403}:
        raise HTTPException(status_code=401, detail="Session invalide ou expirée.")
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="Vérification des droits indisponible.")
    response.raise_for_status()
    if not response.json():
        # Même réponse pour dossier inexistant et dossier non accessible.
        raise HTTPException(status_code=404, detail="Dossier introuvable ou accès refusé.")


async def require_import_job_access(job_id: int, access_token: str, api_key: str) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{supabase_url()}/rest/v1/import_jobs",
                params={
                    "id": f"eq.{int(job_id)}",
                    "select": "id,dossier_id,status",
                    "limit": "1",
                },
                headers=_user_headers(access_token, api_key),
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Vérification des droits indisponible.") from exc

    if response.status_code in {400, 401, 403}:
        raise HTTPException(status_code=401, detail="Session invalide ou expirée.")
    if response.status_code >= 500:
        raise HTTPException(status_code=503, detail="Vérification des droits indisponible.")
    response.raise_for_status()
    rows = response.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Import introuvable ou accès refusé.")
    return rows[0]
