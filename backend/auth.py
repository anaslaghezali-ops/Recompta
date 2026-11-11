"""Authentification des routes API.

Le backend écrit dans Supabase avec la clé ``service_role``, qui contourne la
RLS. Chaque route doit donc vérifier elle-même *qui* appelle et *à quoi* il a
droit, sinon l'isolation entre cabinets ne tient que côté base.

Principe : le navigateur envoie le jeton de session Supabase
(``Authorization: Bearer …``). On le fait valider par Supabase Auth, puis on
interroge PostgREST **avec ce même jeton** : la RLS répond alors à la question
« cet utilisateur voit-il ce dossier ? » sans dupliquer les règles ici.
"""

from __future__ import annotations

import hashlib
import os
import time
from dataclasses import dataclass
from typing import Annotated, Any

import httpx
from fastapi import Depends, Header, HTTPException

# Un import de 200 factures = 200 requêtes : on ne revalide pas le jeton à chacune.
_CACHE_TTL_SECONDS = 60.0
_CACHE_MAX_ENTRIES = 500
_user_cache: dict[str, tuple[float, "AuthUser"]] = {}

# Remplacé par les tests (httpx.MockTransport) ; None = réseau réel.
_transport: httpx.AsyncBaseTransport | None = None


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str
    token: str
    is_super_admin: bool
    is_cabinet_member: bool

    @property
    def can_use_ai(self) -> bool:
        return self.is_super_admin or self.is_cabinet_member


def _supabase_url() -> str:
    return (os.getenv("SUPABASE_URL") or "https://pbyoxfxngfutoiqjirkx.supabase.co").rstrip("/")


def _api_key() -> str:
    """Clé ``apikey`` exigée par la passerelle Supabase.

    Les droits viennent du jeton utilisateur (en-tête Authorization), pas de
    cette clé : la clé service_role en secours ne contourne donc pas la RLS.
    """
    key = os.getenv("SUPABASE_ANON_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not key:
        raise HTTPException(
            status_code=503,
            detail=(
                "Authentification non configurée : ajoutez SUPABASE_ANON_KEY "
                "(ou SUPABASE_SERVICE_ROLE_KEY) dans backend/.env."
            ),
        )
    return key


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30.0, transport=_transport)


def _user_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}", "apikey": _api_key()}


def _cache_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def clear_auth_cache() -> None:
    _user_cache.clear()


def _cache_get(token: str) -> AuthUser | None:
    entry = _user_cache.get(_cache_key(token))
    if entry is None:
        return None
    expires_at, user = entry
    if expires_at < time.monotonic():
        _user_cache.pop(_cache_key(token), None)
        return None
    return user


def _cache_put(user: AuthUser) -> None:
    now = time.monotonic()
    if len(_user_cache) >= _CACHE_MAX_ENTRIES:
        for key in [k for k, (expires_at, _) in _user_cache.items() if expires_at < now]:
            _user_cache.pop(key, None)
        if len(_user_cache) >= _CACHE_MAX_ENTRIES:
            _user_cache.clear()
    _user_cache[_cache_key(user.token)] = (now + _CACHE_TTL_SECONDS, user)


async def _rest_rows(
    client: httpx.AsyncClient, token: str, table: str, params: dict[str, str]
) -> list[dict[str, Any]]:
    """Lecture PostgREST sous l'identité de l'utilisateur (RLS appliquée)."""
    try:
        response = await client.get(
            f"{_supabase_url()}/rest/v1/{table}",
            params=params,
            headers=_user_headers(token),
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Supabase injoignable.") from exc
    if response.status_code in (401, 403):
        raise HTTPException(status_code=401, detail="Session expirée — reconnectez-vous.")
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="Vérification des droits impossible.")
    rows = response.json()
    return rows if isinstance(rows, list) else []


async def _load_user(token: str) -> AuthUser:
    async with _client() as client:
        try:
            response = await client.get(
                f"{_supabase_url()}/auth/v1/user", headers=_user_headers(token)
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=503, detail="Supabase injoignable.") from exc
        if response.status_code >= 500:
            raise HTTPException(status_code=503, detail="Supabase injoignable.")
        if response.status_code != 200:
            raise HTTPException(status_code=401, detail="Session expirée — reconnectez-vous.")
        payload = response.json()
        user_id = str(payload.get("id") or "")
        if not user_id:
            raise HTTPException(status_code=401, detail="Session expirée — reconnectez-vous.")

        roles = await _rest_rows(
            client, token, "user_roles", {"user_id": f"eq.{user_id}", "select": "role"}
        )
        memberships = await _rest_rows(
            client,
            token,
            "cabinet_members",
            {
                "user_id": f"eq.{user_id}",
                "is_active": "eq.true",
                "select": "cabinet_id",
                "limit": "1",
            },
        )

    return AuthUser(
        id=user_id,
        email=str(payload.get("email") or ""),
        token=token,
        is_super_admin=any(row.get("role") == "super_admin" for row in roles),
        is_cabinet_member=bool(memberships),
    )


async def require_user(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthUser:
    """Utilisateur connecté (jeton de session Supabase valide)."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Connexion requise — connectez-vous à Recompta.")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Connexion requise — connectez-vous à Recompta.")

    cached = _cache_get(token)
    if cached is not None:
        return cached
    user = await _load_user(token)
    _cache_put(user)
    return user


async def require_cabinet_user(
    user: Annotated[AuthUser, Depends(require_user)],
) -> AuthUser:
    """Membre actif d'un cabinet (ou super-admin).

    Un simple compte ne suffit pas : ces routes consomment le crédit IA.
    """
    if not user.can_use_ai:
        raise HTTPException(status_code=403, detail="Compte non rattaché à un cabinet actif.")
    return user


async def ensure_dossier_access(user: AuthUser, dossier_id: int) -> None:
    """404 si le dossier n'existe pas *ou* n'est pas visible par l'utilisateur."""
    async with _client() as client:
        rows = await _rest_rows(
            client,
            user.token,
            "client_dossiers",
            {"id": f"eq.{int(dossier_id)}", "select": "id", "limit": "1"},
        )
    if not rows:
        raise HTTPException(status_code=404, detail="Dossier introuvable.")


async def ensure_job_access(user: AuthUser, job_id: int) -> None:
    """404 si le job n'existe pas *ou* appartient à un dossier inaccessible."""
    async with _client() as client:
        rows = await _rest_rows(
            client,
            user.token,
            "import_jobs",
            {"id": f"eq.{int(job_id)}", "select": "id", "limit": "1"},
        )
    if not rows:
        raise HTTPException(status_code=404, detail="Job introuvable.")
